import assert from "node:assert/strict";
import test from "node:test";
import { inspectProductLanguage } from "../src/agent/tools.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { TransactionService } from "../src/domain/transaction-service.js";

const selectedProduct = { sku: "EDU-IPAD-A16-128-SLV", source: "product_page", userConfirmed: true };

test("quantity above one is detected in digits, Chinese numerals and English", () => {
  for (const [text, quantity] of [
    ["我要两台 iPad", 2],
    ["买三台 iPad", 3],
    ["我们俩都要 iPad", 2],
    ["帮我买 2 台 iPad", 2],
    ["iPad x2", 2],
    ["I want two iPads", 2],
    ["我要买两只 iPad", 2],
    ["买一对", 2],
    ["iPad 数量 2", 2],
  ]) {
    const result = inspectProductLanguage(text);
    assert.equal(result.quantity, quantity, text);
    assert.equal(result.ambiguousQuantity, true, text);
  }
  for (const text of ["帮我买一台 iPad", "帮我买这台 iPad", "buy one iPad", "帮我买这台 iPad，最多用 100 个积分", "买一台，用一个积分"]) {
    assert.equal(inspectProductLanguage(text).ambiguousQuantity, false, text);
  }
});

test("variants outside the single demo SKU need confirmation", () => {
  for (const text of ["iPad 256GB", "买个 iPad Pro", "iPad Air", "iPad 蓝色", "iPad 5G 版", "1TB 的平板"]) {
    assert.equal(inspectProductLanguage(text).ambiguousSpecification, true, text);
  }
  for (const text of ["帮我买这台 iPad，预算 HK$3,600", "128GB 银色 iPad", "iPad 128GB Wi-Fi 银色"]) {
    assert.equal(inspectProductLanguage(text).ambiguousSpecification, false, text);
  }
});

test("a request for two iPads or another variant stops for clarification without any plan or transaction action", async () => {
  const agent = new AgentRuntime({ transactionService: new TransactionService(), forceFallback: true });
  for (const [message, code] of [
    ["我要两台 iPad，预算 HK$7,200", "AMBIGUOUS_QUANTITY"],
    ["帮我买 iPad 256GB，预算 HK$4,000", "AMBIGUOUS_PRODUCT_SPEC"],
  ]) {
    const run = await agent.createRun({ message, context: { selectedProduct } });
    assert.equal(run.status, "needs_clarification", message);
    assert.equal(run.pendingAction, null, message);
    assert.equal(run.outcome.reason.code, code, message);
    assert.equal(run.proposal.plan, null, message);
  }
});

test("an English budget followed by a comma is parsed (budget HK$3,600, up to 100 points)", async () => {
  const agent = new AgentRuntime({ transactionService: new TransactionService(), forceFallback: true });
  const run = await agent.createRun({
    message: "Help me buy this iPad, budget HK$3,600, up to 100 points.",
    context: { selectedProduct },
  });
  assert.equal(run.status, "needs_user_action");
  assert.equal(run.proposal.intent.constraints.budgetCents, 360000);
  assert.equal(run.proposal.intent.constraints.maxPoints, 100);
});
