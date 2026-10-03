import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";
import { createCampusCartServer } from "../src/server.js";

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("HTTP contract exposes Agent flow, SSE and payment page while legacy mutations are retired", async (context) => {
  const transactionService = new TransactionService();
  const runtime = new AgentRuntime({ transactionService, forceFallback: true });
  const { server } = createCampusCartServer({ service: transactionService, agentRuntime: runtime });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("This sandbox forbids local sockets; run outside the sandbox to exercise the HTTP contract.");
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const legacy = await post(base, "/api/sessions", { scenario: "success" });
  assert.equal(legacy.response.status, 410);
  assert.equal(legacy.body.code, "LEGACY_TRANSACTION_API_RETIRED");

  const unsupported = await post(base, "/api/v1/agent/runs", {
    message: "帮我买一串香蕉，预算 HK$100",
  });
  assert.equal(unsupported.response.status, 422);
  assert.equal(unsupported.body.code, "UNSUPPORTED_PRODUCT");

  let created = await post(base, "/api/v1/agent/runs", {
    message: "帮我买 iPad，预算 HK$3,600",
  });
  assert.equal(created.response.status, 201);
  const runId = created.body.id;

  const eventResponse = await fetch(`${base}/api/v1/agent/runs/${runId}/events`);
  assert.match(eventResponse.headers.get("content-type"), /^text\/event-stream/);
  const eventReader = eventResponse.body.getReader();
  const firstChunk = await eventReader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: trace/);
  await eventReader.cancel();

  created = await post(base, `/api/v1/agent/runs/${runId}/resume`, {
    actionId: created.body.pendingAction.actionId,
    decision: "approve",
  });
  assert.equal(created.body.pendingAction.type, "payment_authentication");
  const authPage = await fetch(`${base}${created.body.pendingAction.url}`);
  assert.equal(authPage.status, 200);
  assert.match(await authPage.text(), /Authenticate this payment/);

  const failed = await post(base, `/api/v1/agent/runs/${runId}/resume`, {
    actionId: created.body.pendingAction.actionId,
    decision: "failed",
    paymentSessionId: created.body.pendingAction.paymentSessionId,
  });
  assert.equal(failed.body.status, "cancelled");

  const transactionResponse = await fetch(`${base}/api/v1/agent/runs/${runId}/transaction`);
  const transaction = await transactionResponse.json();
  assert.equal(transaction.state, "CANCELLED");
  assert.equal(transaction.lock.status, "closed_cancelled");
  assert.equal(transaction.pendingExecution, null);
});
