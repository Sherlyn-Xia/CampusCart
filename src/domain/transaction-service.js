import { createHash, randomUUID } from "node:crypto";
import { appendAudit, verifyAuditChain } from "./audit.js";
import { hkd } from "./money.js";
import { defaultPolicy, offers, paymentMethods, product, publicSeed, purchasePaths, user } from "./seed.js";
import { evaluateOptions, precheck } from "./rule-engine.js";

function clone(value) {
  return structuredClone(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class TransactionService {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.sessions = new Map();
    this.paymentCallCount = 0;
  }

  now() {
    return this.clock().toISOString();
  }

  getBootstrap() {
    return { ...publicSeed(), scenarios: { success: defaultPolicy("success"), blocked: defaultPolicy("blocked") } };
  }

  createSession({ scenario = "success", policy = {}, identity = null, channel = "direct", ownerRunId = null } = {}) {
    if (!['success', 'blocked'].includes(scenario)) throw new Error("Unknown demo scenario");
    if (!['direct', 'agent'].includes(channel)) throw new Error("Unknown transaction channel");
    const effectiveUser = identity ? {
      ...clone(user),
      studentStatus: identity.studentStatus,
      credentialStatus: identity.credentialStatus,
    } : clone(user);
    const id = randomUUID();
    const session = {
      id,
      scenario,
      channel,
      ownerRunId,
      state: "DRAFT",
      environment: "sandbox",
      createdAt: this.now(),
      policy: { ...defaultPolicy(scenario), ...policy },
      product: clone(product),
      user: effectiveUser,
      identityEvidence: identity ? {
        providerId: identity.providerId,
        studentStatus: identity.studentStatus,
        credentialStatus: identity.credentialStatus,
        checkedAt: this.now(),
        source: identity.source,
      } : null,
      evaluation: null,
      authorization: null,
      lock: null,
      payment: null,
      order: null,
      outcome: null,
      pendingExecution: null,
      paymentAdapterCallCount: 0,
      audit: [],
    };
    this.sessions.set(id, session);
    appendAudit(session, "task_created", {
      scenario,
      sku: session.product.sku,
      channel,
      ownerRunId,
      identityStatus: session.identityEvidence ? {
        studentStatus: session.identityEvidence.studentStatus,
        credentialStatus: session.identityEvidence.credentialStatus,
        providerId: session.identityEvidence.providerId,
      } : "built_in_demo_identity",
      environment: "sandbox",
      dataClassification: "synthetic_demo",
    }, this.now());
    return this.snapshot(session);
  }

  requireSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      const error = new Error("Session not found");
      error.statusCode = 404;
      throw error;
    }
    return session;
  }

  requireState(session, allowed) {
    if (!allowed.includes(session.state)) {
      const error = new Error(`Action is not allowed from ${session.state}`);
      error.statusCode = 409;
      throw error;
    }
  }

  evaluate(id, policyPatch = {}) {
    const session = this.requireSession(id);
    this.requireState(session, ["DRAFT", "OPTIONS_EVALUATED"]);
    session.policy = { ...session.policy, ...policyPatch };
    session.evaluation = evaluateOptions({
      product: session.product,
      user: session.user,
      offers,
      paths: purchasePaths,
      policy: session.policy,
      now: this.now(),
    });
    session.state = "OPTIONS_EVALUATED";
    appendAudit(session, "plan_ranked", {
      recommendedPlanId: session.evaluation.recommendedPlanId,
      eligiblePlanIds: session.evaluation.plans.filter((plan) => plan.eligible).map((plan) => plan.id),
      excludedOfferIds: session.evaluation.excludedOffers.map((item) => item.offerId),
      policyDigest: digest(session.policy),
    }, this.now());
    return this.snapshot(session);
  }

  authorize(id, { planId, policy = {} } = {}) {
    const session = this.requireSession(id);
    this.requireState(session, ["OPTIONS_EVALUATED"]);
    session.policy = { ...session.policy, ...policy };
    if (!Number.isInteger(session.policy.budgetCents)) {
      const error = new Error("A confirmed integer-cent spending cap is required before authorization");
      error.statusCode = 422;
      error.code = "BUDGET_REQUIRED_FOR_AUTHORIZATION";
      throw error;
    }

    // Re-evaluate deterministically against the policy being authorized.
    session.evaluation = evaluateOptions({
      product: session.product,
      user: session.user,
      offers,
      paths: purchasePaths,
      policy: session.policy,
      now: this.now(),
    });
    const chosenId = planId ?? session.evaluation.recommendedPlanId;
    const plan = session.evaluation.plans.find((candidate) => candidate.id === chosenId);
    if (!plan?.eligible) {
      const error = new Error("Selected plan is not eligible under the authorized policy");
      error.statusCode = 422;
      throw error;
    }
    if (!session.policy.autoPay) {
      const error = new Error("Automatic sandbox payment has not been authorized");
      error.statusCode = 422;
      throw error;
    }
    session.authorization = {
      id: randomUUID(),
      version: 1,
      status: "confirmed",
      confirmedAt: this.now(),
      planId: plan.id,
      policy: clone(session.policy),
      scope: "one sandbox purchase only",
    };
    session.state = "USER_AUTHORIZED";
    appendAudit(session, "mandate_confirmed", {
      authorizationId: session.authorization.id,
      planId: plan.id,
      maxPaymentCents: session.policy.budgetCents,
      maxPoints: session.policy.allowPoints ? session.policy.maxPoints : 0,
      autoPay: true,
    }, this.now());
    return this.snapshot(session);
  }

  createLock(id) {
    const session = this.requireSession(id);
    this.requireState(session, ["USER_AUTHORIZED"]);
    const plan = session.evaluation.plans.find((candidate) => candidate.id === session.authorization.planId);
    const createdAt = this.now();
    const expiresAt = new Date(new Date(createdAt).getTime() + 15 * 60_000).toISOString();
    const evidence = plan.appliedOffers.map((applied) => {
      const offer = offers.find((candidate) => candidate.id === applied.id);
      return {
        id: offer.id,
        version: offer.version,
        source: offer.source,
        observedAt: offer.observedAt,
      };
    });
    const body = {
      id: randomUUID(),
      authorizationId: session.authorization.id,
      environment: "sandbox",
      sku: plan.sku,
      merchantId: plan.merchantId,
      merchant: plan.merchant,
      planId: plan.id,
      offers: evidence,
      maxPaymentCents: session.policy.budgetCents,
      lockedCashOutCents: plan.cashOutCents,
      allowPoints: session.policy.allowPoints,
      maxPoints: session.policy.allowPoints ? session.policy.maxPoints : 0,
      paymentMethodId: plan.paymentMethodId,
      priceIncreaseRule: session.policy.priceIncreaseRule,
      createdAt,
      expiresAt,
      singleUse: true,
      userAuthorized: true,
    };
    // The digest covers immutable authorization fields; lifecycle status changes are audited separately.
    session.lock = { ...body, status: "active", digest: digest(body) };
    session.state = "BENEFIT_LOCKED";
    appendAudit(session, "benefit_locked", {
      lockId: session.lock.id,
      lockDigest: session.lock.digest,
      offerVersions: evidence.map(({ id: offerId, version }) => ({ offerId, version })),
      expiresAt,
    }, this.now());
    return this.snapshot(session);
  }

  buildFinalQuote(session) {
    const selected = session.evaluation.plans.find((plan) => plan.id === session.lock.planId);
    const finalQuote = clone(selected);
    let currentOffers = clone(offers);

    if (session.scenario === "blocked") {
      finalQuote.shippingCents = 16000;
      finalQuote.cashOutCents = selected.cashOutCents + 16000;
      finalQuote.referenceCostCents = selected.referenceCostCents + 16000;
      finalQuote.equation = `${hkd(finalQuote.productCents)} + ${hkd(finalQuote.shippingCents)} − ${hkd(finalQuote.discountCents)} − ${hkd(finalQuote.pointsValueCents)} points = ${hkd(finalQuote.cashOutCents)}`;
      currentOffers = currentOffers.map((offer) => offer.id === "SHIP-0" ? { ...offer, verificationStatus: "withdrawn" } : offer);
    }
    return { finalQuote, currentOffers };
  }

  block(session, verdict, finalQuote) {
    session.state = "BLOCKED";
    session.lock.status = "closed_blocked";
    session.lock.closedAt = this.now();
    session.pendingExecution = null;
    session.outcome = {
      type: "blocked",
      reason: verdict.failures.find((failure) => failure.code === "MAX_TOTAL_EXCEEDED") ?? verdict.failures[0],
      failures: verdict.failures,
      finalQuote,
      paymentSubmitted: false,
      paymentCallCount: session.paymentAdapterCallCount,
    };
    appendAudit(session, "policy_blocked", {
      reasonCodes: verdict.failures.map((failure) => failure.code),
      paymentSubmitted: false,
      paymentAdapterCallDelta: 0,
      finalCashOutCents: finalQuote.cashOutCents,
      maxPaymentCents: session.lock.maxPaymentCents,
    }, this.now());
    return this.snapshot(session);
  }

  blockBeforeAuthorization(id, failure) {
    const session = this.requireSession(id);
    this.requireState(session, ["OPTIONS_EVALUATED"]);
    session.state = "BLOCKED";
    session.pendingExecution = null;
    session.outcome = {
      type: "blocked",
      reason: clone(failure),
      failures: [clone(failure)],
      finalQuote: null,
      paymentSubmitted: false,
      paymentCallCount: session.paymentAdapterCallCount,
    };
    appendAudit(session, "policy_blocked", {
      reasonCodes: [failure.code],
      paymentSubmitted: false,
      paymentAdapterCallDelta: 0,
      stage: "before_authorization",
    }, this.now());
    return this.snapshot(session);
  }

  requireClarification(id, reason) {
    const session = this.requireSession(id);
    this.requireState(session, ["OPTIONS_EVALUATED"]);
    session.state = "NEEDS_CLARIFICATION";
    session.pendingExecution = null;
    session.outcome = {
      type: "needs_clarification",
      reason: clone(reason),
      finalQuote: null,
      paymentSubmitted: false,
      paymentCallCount: session.paymentAdapterCallCount,
    };
    appendAudit(session, "clarification_required", {
      reasonCode: reason.code,
      paymentSubmitted: false,
      stage: "before_authorization",
    }, this.now());
    return this.snapshot(session);
  }

  cancel(id, reason = { code: "USER_CANCELLED", message: "The user cancelled the transaction." }) {
    const session = this.requireSession(id);
    if (["COMPLETED", "BLOCKED", "CANCELLED", "EXPIRED", "NEEDS_CLARIFICATION"].includes(session.state)) return this.snapshot(session);
    if (session.lock?.status === "active") {
      session.lock.status = "closed_cancelled";
      session.lock.closedAt = this.now();
    }
    if (session.authorization?.status === "confirmed") {
      session.authorization.status = "cancelled";
      session.authorization.cancelledAt = this.now();
    }
    session.pendingExecution = null;
    session.state = "CANCELLED";
    session.outcome = {
      type: "cancelled",
      reason: clone(reason),
      paymentSubmitted: false,
      paymentCallCount: session.paymentAdapterCallCount,
    };
    appendAudit(session, "transaction_cancelled", {
      reasonCode: reason.code,
      paymentSubmitted: false,
      lockStatus: session.lock?.status ?? "not_created",
    }, this.now());
    return this.snapshot(session);
  }

  expire(id, reason = { code: "ACTION_EXPIRED", message: "The pending human action expired before it was used." }) {
    const session = this.requireSession(id);
    if (["COMPLETED", "BLOCKED", "CANCELLED", "EXPIRED"].includes(session.state)) return this.snapshot(session);
    if (session.lock?.status === "active") {
      session.lock.status = "closed_expired";
      session.lock.closedAt = this.now();
    }
    if (session.authorization?.status === "confirmed") {
      session.authorization.status = "expired";
      session.authorization.expiredAt = this.now();
    }
    session.pendingExecution = null;
    session.state = "EXPIRED";
    session.outcome = {
      type: "expired",
      reason: clone(reason),
      paymentSubmitted: false,
      paymentCallCount: session.paymentAdapterCallCount,
    };
    appendAudit(session, "action_expired", {
      reasonCode: reason.code,
      paymentSubmitted: false,
      lockStatus: session.lock?.status ?? "not_created",
    }, this.now());
    return this.snapshot(session);
  }

  prepareExecution(id) {
    const session = this.requireSession(id);
    if (session.outcome) return this.snapshot(session); // Idempotent replay: never submit a second payment.
    if (session.state === "PAYMENT_AUTH_REQUIRED") return this.snapshot(session);
    this.requireState(session, ["BENEFIT_LOCKED"]);
    session.state = "PRECHECK";
    const { finalQuote, currentOffers } = this.buildFinalQuote(session);

    appendAudit(session, "quote_checked", {
      quoteId: `quote-${session.id}`,
      productCents: finalQuote.productCents,
      shippingCents: finalQuote.shippingCents,
      cashOutCents: finalQuote.cashOutCents,
      simulatedChange: session.scenario === "blocked" ? "free delivery removed; shipping is now HK$160" : "none",
    }, this.now());

    const verdict = precheck({ lock: session.lock, finalQuote, currentOffers, now: this.now() });
    if (!verdict.allowed) return this.block(session, verdict, finalQuote);

    session.state = "PAYMENT_AUTH_REQUIRED";
    session.pendingExecution = {
      finalQuote,
      precheckedAt: this.now(),
      quoteDigest: digest(finalQuote),
    };
    appendAudit(session, "precheck_passed", {
      amountCents: finalQuote.cashOutCents,
      authorizationId: session.authorization.id,
      quoteDigest: session.pendingExecution.quoteDigest,
    }, this.now());
    return this.snapshot(session);
  }

  completeExternalPayment(id, receipt) {
    const session = this.requireSession(id);
    if (session.outcome) return this.snapshot(session);
    this.requireState(session, ["PAYMENT_AUTH_REQUIRED"]);
    const finalQuote = session.pendingExecution.finalQuote;
    const acceptedStatuses = ["authorized", "captured_sandbox"];
    if (!receipt || !acceptedStatuses.includes(receipt.status)) {
      const error = new Error("A verified payment authorization receipt is required");
      error.statusCode = 422;
      throw error;
    }
    if (receipt.paymentMethodId !== session.lock.paymentMethodId) {
      return this.block(session, { allowed: false, failures: [{
        code: "PAYMENT_METHOD_CHANGED",
        message: "The authenticated payment method does not match the Benefit Lock.",
      }] }, finalQuote);
    }

    const refreshed = this.buildFinalQuote(session);
    const secondVerdict = precheck({ lock: session.lock, finalQuote: refreshed.finalQuote, currentOffers: refreshed.currentOffers, now: this.now() });
    if (!secondVerdict.allowed) return this.block(session, secondVerdict, refreshed.finalQuote);

    appendAudit(session, "budget_reserved", {
      amountCents: finalQuote.cashOutCents,
      authorizationId: session.authorization.id,
    }, this.now());
    this.paymentCallCount += 1;
    session.paymentAdapterCallCount += 1;
    session.state = "PAYMENT_EXECUTED";
    session.payment = {
      id: receipt.externalPaymentId ?? `pay_demo_${randomUUID().slice(0, 8)}`,
      adapter: receipt.providerId ?? paymentMethods.find((method) => method.id === finalQuote.paymentMethodId)?.name,
      status: receipt.status,
      amountCents: finalQuote.cashOutCents,
      idempotencyKey: `purchase-${session.lock.id}`,
      submittedAt: receipt.authenticatedAt ?? this.now(),
      disclaimer: receipt.disclaimer ?? "External sandbox authorization recorded. No real funds moved.",
    };
    appendAudit(session, "payment_submitted", {
      paymentId: session.payment.id,
      amountCents: session.payment.amountCents,
      adapter: "mock",
      idempotencyKey: session.payment.idempotencyKey,
    }, this.now());

    session.order = {
      id: `order_demo_${randomUUID().slice(0, 8)}`,
      status: "accepted_sandbox",
      acceptedAt: this.now(),
      fulfillment: finalQuote.fulfillment,
      disclaimer: "Simulated order. Nothing will be shipped.",
    };
    session.state = "COMPLETED";
    session.lock.status = "consumed";
    session.lock.consumedAt = this.now();
    session.pendingExecution = null;
    session.outcome = {
      type: "success",
      finalQuote,
      paymentSubmitted: true,
      paymentCallCount: session.paymentAdapterCallCount,
    };
    appendAudit(session, "order_status_changed", {
      orderId: session.order.id,
      status: session.order.status,
      paymentId: session.payment.id,
    }, this.now());
    appendAudit(session, "transaction_completed", {
      lockId: session.lock.id,
      cashOutCents: finalQuote.cashOutCents,
      orderId: session.order.id,
    }, this.now());
    return this.snapshot(session);
  }

  execute(id) {
    const session = this.requireSession(id);
    if (session.channel === "agent") {
      const error = new Error("Agent-owned transactions can only complete through their current Agent action");
      error.statusCode = 403;
      error.code = "AGENT_TRANSACTION_ISOLATED";
      throw error;
    }
    const prepared = this.prepareExecution(id);
    if (prepared.outcome || prepared.state !== "PAYMENT_AUTH_REQUIRED") return prepared;
    return this.completeExternalPayment(id, {
      providerId: "mock-local-adapter",
      externalPaymentId: `pay_demo_${randomUUID().slice(0, 8)}`,
      paymentMethodId: prepared.lock.paymentMethodId,
      status: "captured_sandbox",
      authenticatedAt: this.now(),
      disclaimer: "Simulated payment. No funds moved.",
    });
  }

  snapshot(sessionOrId) {
    const session = typeof sessionOrId === "string" ? this.requireSession(sessionOrId) : sessionOrId;
    return { ...clone(session), auditChainValid: verifyAuditChain(session.audit) };
  }
}
