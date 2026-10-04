import { createHash, randomUUID } from "node:crypto";

function intentKeyFor(run) {
  const sku = run.proposal?.intent?.product?.sku
    ?? run.request?.context?.selectedProduct?.sku
    ?? "unknown-product";
  return `purchase:${sku}`;
}

function reasonCodes(run, transaction) {
  return [...new Set([
    run.outcome?.reason?.code,
    ...(run.outcome?.failures ?? []).map((failure) => failure.code),
    ...(transaction?.outcome?.failures ?? []).map((failure) => failure.code),
  ].filter(Boolean))];
}

function lessonFor(status, codes) {
  if (status === "completed") return "Keep both human confirmations and both deterministic prechecks; they produced a completed, auditable transaction.";
  if (status === "blocked") return `Explain the blocking evidence and ask only for a safe constraint change. Recorded reasons: ${codes.join(", ") || "policy check failed"}.`;
  if (status === "needs_clarification") return `Ask for the missing or ambiguous purchase detail before authorization. Recorded reasons: ${codes.join(", ") || "clarification required"}.`;
  if (status === "expired") return "Create a new authorization rather than replaying an expired action.";
  if (status === "cancelled") return "Respect the rejection or cancellation; never reuse the closed authorization.";
  return "Do not reuse execution authority from this run; rely on current deterministic evidence.";
}

export class ExperienceMemory {
  constructor({ repository } = {}) {
    this.repository = repository;
  }

  record({ run, transaction = null }) {
    if (!this.repository || !run) return null;
    const codes = reasonCodes(run, transaction);
    const evidence = {
      traceTail: (run.trace ?? []).slice(-8).map((event) => event.type),
      transactionAuditTail: (transaction?.audit ?? []).slice(-8).map((event) => event.type),
      auditChainValid: transaction?.auditChainValid ?? null,
    };
    const episode = {
      id: `memory_${randomUUID()}`,
      runId: run.id,
      intentKey: intentKeyFor(run),
      outcomeType: run.status,
      createdAt: new Date().toISOString(),
      summary: lessonFor(run.status, codes),
      reasonCodes: codes,
      evidence,
      evidenceDigest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
      allowedInfluence: ["clarification_strategy", "tool_routing", "explanation"],
      prohibitedInfluence: ["price", "budget", "eligibility", "authorization", "payment_execution"],
      quality: {
        status: evidence.auditChainValid === false ? "candidate" : "verified",
        score: evidence.auditChainValid === false ? 0.5 : 1,
        source: "deterministic_reflection",
        updatedAt: new Date().toISOString(),
      },
      usage: { retrievalCount: 0, lastRetrievedAt: null },
      feedback: [],
    };
    this.repository.save(episode);
    return episode;
  }

  recallForRun(run, { limit = 3 } = {}) {
    if (!this.repository || !run) return [];
    const episodes = this.repository.find({ intentKey: intentKeyFor(run), limit })
      .filter((episode) => episode.runId !== run.id);
    this.repository.markRetrieved(episodes.map((episode) => episode.id));
    return episodes;
  }

  recordFeedback(runId, { rating, note = null }) {
    if (!this.repository) return null;
    return this.repository.addFeedback({
      id: `feedback_${randomUUID()}`,
      runId,
      rating,
      note,
      createdAt: new Date().toISOString(),
    });
  }

  getForRun(runId) {
    if (!this.repository) return null;
    const episode = this.repository.getByRunId(runId);
    return episode ? { ...episode, feedback: this.repository.feedbackForRun(runId) } : null;
  }

  capabilities() {
    return {
      enabled: Boolean(this.repository),
      type: "structured_reflection_episodes",
      qualityGate: true,
      userFeedback: true,
      allowedInfluence: ["clarification_strategy", "tool_routing", "explanation"],
      policyMutationAllowed: false,
    };
  }
}
