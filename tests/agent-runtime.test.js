import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgentRuntime } from "../src/agent/runtime.js";
import { AdapterRegistry } from "../src/agent/adapters/registry.js";
import { TransactionService } from "../src/domain/transaction-service.js";
import { parseFallbackIntent } from "../src/agent/tools.js";

const selectedProduct = {
  sku: "EDU-IPAD-A16-128-SLV",
  source: "product_page",
  userConfirmed: true,
};

function runtime({ identity, forceFallback = true } = {}) {
  const transactionService = new TransactionService();
  const adapters = identity ? new AdapterRegistry({ identity }) : undefined;
  const agent = new AgentRuntime({
    transactionService,
    adapters,
    forceFallback,
  });
  return { agent, transactionService };
}

test("natural-language request runs through LangGraph tools and two human approvals", async () => {
  const { agent } = runtime();
  let run = await agent.createRun({
    message: "帮我买这台 iPad，预算 HK$3,600，最多用 100 积分",
    context: { demoScenario: "success" },
  });

  assert.equal(run.agentMode, "langgraph_deterministic_fallback");
  assert.equal(run.status, "needs_user_action");
  assert.equal(run.pendingAction.type, "purchase_authorization");
  assert.equal(run.proposal.plan.cashOutCents, 339900);

  const firstActionId = run.pendingAction.actionId;
  run = await agent.resume(run.id, { actionId: firstActionId, decision: "approve" });
  assert.equal(run.status, "needs_user_action");
  assert.equal(run.pendingAction.type, "payment_authentication");
  assert.match(run.pendingAction.url, /^\/sandbox\/payment-auth\//);

  run = await agent.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "authenticated",
    paymentSessionId: run.pendingAction.paymentSessionId,
  });
  assert.equal(run.status, "completed");
  assert.equal(run.outcome.type, "success");
  assert.equal(run.outcome.paymentSubmitted, true);

  const trace = agent.getTrace(run.id).events;
  const completedTools = trace
    .filter((event) => event.type === "tool_call_completed")
    .map((event) => event.data.tool);
  assert.deepEqual(completedTools.slice(0, 5), [
    "search_supported_products",
    "fetch_merchant_quotes",
    "inspect_student_eligibility",
    "evaluate_checkout_options",
    "list_payment_methods",
  ]);
  assert.ok(completedTools.includes("create_payment_authorization_session"));
  assert.ok(completedTools.includes("confirm_payment_authorization"));
  assert.equal(trace.every((event, index) => index === 0 || event.previousHash === trace[index - 1].hash), true);
});

test("blocked run stops before any payment authorization tool is called", async () => {
  const { agent } = runtime();
  let run = await agent.createRun({
    message: "购买这台学习设备，预算上限 3500 港币，最多 100 积分",
    context: { demoScenario: "blocked", selectedProduct },
  });

  run = await agent.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "approve",
  });

  assert.equal(run.status, "blocked");
  assert.equal(run.outcome.type, "blocked");
  assert.equal(run.outcome.reason.code, "MAX_TOTAL_EXCEEDED");
  assert.equal(run.outcome.paymentSubmitted, false);

  const trace = agent.getTrace(run.id).events;
  assert.equal(
    trace.some((event) => event.data.tool === "create_payment_authorization_session"),
    false,
  );

  const answer = await agent.message(run.id, { message: "为什么我的购买被阻止？" });
  assert.match(answer.message.content, /MAX_TOTAL_EXCEEDED/);
  assert.match(answer.message.content, /HK\$3,559/);
});

test("one-time action ids reject stale or replayed approvals", async () => {
  const { agent } = runtime();
  const run = await agent.createRun({
    message: "预算 HK$3,600，帮我购买这个商品",
    context: { selectedProduct },
  });
  const authorizationAction = run.pendingAction.actionId;
  await agent.resume(run.id, { actionId: authorizationAction, decision: "approve" });

  await assert.rejects(
    agent.resume(run.id, { actionId: authorizationAction, decision: "approve" }),
    (error) => error.statusCode === 409,
  );
});

test("payment method cannot be silently changed while resuming a locked action", async () => {
  const { agent } = runtime();
  const run = await agent.createRun({
    message: "买这台，预算 HK$3,600",
    context: { selectedProduct },
  });
  await assert.rejects(
    agent.resume(run.id, {
      actionId: run.pendingAction.actionId,
      decision: "approve",
      selectedPaymentMethodId: "wechat-pay",
    }),
    (error) => error.name === "ZodError",
  );
});

test("future payment connectors are discoverable but not executable", async () => {
  const { agent } = runtime();
  const methods = await agent.adapters.payment.listAvailableMethods({
    merchantId: "campus-demo-store",
    amountCents: 339900,
  });
  const wechat = methods.find((method) => method.methodId === "wechat-pay");
  assert.equal(wechat.integrationStatus, "future_integration");

  await assert.rejects(
    agent.adapters.payment.createAuthorizationSession({
      runId: "demo",
      transactionSessionId: "demo",
      paymentMethodId: "wechat-pay",
      amountCents: 339900,
    }),
    (error) => error.code === "PAYMENT_ADAPTER_UNAVAILABLE",
  );
});

