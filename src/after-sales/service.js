import { createHash, randomUUID } from "node:crypto";

function clone(value) {
  return structuredClone(value);
}

function appendCaseAudit(serviceCase, type, data, at) {
  const previousHash = serviceCase.audit.at(-1)?.hash ?? "GENESIS";
  const event = {
    id: randomUUID(),
    sequence: serviceCase.audit.length + 1,
    type,
    at,
    data: clone(data),
    previousHash,
  };
  event.hash = createHash("sha256").update(previousHash + JSON.stringify(event)).digest("hex");
  serviceCase.audit.push(event);
  serviceCase.updatedAt = at;
}

function verifyCaseAudit(events) {
  let previousHash = "GENESIS";
  for (const event of events) {
    if (event.previousHash !== previousHash) return false;
    const copy = { ...event };
    delete copy.hash;
    const expected = createHash("sha256").update(previousHash + JSON.stringify(copy)).digest("hex");
    if (event.hash !== expected) return false;
    previousHash = event.hash;
  }
  return true;
}

export class AfterSalesService {
  constructor({ transactionService, repository = null, knowledgeBase = null, clock = () => new Date() } = {}) {
    this.transactionService = transactionService;
    this.repository = repository;
    this.knowledgeBase = knowledgeBase;
    this.clock = clock;
    this.cases = new Map((repository?.all() ?? []).map((serviceCase) => [serviceCase.id, serviceCase]));
  }

  now() {
    return this.clock().toISOString();
  }

  capabilities() {
    return {
      enabled: true,
      environment: "sandbox",
      actions: ["cancel_order", "refund", "return", "exchange"],
      automaticActions: ["cancel_order", "refund"],
      manualReviewActions: ["return", "exchange"],
      confirmationRequired: true,
      returnWindowDays: 14,
    };
  }

  snapshot(serviceCase) {
    return { ...clone(serviceCase), auditChainValid: verifyCaseAudit(serviceCase.audit) };
  }

  commit(serviceCase) {
    this.repository?.save(serviceCase);
    return this.snapshot(serviceCase);
  }

  requireCase(id) {
    const serviceCase = this.cases.get(id);
    if (!serviceCase) {
      const error = new Error("After-sales case not found");
      error.statusCode = 404;
      error.code = "AFTER_SALES_CASE_NOT_FOUND";
      throw error;
    }
    return serviceCase;
  }

  list({ runId = null, orderId = null } = {}) {
    return [...this.cases.values()]
      .filter((serviceCase) => !runId || serviceCase.runId === runId)
      .filter((serviceCase) => !orderId || serviceCase.orderId === orderId)
      .map((serviceCase) => this.snapshot(serviceCase));
  }

  async createCaseFromMessage({ runId, message, idempotencyKey = null }) {
    const requestedAction = /取消(?:订单)?|反悔|changed\s+my\s+mind|cancel\s+(?:my\s+)?order/i.test(message)
      ? "cancel_order"
      : /换货|换一(?:台|个|件)|exchange|replacement?/i.test(message)
        ? "exchange"
        : /退货|return(?:\s+the|\s+this)?\s+(?:item|product|order)/i.test(message)
          ? "return"
          : /退款|refund|money\s+back/i.test(message)
            ? "refund"
            : null;
    if (!requestedAction) {
      const error = new Error("Clarify whether you want to cancel the order, request a refund, return it, or exchange it");
      error.statusCode = 422;
      error.code = "AFTER_SALES_INTENT_UNCLEAR";
      throw error;
    }
    const knowledge = this.knowledgeBase
      ? await this.knowledgeBase.retrieve(message, { category: "after_sales", limit: 3 })
      : [];
    return this.createCase({
      runId,
      requestedAction,
      reason: message,
      idempotencyKey,
      knowledgeEvidence: knowledge.map((result) => ({
        chunkId: result.id,
        source: result.source,
        version: result.version,
        retrieval: result.retrieval ?? { strategy: "lexical" },
      })),
    });
  }

