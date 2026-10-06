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
import { handleOperatorApi } from "../src/operator/api.js";
import { createOperatorAuthenticator } from "../src/operator/auth.js";
import { openSqlitePersistence } from "../src/persistence/sqlite.js";

const operator = Object.freeze({ id: "reviewer-7", role: "after_sales_operator" });

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
  return {
    afterSales: new AfterSalesService({
      transactionService,
      repository: persistence.afterSales,
      paymentRefundAdapter,
      merchantAfterSalesAdapter,
    }),
    persistence,
    runtime,
  };
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
  return runtime.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "authenticated",
    paymentSessionId: run.pendingAction.paymentSessionId,
  });
}

test("operator authentication is closed when unconfigured and verifies Bearer tokens", () => {
  const unconfigured = createOperatorAuthenticator({ apiKey: "" });
  assert.throws(() => unconfigured.authenticate({ headers: {} }), (error) => (
    error.statusCode === 503 && error.code === "OPERATOR_AUTH_NOT_CONFIGURED"
  ));

  const authenticator = createOperatorAuthenticator({
    apiKey: "test-operator-key-that-is-long-enough",
    operatorId: operator.id,
  });
  assert.throws(() => authenticator.authenticate({
    headers: { authorization: "Bearer incorrect-key" },
  }), (error) => error.statusCode === 401 && error.code === "OPERATOR_UNAUTHORIZED");
  assert.deepEqual(authenticator.authenticate({
    headers: { authorization: "Bearer test-operator-key-that-is-long-enough" },
  }), operator);
});