test("unsupported natural-language product is rejected instead of becoming the demo iPad", async () => {
  const { agent, transactionService } = runtime();
  await assert.rejects(
    agent.createRun({ message: "帮我买一串香蕉，预算 HK$100" }),
    (error) => error.statusCode === 422 && error.code === "UNSUPPORTED_PRODUCT",
  );
  assert.equal(transactionService.sessions.size, 0);
});

test("accessories and negated products never match the demo iPad", async () => {
  const { agent, transactionService } = runtime();
  for (const message of [
    "帮我买 iPad 保护壳，预算 HK$500",
    "不要买 iPad，买香蕉，预算 HK$100",
  ]) {
    await assert.rejects(
      agent.createRun({ message, context: { selectedProduct } }),
      (error) => error.code === "UNSUPPORTED_PRODUCT",
    );
  }
  assert.equal(transactionService.sessions.size, 0);
});

test("deictic product without selectedProduct context needs clarification", async () => {
  const { agent } = runtime();
  const run = await agent.createRun({ message: "买这个，预算 HK$3,600" });
  assert.equal(run.status, "needs_clarification");
  assert.equal(run.outcome.reason.code, "PRODUCT_CONTEXT_REQUIRED");
  assert.equal(run.pendingAction, null);
});

test("budget parser has no default and preserves source-to-cent evidence", async () => {
  assert.equal(parseFallbackIntent("预算 HK$99").constraints.budgetCents, 9900);
  assert.equal(parseFallbackIntent("预算 HK$99.5").constraints.budgetCents, 9950);
  const parsed = parseFallbackIntent("预算 HK$3,600.50");
  assert.equal(parsed.constraints.budgetCents, 360050);
  assert.equal(parsed.evidence.budget.original, "预算 HK$3,600.50");

  const missing = parseFallbackIntent("帮我买 iPad");
  assert.equal(missing.constraints.budgetCents, null);
  assert.deepEqual(missing.missingFields, ["constraints.budgetCents"]);
  const invalid = parseFallbackIntent("帮我买 iPad，预算 HK$99.999");
  assert.equal(invalid.evidence.budget.status, "invalid");
  assert.equal(invalid.constraints.budgetCents, null);
});

test("missing or invalid budget is comparison-only and cannot create an authorization action", async () => {
  const { agent } = runtime();
  for (const message of ["帮我买 iPad", "帮我买 iPad，预算 HK$99.999"]) {
    const run = await agent.createRun({ message });
    assert.equal(run.status, "needs_clarification");
    assert.equal(run.pendingAction, null);
    assert.ok(run.proposal.plan);
    assert.equal(run.proposal.comparisonOnly, true);
    assert.equal(agent.getTransaction(run.id).state, "NEEDS_CLARIFICATION");
  }
});

test("hard payment constraint blocks while a soft unavailable preference does not", async () => {
  const { agent } = runtime();
  const hard = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600，只能用微信支付" });
  assert.equal(hard.status, "blocked");
  assert.equal(hard.proposal.intent.constraints.allowedPaymentMethodIds[0], "wechat-pay");

  const soft = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600，最好用微信支付" });
  assert.equal(soft.status, "needs_user_action");
  assert.equal(soft.proposal.intent.constraints.allowedPaymentMethodIds, null);
  assert.deepEqual(soft.proposal.intent.preferences.preferredPaymentMethodIds, ["wechat-pay"]);
});

test("explicit product-page context only resolves deictic requests", async () => {
  const { agent } = runtime();
  const run = await agent.createRun({
    message: "帮我买这个商品，预算 HK$3,600",
    context: { selectedProduct },
  });
  assert.equal(run.proposal.plan.sku, selectedProduct.sku);

  await assert.rejects(
    agent.createRun({
      message: "帮我买一串香蕉，预算 HK$100",
      context: { selectedProduct },
    }),
    (error) => error.code === "UNSUPPORTED_PRODUCT",
  );
});

test("natural-language product and selectedProduct context must agree", async () => {
  const { agent } = runtime();
  await assert.rejects(
    agent.createRun({
      message: "帮我买 iPad，预算 HK$3,600",
      context: {
        selectedProduct: { ...selectedProduct, sku: "SOME-OTHER-SKU" },
      },
    }),
    (error) => error.code === "PRODUCT_CONTEXT_MISMATCH",
  );
});

test("identity adapter status is authoritative for deterministic offer eligibility", async () => {
  const identity = {
    id: "invalid-student-test",
    async getStatus() {
      return {
        providerId: this.id,
        studentStatus: "invalid",
        credentialStatus: "expired",
        source: "test",
      };
    },
  };
  const { agent } = runtime({ identity });
  const run = await agent.createRun({
    message: "帮我买 iPad，预算 HK$3,600",
  });
  assert.equal(run.proposal.identity.studentStatus, "invalid");
  assert.equal(run.proposal.plan.appliedOffers.some((offer) => offer.id.startsWith("EDU-") || offer.id.startsWith("HT-STUDENT")), false);
  const transaction = agent.getTransaction(run.id);
  assert.equal(transaction.user.studentStatus, "invalid");
  assert.equal(transaction.user.credentialStatus, "expired");
});

