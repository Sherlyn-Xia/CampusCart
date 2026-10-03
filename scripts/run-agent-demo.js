import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";

async function runScenario(demoScenario, message) {
  const runtime = new AgentRuntime({
    transactionService: new TransactionService(),
    forceFallback: true,
  });
  let run = await runtime.createRun({ message, context: { demoScenario } });
  const authorization = run.pendingAction;
  run = await runtime.resume(run.id, { actionId: authorization.actionId, decision: "approve" });
  if (run.pendingAction?.type === "payment_authentication") {
    run = await runtime.resume(run.id, {
      actionId: run.pendingAction.actionId,
      decision: "authenticated",
      paymentSessionId: run.pendingAction.paymentSessionId,
    });
  }
  const tools = runtime.getTrace(run.id).events
    .filter((event) => event.type === "tool_call_completed")
    .map((event) => event.data.tool);
  return {
    scenario: demoScenario,
    framework: run.framework,
    agentMode: run.agentMode,
    status: run.status,
    outcome: run.outcome,
    completedTools: tools,
  };
}

const success = await runScenario(
  "success",
  "帮我买这台 iPad，预算 HK$3,600，最多用 100 积分",
);
const blocked = await runScenario(
  "blocked",
  "帮我买这台 iPad，预算 HK$3,500；如果涨价就停止",
);

console.log(JSON.stringify({ success, blocked }, null, 2));