test("operator API authenticates before listing or mutating cases", async () => {
  const requestFor = (authorization) => ({ method: "GET", headers: authorization ? { authorization } : {} });
  const url = new URL("http://localhost/api/v1/operator/after-sales/cases?status=MANUAL_REVIEW");
  const response = {};
  const sendJson = (target, statusCode, body) => Object.assign(target, { statusCode, body });
  const service = {
    list(filters) {
      assert.deepEqual(filters, { runId: null, orderId: null, status: "MANUAL_REVIEW" });
      return [{ id: "case-1", status: "MANUAL_REVIEW" }];
    },
  };
  const unconfigured = createOperatorAuthenticator({ apiKey: "" });
  await assert.rejects(handleOperatorApi({
    request: requestFor(null),
    response,
    url,
    service,
    authenticator: unconfigured,
    sendJson,
    bodyOf: async () => ({}),
  }), (error) => error.code === "OPERATOR_AUTH_NOT_CONFIGURED");

  const authenticator = createOperatorAuthenticator({
    apiKey: "test-operator-key-that-is-long-enough",
    operatorId: operator.id,
  });
  await assert.rejects(handleOperatorApi({
    request: requestFor("Bearer wrong"),
    response,
    url,
    service,
    authenticator,
    sendJson,
    bodyOf: async () => ({}),
  }), (error) => error.code === "OPERATOR_UNAUTHORIZED");
  assert.equal(await handleOperatorApi({
    request: requestFor("Bearer test-operator-key-that-is-long-enough"),
    response,
    url,
    service,
    authenticator,
    sendJson,
    bodyOf: async () => ({}),
  }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.operator, operator);
  assert.equal(response.body.cases[0].status, "MANUAL_REVIEW");
});

test("operator API exposes authenticated refund reconciliation with validated idempotency", async () => {
  const response = {};
  const authenticator = createOperatorAuthenticator({
    apiKey: "test-operator-key-that-is-long-enough",
    operatorId: operator.id,
  });
  let received = null;
  const service = {
    async retryRefund(caseId, input, principal) {
      received = { caseId, input, principal };
      return { id: caseId, status: "REFUNDED" };
    },
  };
  const handled = await handleOperatorApi({
    request: { method: "POST", headers: { authorization: "Bearer test-operator-key-that-is-long-enough" } },
    response,
    url: new URL("http://localhost/api/v1/operator/after-sales/cases/case-7/retry-refund"),
    service,
    authenticator,
    sendJson: (target, statusCode, body) => Object.assign(target, { statusCode, body }),
    bodyOf: async () => ({ note: "Provider reconciliation complete", idempotencyKey: "retry-refund-7" }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "REFUNDED");
  assert.deepEqual(received, {
    caseId: "case-7",
    input: { note: "Provider reconciliation complete", idempotencyKey: "retry-refund-7" },
    principal: operator,
  });
});

test("approved return survives restart, refunds once, and rejects concurrent state changes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-operator-return-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));

  let environment = openEnvironment(databasePath);
  const run = await completePurchase(environment.runtime);
  const serviceCase = environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "return",
    reason: "The item needs a sandbox inspection",
    idempotencyKey: "customer-return-001",
  });
  assert.equal(serviceCase.status, "MANUAL_REVIEW");
  await assert.rejects(environment.afterSales.review(serviceCase.id, {
    decision: "approve",
    idempotencyKey: "review-return-forbidden",
  }, { id: "shopper-1", role: "shopper" }), (error) => error.code === "OPERATOR_PRINCIPAL_REQUIRED");

  const authorized = await environment.afterSales.review(serviceCase.id, {
    decision: "approve",
    note: "Return accepted for sandbox inspection",
    idempotencyKey: "review-return-001",
  }, operator);
  assert.equal(authorized.status, "RETURN_AUTHORIZED");
  assert.equal(authorized.returnAuthorization.status, "awaiting_return");
  assert.equal(authorized.returnAuthorization.providerReceipt.providerId, "campuscart-sandbox-merchant");
  assert.equal(authorized.auditChainValid, true);
  assert.equal((await environment.afterSales.review(serviceCase.id, {
    decision: "approve",
    note: "Return accepted for sandbox inspection",
    idempotencyKey: "review-return-001",
  }, operator)).status, "RETURN_AUTHORIZED");
  await assert.rejects(environment.afterSales.review(serviceCase.id, {
    decision: "reject",
    note: "Conflicting replay",
    idempotencyKey: "review-return-001",
  }, operator), (error) => error.code === "IDEMPOTENCY_KEY_REUSED");
  environment.persistence.close();

  environment = openEnvironment(databasePath);
  assert.equal(environment.afterSales.requireCase(serviceCase.id).status, "RETURN_AUTHORIZED");
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => environment.afterSales.receiveReturn(serviceCase.id, {
      note: "Package received in sandbox",
      idempotencyKey: "receive-return-001",
    }, operator)),
    Promise.resolve().then(() => environment.afterSales.receiveReturn(serviceCase.id, {
      note: "A competing receipt",
      idempotencyKey: "receive-return-002",
    }, operator)),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const refunded = attempts.find((attempt) => attempt.status === "fulfilled").value;
  assert.equal(refunded.status, "REFUNDED");
  assert.equal(refunded.outcome.refund.status, "refunded_sandbox");
  assert.equal(refunded.returnAuthorization.receipt.operation, "record_return_received");
  assert.equal(refunded.outcome.refund.providerReceipt.status, "succeeded");
  assert.equal(refunded.auditChainValid, true);
  assert.equal((await environment.afterSales.receiveReturn(serviceCase.id, {
    note: "Package received in sandbox",
    idempotencyKey: "receive-return-001",
  }, operator)).status, "REFUNDED");

  const transaction = environment.runtime.getTransaction(run.id);
  assert.equal(transaction.state, "REFUNDED");
  assert.equal(transaction.afterSales.filter((entry) => entry.caseId === serviceCase.id).length, 1);
  assert.equal(transaction.auditChainValid, true);
  environment.persistence.close();
});

test("approved exchange records one replacement order without issuing a refund", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-operator-exchange-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));

  const environment = openEnvironment(databasePath);
  const run = await completePurchase(environment.runtime);
  const serviceCase = environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "exchange",
    reason: "Exchange for an inspected replacement",
    idempotencyKey: "customer-exchange-001",
  });
  const authorized = await environment.afterSales.review(serviceCase.id, {
    decision: "approve",
    idempotencyKey: "review-exchange-001",
  }, operator);
  assert.equal(authorized.status, "EXCHANGE_AUTHORIZED");

  const completed = await environment.afterSales.completeExchange(serviceCase.id, {
    replacementOrderId: "replacement-sandbox-001",
    note: "Replacement created",
    idempotencyKey: "complete-exchange-001",
  }, operator);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.outcome.exchange.replacementOrderId, "replacement-sandbox-001");
  assert.equal(completed.outcome.exchange.merchantReceipt.providerId, "campuscart-sandbox-merchant");
  assert.equal(completed.auditChainValid, true);
  assert.equal((await environment.afterSales.completeExchange(serviceCase.id, {
    replacementOrderId: "replacement-sandbox-001",
    note: "Replacement created",
    idempotencyKey: "complete-exchange-001",
  }, operator)).status, "COMPLETED");

  const transaction = environment.runtime.getTransaction(run.id);
  assert.equal(transaction.state, "COMPLETED");
  assert.notEqual(transaction.payment.status, "refunded_sandbox");
  assert.equal(transaction.order.status, "exchanged_sandbox");
  assert.equal(transaction.order.replacementOrderId, "replacement-sandbox-001");
  assert.equal(transaction.afterSales.filter((entry) => entry.type === "exchange").length, 1);
  assert.equal(transaction.auditChainValid, true);
  assert.throws(() => environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "refund",
    reason: "A second terminal service request",
    idempotencyKey: "customer-refund-after-exchange",
  }), (error) => error.code === "ORDER_NOT_SERVICEABLE");
  environment.persistence.close();
});