  createCase({ runId, requestedAction, reason, idempotencyKey = null, knowledgeEvidence = [] }) {
    const existing = idempotencyKey
      ? [...this.cases.values()].find((serviceCase) => serviceCase.runId === runId && serviceCase.idempotencyKey === idempotencyKey)
      : null;
    if (existing) return this.snapshot(existing);
    const activeCase = [...this.cases.values()].find((serviceCase) => serviceCase.runId === runId
      && ["USER_CONFIRMATION_REQUIRED", "REFUND_PENDING"].includes(serviceCase.status));
    if (activeCase) {
      const error = new Error("This order already has an active after-sales confirmation");
      error.statusCode = 409;
      error.code = "AFTER_SALES_CASE_ALREADY_OPEN";
      throw error;
    }
    const transaction = this.transactionService.findByOwnerRunId(runId);
    if (!transaction?.order) {
      const error = new Error("This Agent run has no completed order");
      error.statusCode = 404;
      error.code = "ORDER_NOT_FOUND";
      throw error;
    }
    if (transaction.state === "REFUNDED") {
      const error = new Error("This order has already been refunded");
      error.statusCode = 409;
      error.code = "ORDER_ALREADY_REFUNDED";
      throw error;
    }
    if (transaction.state !== "COMPLETED") {
      const error = new Error("Only completed orders can enter after-sales service");
      error.statusCode = 409;
      error.code = "ORDER_NOT_SERVICEABLE";
      throw error;
    }

    const createdAt = this.now();
    const ageMs = this.clock().getTime() - new Date(transaction.order.acceptedAt).getTime();
    const withinWindow = ageMs >= 0 && ageMs <= 14 * 24 * 60 * 60_000;
    const needsMerchantReview = ["return", "exchange"].includes(requestedAction);
    const status = !withinWindow ? "REJECTED"
      : needsMerchantReview ? "MANUAL_REVIEW"
        : "USER_CONFIRMATION_REQUIRED";
    const serviceCase = {
      id: `case_${randomUUID()}`,
      runId,
      transactionSessionId: transaction.id,
      orderId: transaction.order.id,
      requestedAction,
      reason,
      knowledgeEvidence,
      idempotencyKey,
      status,
      createdAt,
      updatedAt: createdAt,
      eligibility: {
        evaluatedAt: createdAt,
        returnWindowDays: 14,
        withinWindow,
        orderStatus: transaction.order.status,
        result: withinWindow ? (needsMerchantReview ? "manual_review" : "eligible") : "outside_window",
      },
      refundEstimate: {
        amountCents: transaction.payment.amountCents,
        pointsToRestore: transaction.outcome.finalQuote.pointsUsed ?? 0,
        currency: "HKD",
      },
      pendingAction: status === "USER_CONFIRMATION_REQUIRED" ? {
        type: "after_sales_confirmation",
        actionId: `service_${randomUUID().slice(0, 12)}`,
        requestedAction,
        amountCents: transaction.payment.amountCents,
        expiresAt: new Date(this.clock().getTime() + 15 * 60_000).toISOString(),
        message: "Confirm this sandbox after-sales request. This closes the order and records a simulated refund.",
      } : null,
      outcome: status === "REJECTED" ? {
        type: "rejected",
        reason: { code: "RETURN_WINDOW_EXPIRED", message: "The 14-day after-sales window has expired." },
      } : status === "MANUAL_REVIEW" ? {
        type: "manual_review",
        reason: { code: "MERCHANT_REVIEW_REQUIRED", message: "Returns and exchanges require merchant review because the sandbox has no delivery inspection adapter." },
      } : null,
      audit: [],
    };
    appendCaseAudit(serviceCase, "after_sales_requested", {
      runId,
      orderId: transaction.order.id,
      requestedAction,
      reason,
      knowledgeSources: knowledgeEvidence.map((item) => item.source),
    }, createdAt);
    appendCaseAudit(serviceCase, "after_sales_eligibility_checked", serviceCase.eligibility, createdAt);
    if (serviceCase.pendingAction) {
      appendCaseAudit(serviceCase, "after_sales_confirmation_requested", {
        actionId: serviceCase.pendingAction.actionId,
        amountCents: serviceCase.pendingAction.amountCents,
        expiresAt: serviceCase.pendingAction.expiresAt,
      }, createdAt);
    }
    this.cases.set(serviceCase.id, serviceCase);
    return this.commit(serviceCase);
  }

