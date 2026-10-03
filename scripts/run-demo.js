import { TransactionService } from "../src/domain/transaction-service.js";
import { hkd } from "../src/domain/money.js";

for (const scenario of ["success", "blocked"]) {
  const engine = new TransactionService();
  let session = engine.createSession({ scenario });
  session = engine.evaluate(session.id);
  session = engine.authorize(session.id, { planId: session.evaluation.recommendedPlanId });
  session = engine.createLock(session.id);
  session = engine.execute(session.id);
  const amount = session.outcome.finalQuote.cashOutCents;
  console.log(`\n${scenario.toUpperCase()} · ${session.state}`);
  console.log(`Final amount: ${hkd(amount)}`);
  console.log(`Payment submitted: ${session.outcome.paymentSubmitted}`);
  console.log(`Audit events: ${session.audit.length} · hash chain valid: ${session.auditChainValid}`);
  if (session.outcome.type === "blocked") console.log(`${session.outcome.reason.code}: ${session.outcome.reason.message}`);
}