test("injected provider adapters are called once and their receipts survive idempotent replays", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-provider-adapters-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const calls = { authorizeReturn: 0, receiveReturn: 0, refund: 0 };
  const merchantAfterSalesAdapter = {
    capabilities: () => ({ providerId: "merchant-test-double", mode: "test", supports: ["return"] }),
    async authorizeReturn({ orderId, caseId, idempotencyKey }) {
      calls.authorizeReturn += 1;
      return {
        providerId: "merchant-test-double",
        operation: "authorize_return",
        status: "succeeded",
        orderId,
        caseId,
        authorizationId: `auth-${caseId}`,
        idempotencyKey,
        processedAt: new Date().toISOString(),
        disclaimer: "Test receipt",
      };
    },
    async recordReturnReceived({ orderId, caseId, authorizationId, idempotencyKey }) {
      calls.receiveReturn += 1;
      return {
        providerId: "merchant-test-double",
        operation: "record_return_received",
        status: "succeeded",
        orderId,
        caseId,
        authorizationId,
        receiptId: `received-${caseId}`,
        idempotencyKey,
        processedAt: new Date().toISOString(),
        disclaimer: "Test receipt",
      };
    },
  };
  const paymentRefundAdapter = {
    capabilities: () => ({ providerId: "refund-test-double", mode: "test", supports: ["refund"] }),
    async refund({ paymentId, amountCents, currency, idempotencyKey }) {
      calls.refund += 1;
      return {
        providerId: "refund-test-double",
        providerRefundId: `provider-${idempotencyKey}`,
        paymentId,
        status: "succeeded",
        amountCents,
        currency,
        idempotencyKey,
        processedAt: new Date().toISOString(),
        disclaimer: "Test receipt",
      };
    },
  };
  const environment = openEnvironment(databasePath, { paymentRefundAdapter, merchantAfterSalesAdapter });
  const run = await completePurchase(environment.runtime);
  const serviceCase = environment.afterSales.createCase({
    runId: run.id,
    requestedAction: "return",
    reason: "Verify provider evidence and replay protection",
    idempotencyKey: "provider-adapter-return-1",
  });
  const reviewInput = { decision: "approve", idempotencyKey: "provider-review-1" };
  await environment.afterSales.review(serviceCase.id, reviewInput, operator);
  await environment.afterSales.review(serviceCase.id, reviewInput, operator);
  const receiptInput = { idempotencyKey: "provider-receive-1" };
  const result = await environment.afterSales.receiveReturn(serviceCase.id, receiptInput, operator);
  await environment.afterSales.receiveReturn(serviceCase.id, receiptInput, operator);

  assert.deepEqual(calls, { authorizeReturn: 1, receiveReturn: 1, refund: 1 });
  assert.equal(result.status, "REFUNDED");
  assert.equal(result.returnAuthorization.providerReceipt.providerId, "merchant-test-double");
  assert.equal(result.returnAuthorization.receipt.providerId, "merchant-test-double");
  assert.equal(result.outcome.refund.providerReceipt.providerId, "refund-test-double");
  const transaction = environment.runtime.getTransaction(run.id);
  assert.equal(transaction.afterSales[0].providerReceipt.providerRefundId, `provider-refund-${serviceCase.id}`);
  assert.equal(transaction.audit.some((event) => event.payload?.providerId === "refund-test-double"), true);
  environment.persistence.close();
});
