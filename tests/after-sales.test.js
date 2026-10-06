import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AfterSalesService } from "../src/after-sales/service.js";
import { AdapterRegistry } from "../src/agent/adapters/registry.js";
import { MockPaymentAdapter } from "../src/agent/adapters/mock-payment.js";
import { AgentRunStore } from "../src/agent/run-store.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";
import { KnowledgeBase } from "../src/knowledge/knowledge-base.js";
import { openSqlitePersistence } from "../src/persistence/sqlite.js";

const operator = Object.freeze({ id: "refund-reviewer", role: "after_sales_operator" });

function openEnvironment(databasePath, { paymentRefundAdapter = null, merchantAfterSalesAdapter = null } = {}) {
  const persistence = openSqlitePersistence({ databasePath });
  const transactionService = new TransactionService({ repository: persistence.transactions });
  const runtime = new AgentRuntime({
    transactionService,
    store: new AgentRunStore({ repository: persistence.runs }),
    adapters: new AdapterRegistry({
      payment: new MockPaymentAdapter({ repository: persistence.paymentAuthorizations }),
    }),
    checkpointer: persistence.checkpointer,
    forceFallback: true,
  });
  const afterSales = new AfterSalesService({
    transactionService,
    repository: persistence.afterSales,
    knowledgeBase: new KnowledgeBase({ repository: persistence.knowledge }),
    paymentRefundAdapter,
    merchantAfterSalesAdapter,
  });
  return { afterSales, persistence, runtime };
}

async function completePurchase(runtime) {
  let run = await runtime.createRun({
    message: "帮我买这台 iPad，预算 HK$3,600，最多用 100 积分",
    context: {
      selectedProduct: {
        sku: "EDU-IPAD-A16-128-SLV",
        source: "product_page",
        userConfirmed: true,
      },
    },
  });
  run = await runtime.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "approve",
    planId: run.pendingAction.planId,
  });
  run = await runtime.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "authenticated",
    paymentSessionId: run.pendingAction.paymentSessionId,
  });
  return run;
}

test("after-sales refund requires confirmation, survives restart and reverses the sandbox order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-after-sales-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));

  let environment = openEnvironment(databasePath);
  const run = await completePurchase(environment.runtime);
  const reason = "请为这个沙箱订单申请退款，我下单后反悔了";
  const serviceCase = await environment.afterSales.createCaseFromMessage({
    runId: run.id,
    message: reason,
    idempotencyKey: "refund-request-1",
  });
  assert.equal(serviceCase.status, "USER_CONFIRMATION_REQUIRED");
  assert.equal(serviceCase.requestedAction, "cancel_order");
  assert.equal(serviceCase.knowledgeEvidence.some((item) => item.source === "campuscart://policy/after-sales"), true);
  assert.equal(serviceCase.auditChainValid, true);
  assert.equal(environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "cancel_order",
    reason,
    idempotencyKey: "refund-request-1",
  }).id, serviceCase.id);
  assert.throws(() => environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "cancel_order",
    reason: "A conflicting active case",
  }), (error) => error.code === "AFTER_SALES_CASE_ALREADY_OPEN");
  const pendingAction = serviceCase.pendingAction;
  environment.persistence.close();

  environment = openEnvironment(databasePath);
  const restored = environment.afterSales.requireCase(serviceCase.id);
  assert.equal(restored.pendingAction.actionId, pendingAction.actionId);
  const refunded = await environment.afterSales.resume(serviceCase.id, {
    actionId: pendingAction.actionId,
    decision: "approve",
  });
  assert.equal(refunded.status, "REFUNDED");
  assert.equal(refunded.auditChainValid, true);
  assert.equal(refunded.outcome.refund.amountCents > 0, true);
  assert.equal(refunded.outcome.refund.providerReceipt.providerId, "campuscart-sandbox-refunds");
  assert.equal(refunded.outcome.refund.providerReceipt.status, "succeeded");

  const transaction = environment.runtime.getTransaction(run.id);
  assert.equal(transaction.state, "REFUNDED");
  assert.equal(transaction.payment.status, "refunded_sandbox");
  assert.equal(transaction.order.status, "cancelled_refunded");
  assert.equal(transaction.auditChainValid, true);
  assert.equal(transaction.afterSales[0].caseId, serviceCase.id);
  await assert.rejects(environment.afterSales.resume(serviceCase.id, {
    actionId: pendingAction.actionId,
    decision: "approve",
  }), (error) => error.code === "AFTER_SALES_ACTION_NOT_CURRENT");
  environment.persistence.close();
});

test("refund adapter failure preserves the paid transaction and an operator can safely retry it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-refund-adapter-failure-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const paymentRefundAdapter = {
    capabilities: () => ({ providerId: "failing-refund-provider", mode: "test", supports: ["refund"] }),
    async refund(input) {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("Provider timeout before a confirmed refund"), { code: "REFUND_PROVIDER_TIMEOUT" });
      }
      return {
        providerId: "flaky-refund-provider",
        providerRefundId: `refund-retry-${input.caseId}`,
        paymentId: input.paymentId,
        status: "succeeded",
        amountCents: input.amountCents,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        processedAt: new Date().toISOString(),
        disclaimer: "Test receipt",
      };
    },
  };
  const environment = openEnvironment(databasePath, { paymentRefundAdapter });
  const run = await completePurchase(environment.runtime);
  const before = environment.runtime.getTransaction(run.id);
  const serviceCase = environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "refund",
    reason: "Test a failed provider boundary",
    idempotencyKey: "refund-provider-failure-1",
  });

  const result = await environment.afterSales.resume(serviceCase.id, {
    actionId: serviceCase.pendingAction.actionId,
    decision: "approve",
  });
  const after = environment.runtime.getTransaction(run.id);

  assert.equal(calls, 1);
  assert.equal(result.status, "MANUAL_REVIEW");
  assert.equal(result.outcome.reason.code, "REFUND_PROVIDER_TIMEOUT");
  assert.equal(result.audit.some((event) => event.type === "after_sales_provider_failed"), true);
  assert.equal(result.auditChainValid, true);
  assert.equal(after.state, "COMPLETED");
  assert.equal(after.payment.status, before.payment.status);
  assert.equal(after.order.status, before.order.status);
  assert.deepEqual(after.afterSales ?? [], before.afterSales ?? []);
  assert.equal(JSON.stringify(environment.runtime.capabilities()).includes("failing-refund-provider"), false);

  const retryInput = { note: "Provider reports no prior refund; retry approved", idempotencyKey: "retry-refund-provider-1" };
  const retried = await environment.afterSales.retryRefund(serviceCase.id, retryInput, operator);
  const replayed = await environment.afterSales.retryRefund(serviceCase.id, retryInput, operator);
  const refundedTransaction = environment.runtime.getTransaction(run.id);
  assert.equal(calls, 2);
  assert.equal(retried.status, "REFUNDED");
  assert.equal(replayed.status, "REFUNDED");
  assert.equal(retried.outcome.refund.providerReceipt.providerId, "flaky-refund-provider");
  assert.equal(refundedTransaction.state, "REFUNDED");
  assert.equal(refundedTransaction.afterSales.length, 1);
  environment.persistence.close();
});
