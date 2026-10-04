import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdapterRegistry } from "../src/agent/adapters/registry.js";
import { MockPaymentAdapter } from "../src/agent/adapters/mock-payment.js";
import { ExperienceMemory } from "../src/agent/experience-memory.js";
import { AgentRunStore } from "../src/agent/run-store.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";
import { KnowledgeBase } from "../src/knowledge/knowledge-base.js";
import { openSqlitePersistence } from "../src/persistence/sqlite.js";

function openRuntime(databasePath) {
  const persistence = openSqlitePersistence({ databasePath });
  const transactionService = new TransactionService({ repository: persistence.transactions });
  const store = new AgentRunStore({ repository: persistence.runs });
  const adapters = new AdapterRegistry({
    payment: new MockPaymentAdapter({ repository: persistence.paymentAuthorizations }),
  });
  const knowledgeBase = new KnowledgeBase({ repository: persistence.knowledge });
  const experienceMemory = new ExperienceMemory({ repository: persistence.memories });
  const runtime = new AgentRuntime({
    transactionService,
    store,
    adapters,
    checkpointer: persistence.checkpointer,
    knowledgeBase,
    experienceMemory,
    forceFallback: true,
  });
  return { experienceMemory, knowledgeBase, persistence, runtime };
}

test("a pending Agent purchase survives restarts before both human approvals", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-persistence-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));

  let environment = openRuntime(databasePath);
  const created = await environment.runtime.createRun({
    message: "帮我买这台 iPad，预算 HK$3,600，最多用 100 积分",
    context: {
      selectedProduct: {
        sku: "EDU-IPAD-A16-128-SLV",
        source: "product_page",
        userConfirmed: true,
      },
    },
  });
  assert.equal(created.status, "needs_user_action");
  assert.equal(created.pendingAction.type, "purchase_authorization");
  const runId = created.id;
  const firstAction = created.pendingAction;
  environment.persistence.close();

  environment = openRuntime(databasePath);
  const restoredBeforeAuthorization = environment.runtime.getRun(runId);
  assert.equal(restoredBeforeAuthorization.pendingAction.actionId, firstAction.actionId);
  const authorized = await environment.runtime.resume(runId, {
    actionId: firstAction.actionId,
    decision: "approve",
    planId: firstAction.planId,
  });
  assert.equal(authorized.pendingAction.type, "payment_authentication");
  const paymentAction = authorized.pendingAction;
  environment.persistence.close();

  environment = openRuntime(databasePath);
  const restoredBeforePayment = environment.runtime.getRun(runId);
  assert.equal(restoredBeforePayment.pendingAction.paymentSessionId, paymentAction.paymentSessionId);
  const completed = await environment.runtime.resume(runId, {
    actionId: paymentAction.actionId,
    decision: "authenticated",
    paymentSessionId: paymentAction.paymentSessionId,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.type, "success");
  const transaction = environment.runtime.getTransaction(runId);
  assert.equal(transaction.state, "COMPLETED");
  assert.equal(transaction.auditChainValid, true);
  assert.equal(transaction.paymentAdapterCallCount, 1);
  assert.equal(environment.persistence.memories.find({ limit: 10 }).length, 1);
  environment.persistence.close();

  environment = openRuntime(databasePath);
  assert.equal(environment.runtime.getRun(runId).status, "completed");
  assert.equal(environment.runtime.getTransaction(runId).order.status, "accepted_sandbox");
  const knowledge = await environment.knowledgeBase.retrieve("为什么需要两次人工确认", { limit: 2 });
  assert.equal(knowledge.some((result) => result.source === "campuscart://policy/purchase-authorization"), true);
  const nextRun = await environment.runtime.createRun({
    message: "帮我再比较一次这台 iPad，预算 HK$3,600",
    context: {
      selectedProduct: {
        sku: "EDU-IPAD-A16-128-SLV",
        source: "product_page",
        userConfirmed: true,
      },
    },
  });
  assert.equal(nextRun.trace.some((event) => event.type === "experience_memory_retrieved"), true);
  const feedback = environment.runtime.feedback(runId, {
    rating: "unhelpful",
    note: "Do not reuse this lesson for later runs",
  });
  assert.equal(feedback.memory.quality.status, "rejected");
  assert.equal(feedback.memory.usage.retrievalCount, 1);
  const afterRejection = await environment.runtime.createRun({
    message: "再次比较这台 iPad，预算 HK$3,600",
    context: {
      selectedProduct: {
        sku: "EDU-IPAD-A16-128-SLV",
        source: "product_page",
        userConfirmed: true,
      },
    },
  });
  assert.equal(afterRejection.trace.some((event) => event.type === "experience_memory_retrieved"), false);
  environment.persistence.close();
});