  resume(id, { actionId, decision }) {
    const serviceCase = this.requireCase(id);
    if (serviceCase.status !== "USER_CONFIRMATION_REQUIRED" || serviceCase.pendingAction?.actionId !== actionId) {
      const error = new Error("The after-sales action is stale, already used, or belongs to another case");
      error.statusCode = 409;
      error.code = "AFTER_SALES_ACTION_NOT_CURRENT";
      throw error;
    }
    if (this.clock().getTime() >= new Date(serviceCase.pendingAction.expiresAt).getTime()) {
      const expiredActionId = serviceCase.pendingAction.actionId;
      serviceCase.status = "EXPIRED";
      serviceCase.pendingAction = null;
      serviceCase.outcome = {
        type: "expired",
        reason: { code: "AFTER_SALES_ACTION_EXPIRED", message: "The after-sales confirmation expired before it was used." },
      };
      appendCaseAudit(serviceCase, "after_sales_confirmation_expired", { actionId: expiredActionId }, this.now());
      this.commit(serviceCase);
      const error = new Error(serviceCase.outcome.reason.message);
      error.statusCode = 410;
      error.code = serviceCase.outcome.reason.code;
      throw error;
    }

    appendCaseAudit(serviceCase, "after_sales_confirmation_received", { actionId, decision }, this.now());
    serviceCase.pendingAction = null;
    if (decision === "reject") {
      serviceCase.status = "CANCELLED";
      serviceCase.outcome = {
        type: "cancelled",
        reason: { code: "USER_REJECTED_AFTER_SALES", message: "The user did not confirm the after-sales request." },
      };
      appendCaseAudit(serviceCase, "after_sales_cancelled", { reasonCode: serviceCase.outcome.reason.code }, this.now());
      return this.commit(serviceCase);
    }

    serviceCase.status = "REFUND_PENDING";
    appendCaseAudit(serviceCase, "refund_processing_started", {
      amountCents: serviceCase.refundEstimate.amountCents,
      idempotencyKey: `refund-${serviceCase.id}`,
    }, this.now());
    let transaction;
    try {
      transaction = this.transactionService.refundCompletedOrder(serviceCase.transactionSessionId, {
        caseId: serviceCase.id,
        requestedAction: serviceCase.requestedAction,
        reason: serviceCase.reason,
      });
    } catch (error) {
      serviceCase.status = error.code === "ORDER_ALREADY_REFUNDED" ? "REJECTED" : "MANUAL_REVIEW";
      serviceCase.outcome = {
        type: serviceCase.status === "REJECTED" ? "rejected" : "manual_review",
        reason: {
          code: error.code ?? "REFUND_PROCESSING_FAILED",
          message: error.message,
        },
      };
      appendCaseAudit(serviceCase, "refund_processing_failed", {
        code: serviceCase.outcome.reason.code,
        routedTo: serviceCase.status,
      }, this.now());
      this.commit(serviceCase);
      throw error;
    }
    const refund = transaction.afterSales.find((entry) => entry.caseId === serviceCase.id);
    serviceCase.status = "REFUNDED";
    serviceCase.outcome = {
      type: "refunded",
      refund,
      orderStatus: transaction.order.status,
      paymentStatus: transaction.payment.status,
    };
    appendCaseAudit(serviceCase, "refund_completed", {
      refundId: refund.id,
      amountCents: refund.amountCents,
      pointsRestored: refund.pointsRestored,
      orderStatus: transaction.order.status,
    }, this.now());
    return this.commit(serviceCase);
  }
}
