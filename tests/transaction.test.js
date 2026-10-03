import test from "node:test";
import assert from "node:assert/strict";
import { TransactionService } from "../src/domain/transaction-service.js";

function service() {
  return new TransactionService({ clock: () => new Date("2026-10-02T04:00:00.000Z") });
}

function lockScenario(engine, scenario) {
  let session = engine.createSession({ scenario });
  session = engine.evaluate(session.id);
  session = engine.authorize(session.id, { planId: session.evaluation.recommendedPlanId });
  return engine.createLock(session.id);
}

test("success scenario follows the full state machine and submits exactly once", () => {
  const engine = service();
  let session = lockScenario(engine, "success");
  assert.equal(session.state, "BENEFIT_LOCKED");
  session = engine.execute(session.id);
  assert.equal(session.state, "COMPLETED");
  assert.equal(session.payment.status, "captured_sandbox");
  assert.equal(session.order.status, "accepted_sandbox");
  assert.equal(session.lock.status, "consumed");
  assert.equal(session.outcome.paymentCallCount, 1);
  assert.equal(session.auditChainValid, true);

  const replay = engine.execute(session.id);
  assert.equal(replay.outcome.paymentCallCount, 1, "idempotent replay cannot call payment twice");
  assert.equal(engine.paymentCallCount, 1);
});

test("blocked scenario is rejected by backend after shipping raises total to HK$3,559", () => {
  const engine = service();
  let session = lockScenario(engine, "blocked");
  session = engine.execute(session.id);
  assert.equal(session.state, "BLOCKED");
  assert.equal(session.outcome.finalQuote.cashOutCents, 355900);
  assert.match(session.outcome.finalQuote.equation, /HK\$3,559$/);
  assert.equal(session.outcome.reason.code, "MAX_TOTAL_EXCEEDED");
  assert.match(session.outcome.reason.message, /HK\$3,399/);
  assert.match(session.outcome.reason.message, /HK\$3,559/);
  assert.match(session.outcome.reason.message, /HK\$3,500/);
  assert.equal(session.payment, null);
  assert.equal(session.order, null);
  assert.equal(engine.paymentCallCount, 0);
  assert.equal(session.paymentAdapterCallCount, 0);
  assert.equal(session.outcome.paymentSubmitted, false);
  assert.equal(session.auditChainValid, true);
  assert.ok(session.audit.some((event) => event.type === "policy_blocked"));
  assert.ok(!session.audit.some((event) => event.type === "payment_submitted"));
});

test("payment call evidence is isolated per transaction session", () => {
  const engine = service();
  const success = engine.execute(lockScenario(engine, "success").id);
  const blocked = engine.execute(lockScenario(engine, "blocked").id);
  assert.equal(success.outcome.paymentCallCount, 1);
  assert.equal(blocked.outcome.paymentCallCount, 0);
  assert.equal(engine.paymentCallCount, 1, "process-wide diagnostic still sees the one successful call");
});

test("external payment flow exposes a safe async boundary and rechecks the lock", () => {
  const engine = service();
  const locked = lockScenario(engine, "success");
  const prepared = engine.prepareExecution(locked.id);
  assert.equal(prepared.state, "PAYMENT_AUTH_REQUIRED");
  assert.equal(prepared.payment, null);
  assert.equal(prepared.paymentAdapterCallCount, 0);

  const completed = engine.completeExternalPayment(locked.id, {
    providerId: "test-sandbox-provider",
    externalPaymentId: "test-payment-1",
    paymentMethodId: prepared.lock.paymentMethodId,
    status: "authorized",
    authenticatedAt: "2026-10-02T04:00:00.000Z",
  });
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.outcome.paymentCallCount, 1);
  assert.equal(completed.audit.filter((event) => event.type === "precheck_passed").length, 1);
});

test("expired Benefit Lock is closed without a payment call", () => {
  let now = new Date("2026-10-02T04:00:00.000Z");
  const engine = new TransactionService({ clock: () => now });
  const locked = lockScenario(engine, "success");
  now = new Date("2026-10-02T04:16:00.000Z");
  const result = engine.execute(locked.id);
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.outcome.reason.code, "LOCK_EXPIRED");
  assert.equal(result.outcome.paymentSubmitted, false);
  assert.equal(result.paymentAdapterCallCount, 0);
});