test("a budget with no compliant plan blocks before purchase authorization", async () => {
  const { agent } = runtime();
  const run = await agent.createRun({ message: "帮我买 iPad，预算 HK$100" });
  assert.equal(run.status, "blocked");
  assert.equal(run.pendingAction, null);
  assert.equal(run.proposal.plan, null);
  assert.equal(run.outcome.reason.code, "NO_EXECUTABLE_PLAN");
  assert.equal(agent.getTransaction(run.id).state, "BLOCKED");
});

test("payment authentication failure closes the lock and cannot be completed directly", async () => {
  const { agent, transactionService } = runtime();
  let run = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600" });
  run = await agent.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" });
  const transactionId = run.transactionSessionId;
  run = await agent.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "failed",
    paymentSessionId: run.pendingAction.paymentSessionId,
  });
  const transaction = agent.getTransaction(run.id);
  assert.equal(run.status, "cancelled");
  assert.equal(transaction.state, "CANCELLED");
  assert.equal(transaction.lock.status, "closed_cancelled");
  assert.equal(transaction.pendingExecution, null);
  assert.equal(transaction.outcome.paymentSubmitted, false);
  assert.throws(
    () => transactionService.execute(transactionId),
    (error) => error.statusCode === 403 && error.code === "AGENT_TRANSACTION_ISOLATED",
  );
});

test("payment resume requires the payment-session, run and action binding", async () => {
  const { agent } = runtime();
  let run = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600" });
  run = await agent.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" });
  await assert.rejects(
    agent.resume(run.id, {
      actionId: run.pendingAction.actionId,
      decision: "authenticated",
      paymentSessionId: "pauth_wrong",
    }),
    (error) => error.code === "PAYMENT_ACTION_BINDING_MISMATCH",
  );
  assert.equal(agent.getRun(run.id).status, "needs_user_action");
});

test("expired action closes the Agent transaction and lock", async () => {
  const { agent } = runtime();
  let run = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600" });
  run = await agent.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" });
  agent.store.require(run.id).pendingAction.expiresAt = "2000-01-01T00:00:00.000Z";
  await assert.rejects(
    agent.resume(run.id, {
      actionId: run.pendingAction.actionId,
      decision: "authenticated",
      paymentSessionId: run.pendingAction.paymentSessionId,
    }),
    (error) => error.statusCode === 410 && error.code === "ACTION_EXPIRED",
  );
  const expired = agent.getRun(run.id);
  const transaction = agent.getTransaction(run.id);
  assert.equal(expired.status, "expired");
  assert.equal(transaction.state, "EXPIRED");
  assert.equal(transaction.lock.status, "closed_expired");
});

test("rejecting the first authorization closes the transaction before a lock exists", async () => {
  const { agent } = runtime();
  let run = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600" });
  run = await agent.resume(run.id, { actionId: run.pendingAction.actionId, decision: "reject" });
  const transaction = agent.getTransaction(run.id);
  assert.equal(run.status, "cancelled");
  assert.equal(transaction.state, "CANCELLED");
  assert.equal(transaction.lock, null);
});

test("concurrent resume attempts allow only one use of the action", async () => {
  const { agent } = runtime();
  const run = await agent.createRun({ message: "帮我买 iPad，预算 HK$3,600" });
  const attempts = await Promise.allSettled([
    agent.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" }),
    agent.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason.statusCode === 409).length, 1);
});

test("LangChain LLM mode remains safe when the model omits every tool call", async (context) => {
  let receivedRequest;
  const modelStub = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_campuscart_stub",
      object: "chat.completion",
      created: 1,
      model: "gpt-6-astra",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "I recommend buying it immediately.", tool_calls: [] },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      modelStub.once("error", reject);
      modelStub.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("This sandbox forbids local sockets.");
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => modelStub.close(resolve)));

  const previous = {
    key: process.env.OPENAI_API_KEY,
    base: process.env.OPENAI_BASE_URL,
    model: process.env.CAMPUSCART_AGENT_MODEL,
  };
  process.env.OPENAI_API_KEY = "test-only-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${modelStub.address().port}/v1`;
  process.env.CAMPUSCART_AGENT_MODEL = "gpt-6-astra";
  try {
    const { agent } = runtime({ forceFallback: false });
    const run = await agent.createRun({ message: "帮我买 iPad，预算 HK$100" });
    assert.equal(run.agentMode, "langchain_llm_tools");
    assert.equal(run.status, "blocked");
    assert.equal(run.outcome.reason.code, "NO_EXECUTABLE_PLAN");
    assert.ok(receivedRequest.tools.some((entry) => entry.function?.name === "evaluate_checkout_options"));
    const completedTools = run.trace
      .filter((event) => event.type === "tool_call_completed")
      .map((event) => event.data.tool);
    assert.ok(completedTools.includes("inspect_student_eligibility"));
    assert.ok(completedTools.includes("evaluate_checkout_options"));
  } finally {
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.CAMPUSCART_AGENT_MODEL;
    else process.env.CAMPUSCART_AGENT_MODEL = previous.model;
  }
});
