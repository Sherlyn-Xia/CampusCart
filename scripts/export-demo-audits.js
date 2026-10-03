import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";

const outputDirectory = fileURLToPath(new URL("../docs/demo-audits/", import.meta.url));
const selectedProduct = {
  sku: "EDU-IPAD-A16-128-SLV",
  source: "product_page",
  userConfirmed: true,
};

function createRuntime() {
  return new AgentRuntime({ transactionService: new TransactionService(), forceFallback: true });
}

function evidence(runtime, run) {
  return {
    generatedAt: new Date().toISOString(),
    dataClassification: "synthetic_sandbox_demo",
    run: runtime.getRun(run.id),
    agentTrace: runtime.getTrace(run.id).events,
    transaction: runtime.getTransaction(run.id),
  };
}

async function success() {
  const runtime = createRuntime();
  let run = await runtime.createRun({
    message: "帮我买这台 iPad，预算 HK$3,600，最多用 100 积分",
    context: { selectedProduct, demoScenario: "success" },
  });
  run = await runtime.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" });
  run = await runtime.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "authenticated",
    paymentSessionId: run.pendingAction.paymentSessionId,
  });
  return evidence(runtime, run);
}

async function stopped() {
  const runtime = createRuntime();
  let run = await runtime.createRun({
    message: "帮我买这台 iPad，预算 HK$3,500；如果涨价就停止",
    context: { selectedProduct, demoScenario: "blocked" },
  });
  run = await runtime.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" });
  return evidence(runtime, run);
}

async function rejected() {
  const runtime = createRuntime();
  let run = await runtime.createRun({
    message: "帮我买这台 iPad，预算 HK$3,600",
    context: { selectedProduct },
  });
  run = await runtime.resume(run.id, { actionId: run.pendingAction.actionId, decision: "reject" });
  return evidence(runtime, run);
}

async function paymentFailed() {
  const runtime = createRuntime();
  let run = await runtime.createRun({
    message: "帮我买这台 iPad，预算 HK$3,600",
    context: { selectedProduct },
  });
  run = await runtime.resume(run.id, { actionId: run.pendingAction.actionId, decision: "approve" });
  run = await runtime.resume(run.id, {
    actionId: run.pendingAction.actionId,
    decision: "failed",
    paymentSessionId: run.pendingAction.paymentSessionId,
  });
  return evidence(runtime, run);
}

await mkdir(outputDirectory, { recursive: true });
const samples = {
  "success.json": await success(),
  "stopped-over-budget.json": await stopped(),
  "user-rejected.json": await rejected(),
  "payment-auth-failed.json": await paymentFailed(),
};
await Promise.all(Object.entries(samples).map(([name, sample]) => (
  writeFile(new URL(`../docs/demo-audits/${name}`, import.meta.url), `${JSON.stringify(sample, null, 2)}\n`)
)));
console.log(`Wrote ${Object.keys(samples).length} sandbox audit samples to ${outputDirectory}`);
