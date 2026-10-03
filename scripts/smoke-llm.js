import assert from "node:assert/strict";
import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required for the live LangChain smoke test.");
  process.exitCode = 2;
} else {
  const runtime = new AgentRuntime({
    transactionService: new TransactionService(),
    forceFallback: false,
  });
  const run = await runtime.createRun({
    message: "帮我购买这台 iPad，预算 HK$3,600，最多使用 100 积分。请调用工具比较方案，但不要替我授权。",
    context: {
      selectedProduct: {
        sku: "EDU-IPAD-A16-128-SLV",
        source: "product_page",
        userConfirmed: true,
      },
    },
  });
  const trace = runtime.getTrace(run.id).events;
  assert.equal(run.agentMode, "langchain_llm_tools");
  assert.ok(trace.some((event) => event.type === "model_invocation_completed"));
  assert.equal(trace.some((event) => event.type === "model_invocation_failed"), false);
  assert.equal(run.pendingAction?.type, "purchase_authorization");
  console.log(JSON.stringify({
    model: process.env.CAMPUSCART_AGENT_MODEL ?? "gpt-6-astra",
    agentMode: run.agentMode,
    status: run.status,
    pendingActionType: run.pendingAction.type,
    modelEvents: trace.filter((event) => event.type.startsWith("model_invocation")),
    completedTools: trace
      .filter((event) => event.type === "tool_call_completed")
      .map((event) => event.data.tool),
  }, null, 2));
}
