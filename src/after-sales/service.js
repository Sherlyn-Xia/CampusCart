import { createHash, randomUUID } from "node:crypto";
import { SandboxMerchantAfterSalesAdapter } from "./adapters/merchant-after-sales.js";
import { SandboxPaymentRefundAdapter } from "./adapters/payment-refund.js";

function clone(value) {
  return structuredClone(value);
}

const ACTIVE_CASE_STATUSES = new Set([
  "USER_CONFIRMATION_REQUIRED",
  "REFUND_PENDING",
  "MANUAL_REVIEW",
  "RETURN_AUTHORIZED",
  "RETURN_RECEIVED",
  "EXCHANGE_AUTHORIZED",
]);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function serviceError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function requireMerchantReceipt(receipt, { operation, orderId, caseId, idempotencyKey, referenceField }) {
  if (receipt?.status !== "succeeded"
    || receipt.operation !== operation
    || receipt.orderId !== orderId
    || receipt.caseId !== caseId
    || receipt.idempotencyKey !== idempotencyKey
    || !receipt.providerId
    || !receipt[referenceField]) {
    throw serviceError("Merchant provider receipt does not match the requested after-sales operation", 502, "INVALID_MERCHANT_PROVIDER_RECEIPT");
  }
  return receipt;
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
  constructor({
    transactionService,
    repository = null,
    knowledgeBase = null,
    paymentRefundAdapter = null,
    merchantAfterSalesAdapter = null,
    clock = () => new Date(),
  } = {}) {
    this.transactionService = transactionService;
    this.repository = repository;
    this.knowledgeBase = knowledgeBase;
    this.clock = clock;
    this.paymentRefundAdapter = paymentRefundAdapter ?? new SandboxPaymentRefundAdapter({ clock });
    this.merchantAfterSalesAdapter = merchantAfterSalesAdapter ?? new SandboxMerchantAfterSalesAdapter({ clock });
    this.cases = new Map((repository?.all() ?? []).map((serviceCase) => [serviceCase.id, serviceCase]));
    this.caseQueues = new Map();
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
      adapters: {
        paymentRefund: this.paymentRefundAdapter.capabilities(),
        merchantAfterSales: this.merchantAfterSalesAdapter.capabilities(),
      },
      operatorWorkflow: {
        authentication: "bearer_api_key",
        routes: "/api/v1/operator/after-sales/cases",
        returnStates: ["MANUAL_REVIEW", "RETURN_AUTHORIZED", "RETURN_RECEIVED", "REFUNDED"],
        exchangeStates: ["MANUAL_REVIEW", "EXCHANGE_AUTHORIZED", "COMPLETED"],
      },
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

  list({ runId = null, orderId = null, status = null } = {}) {
    return [...this.cases.values()]
      .filter((serviceCase) => !runId || serviceCase.runId === runId)
      .filter((serviceCase) => !orderId || serviceCase.orderId === orderId)
      .filter((serviceCase) => !status || serviceCase.status === status)
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
    const idempotencyDigest = idempotencyKey ? digest({ runId, requestedAction, reason }) : null;
    const existing = idempotencyKey
      ? [...this.cases.values()].find((serviceCase) => serviceCase.runId === runId && serviceCase.idempotencyKey === idempotencyKey)
      : null;
    if (existing) {
      if (!existing.idempotencyDigest || existing.idempotencyDigest === idempotencyDigest) return this.snapshot(existing);
      throw serviceError("This idempotency key was already used for a different after-sales request", 409, "IDEMPOTENCY_KEY_REUSED");
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
    if (transaction.state !== "COMPLETED" || transaction.order.status !== "accepted_sandbox") {
      const error = new Error("Only completed orders can enter after-sales service");
      error.statusCode = 409;
      error.code = "ORDER_NOT_SERVICEABLE";
      throw error;
    }
    const activeCase = [...this.cases.values()].find((serviceCase) => serviceCase.orderId === transaction.order.id
      && ACTIVE_CASE_STATUSES.has(serviceCase.status));
    if (activeCase) {
      throw serviceError("This order already has an active after-sales case", 409, "AFTER_SALES_CASE_ALREADY_OPEN");
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
      idempotencyDigest,
      operatorOperations: [],
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

  async runCaseMutation(caseId, execute) {
    const previous = this.caseQueues.get(caseId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.caseQueues.set(caseId, current);
    await previous;
    try {
      return await execute();
    } finally {
      release();
      if (this.caseQueues.get(caseId) === current) this.caseQueues.delete(caseId);
    }
  }

  providerFailure(serviceCase, error, operation, receipt = null) {
    serviceCase.status = "MANUAL_REVIEW";
    serviceCase.outcome = {
      type: "manual_review",
      reason: {
        code: error.code ?? "AFTER_SALES_PROVIDER_FAILED",
        message: error.message,
      },
    };
    appendCaseAudit(serviceCase, "after_sales_provider_failed", {
      operation,
      code: serviceCase.outcome.reason.code,
      providerId: receipt?.providerId ?? null,
      providerReference: receipt?.providerRefundId ?? receipt?.receiptId ?? receipt?.replacementOrderId ?? null,
      routedTo: serviceCase.status,
    }, this.now());
  }

  async runOperatorOperation(caseId, { type, idempotencyKey, payload, operator, execute }) {
    return this.runCaseMutation(caseId, async () => {
      const serviceCase = this.requireCase(caseId);
      if (!operator?.id || operator.role !== "after_sales_operator") {
        throw serviceError("A verified after-sales operator principal is required", 403, "OPERATOR_PRINCIPAL_REQUIRED");
      }
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        throw serviceError("Operator actions require an idempotency key between 8 and 200 characters", 422, "OPERATOR_IDEMPOTENCY_KEY_REQUIRED");
      }
      const operations = serviceCase.operatorOperations ?? [];
      const operationDigest = digest({ type, payload });
      const existing = operations.find((operation) => operation.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.type !== type || existing.requestDigest !== operationDigest) {
          throw serviceError("This operator idempotency key was already used for a different action", 409, "IDEMPOTENCY_KEY_REUSED");
        }
        return this.snapshot(serviceCase);
      }

      await execute(serviceCase);
      const completedAt = this.now();
      serviceCase.operatorOperations = [...operations, {
        id: `operator_op_${randomUUID().slice(0, 12)}`,
        type,
        idempotencyKey,
        requestDigest: operationDigest,
        operator: clone(operator),
        resultingStatus: serviceCase.status,
        completedAt,
      }];
      appendCaseAudit(serviceCase, "operator_operation_recorded", {
        type,
        idempotencyKey,
        operator: clone(operator),
        resultingStatus: serviceCase.status,
      }, completedAt);
      return this.commit(serviceCase);
    });
  }

  async review(id, { decision, note = null, idempotencyKey }, operator) {
    return this.runOperatorOperation(id, {
      type: "manual_review",
      idempotencyKey,
      payload: { decision, note },
      operator,
      execute: async (serviceCase) => {
        if (serviceCase.status !== "MANUAL_REVIEW") {
          throw serviceError("This case is not awaiting manual review", 409, "AFTER_SALES_STATE_CONFLICT");
        }
        if (!["return", "exchange"].includes(serviceCase.requestedAction)) {
          throw serviceError("This case type cannot be decided by an operator", 409, "AFTER_SALES_ACTION_NOT_REVIEWABLE");
        }
        appendCaseAudit(serviceCase, "operator_review_decided", {
          decision,
          note,
          operator: clone(operator),
        }, this.now());
        if (decision === "reject") {
          serviceCase.status = "REVIEW_REJECTED";
          serviceCase.outcome = {
            type: "review_rejected",
            reason: { code: "OPERATOR_REJECTED", message: note || "The operator rejected this after-sales request." },
            operator: clone(operator),
          };
          appendCaseAudit(serviceCase, "operator_review_rejected", {
            reasonCode: serviceCase.outcome.reason.code,
            operator: clone(operator),
          }, this.now());
          return;
        }
        if (serviceCase.requestedAction === "return") {
          let receipt;
          try {
            receipt = await this.merchantAfterSalesAdapter.authorizeReturn({
              orderId: serviceCase.orderId,
              caseId: serviceCase.id,
              idempotencyKey: `return-authorization-${serviceCase.id}`,
              reason: serviceCase.reason,
            });
            requireMerchantReceipt(receipt, {
              operation: "authorize_return",
              orderId: serviceCase.orderId,
              caseId: serviceCase.id,
              idempotencyKey: `return-authorization-${serviceCase.id}`,
              referenceField: "authorizationId",
            });
          } catch (error) {
            this.providerFailure(serviceCase, error, "authorize_return", receipt);
            return;
          }
          const authorizedAt = this.now();
          serviceCase.status = "RETURN_AUTHORIZED";
          serviceCase.returnAuthorization = {
            id: receipt.authorizationId,
            status: "awaiting_return",
            authorizedAt,
            providerReceipt: clone(receipt),
            disclaimer: receipt.disclaimer,
          };
          serviceCase.outcome = {
            type: "return_authorized",
            returnAuthorization: clone(serviceCase.returnAuthorization),
          };
          appendCaseAudit(serviceCase, "return_authorized", {
            returnAuthorizationId: serviceCase.returnAuthorization.id,
            providerId: receipt.providerId,
            operator: clone(operator),
          }, authorizedAt);
          return;
        }
        let receipt;
        try {
          receipt = await this.merchantAfterSalesAdapter.authorizeExchange({
            orderId: serviceCase.orderId,
            caseId: serviceCase.id,
            idempotencyKey: `exchange-authorization-${serviceCase.id}`,
            reason: serviceCase.reason,
          });
          requireMerchantReceipt(receipt, {
            operation: "authorize_exchange",
            orderId: serviceCase.orderId,
            caseId: serviceCase.id,
            idempotencyKey: `exchange-authorization-${serviceCase.id}`,
            referenceField: "authorizationId",
          });
        } catch (error) {
          this.providerFailure(serviceCase, error, "authorize_exchange", receipt);
          return;
        }
        const authorizedAt = this.now();
        serviceCase.status = "EXCHANGE_AUTHORIZED";
        serviceCase.exchangeAuthorization = {
          id: receipt.authorizationId,
          status: "awaiting_replacement",
          authorizedAt,
          providerReceipt: clone(receipt),
          disclaimer: receipt.disclaimer,
        };
        serviceCase.outcome = {
          type: "exchange_authorized",
          exchangeAuthorization: clone(serviceCase.exchangeAuthorization),
        };
        appendCaseAudit(serviceCase, "exchange_authorized", {
          exchangeAuthorizationId: serviceCase.exchangeAuthorization.id,
          providerId: receipt.providerId,
          operator: clone(operator),
        }, authorizedAt);
      },
    });
  }

  async processRefund(serviceCase, requestedAction = serviceCase.requestedAction) {
    serviceCase.status = "REFUND_PENDING";
    appendCaseAudit(serviceCase, "refund_processing_started", {
      amountCents: serviceCase.refundEstimate.amountCents,
      idempotencyKey: `refund-${serviceCase.id}`,
    }, this.now());
    let transaction;
    let providerReceipt;
    try {
      const beforeRefund = this.transactionService.snapshot(this.transactionService.requireSession(serviceCase.transactionSessionId));
      providerReceipt = await this.paymentRefundAdapter.refund({
        paymentId: beforeRefund.payment.id,
        amountCents: serviceCase.refundEstimate.amountCents,
        currency: serviceCase.refundEstimate.currency,
        idempotencyKey: `refund-${serviceCase.id}`,
        caseId: serviceCase.id,
        orderId: serviceCase.orderId,
        reason: serviceCase.reason,
      });
      if (providerReceipt?.status !== "succeeded") throw serviceError("Payment provider did not complete the refund", 502, "PAYMENT_REFUND_PROVIDER_FAILED");
      appendCaseAudit(serviceCase, "refund_provider_succeeded", {
        providerId: providerReceipt.providerId,
        providerRefundId: providerReceipt.providerRefundId,
        amountCents: providerReceipt.amountCents,
        idempotencyKey: providerReceipt.idempotencyKey,
      }, this.now());
      transaction = this.transactionService.refundCompletedOrder(serviceCase.transactionSessionId, {
        caseId: serviceCase.id,
        requestedAction,
        reason: serviceCase.reason,
        providerReceipt,
      });
    } catch (error) {
      this.providerFailure(serviceCase, error, "refund", providerReceipt);
      return this.commit(serviceCase);
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
      providerId: refund.providerReceipt.providerId,
      providerRefundId: refund.providerReceipt.providerRefundId,
      amountCents: refund.amountCents,
      pointsRestored: refund.pointsRestored,
      orderStatus: transaction.order.status,
    }, this.now());
  }

  async receiveReturn(id, { note = null, idempotencyKey }, operator) {
    return this.runOperatorOperation(id, {
      type: "receive_return",
      idempotencyKey,
      payload: { note },
      operator,
      execute: async (serviceCase) => {
        if (serviceCase.status !== "RETURN_AUTHORIZED") {
          throw serviceError("This case is not awaiting a returned item", 409, "AFTER_SALES_STATE_CONFLICT");
        }
        let receipt;
        try {
          receipt = await this.merchantAfterSalesAdapter.recordReturnReceived({
            orderId: serviceCase.orderId,
            caseId: serviceCase.id,
            authorizationId: serviceCase.returnAuthorization.id,
            idempotencyKey: `return-received-${serviceCase.id}`,
            note,
          });
          requireMerchantReceipt(receipt, {
            operation: "record_return_received",
            orderId: serviceCase.orderId,
            caseId: serviceCase.id,
            idempotencyKey: `return-received-${serviceCase.id}`,
            referenceField: "receiptId",
          });
        } catch (error) {
          this.providerFailure(serviceCase, error, "record_return_received", receipt);
          return;
        }
        const receivedAt = this.now();
        serviceCase.status = "RETURN_RECEIVED";
        serviceCase.returnAuthorization = {
          ...serviceCase.returnAuthorization,
          status: "received_sandbox",
          receivedAt,
          receipt: clone(receipt),
        };
        appendCaseAudit(serviceCase, "return_received", {
          returnAuthorizationId: serviceCase.returnAuthorization.id,
          providerId: receipt.providerId,
          receiptId: receipt.receiptId,
          note,
          operator: clone(operator),
        }, receivedAt);
        await this.processRefund(serviceCase, "return");
      },
    });
  }

  async completeExchange(id, { replacementOrderId = null, note = null, idempotencyKey }, operator) {
    return this.runOperatorOperation(id, {
      type: "complete_exchange",
      idempotencyKey,
      payload: { replacementOrderId, note },
      operator,
      execute: async (serviceCase) => {
        if (serviceCase.status !== "EXCHANGE_AUTHORIZED") {
          throw serviceError("This case is not awaiting an exchange replacement", 409, "AFTER_SALES_STATE_CONFLICT");
        }
        let merchantReceipt;
        try {
          merchantReceipt = await this.merchantAfterSalesAdapter.createReplacement({
            orderId: serviceCase.orderId,
            caseId: serviceCase.id,
            authorizationId: serviceCase.exchangeAuthorization.id,
            replacementOrderId,
            idempotencyKey: `exchange-${serviceCase.id}`,
            note,
          });
          requireMerchantReceipt(merchantReceipt, {
            operation: "create_replacement",
            orderId: serviceCase.orderId,
            caseId: serviceCase.id,
            idempotencyKey: `exchange-${serviceCase.id}`,
            referenceField: "replacementOrderId",
          });
        } catch (error) {
          this.providerFailure(serviceCase, error, "create_replacement", merchantReceipt);
          return;
        }
        const transaction = this.transactionService.recordExchange(serviceCase.transactionSessionId, {
          caseId: serviceCase.id,
          replacementOrderId: merchantReceipt.replacementOrderId,
          reason: serviceCase.reason,
          merchantReceipt,
        });
        const exchange = transaction.afterSales.find((entry) => entry.caseId === serviceCase.id);
        serviceCase.status = "COMPLETED";
        serviceCase.exchangeAuthorization = {
          ...serviceCase.exchangeAuthorization,
          status: "replacement_created_sandbox",
          completedAt: exchange.completedAt,
          replacementOrderId: exchange.replacementOrderId,
          merchantReceipt: clone(merchantReceipt),
        };
        serviceCase.outcome = {
          type: "exchange_completed",
          exchange,
          orderStatus: transaction.order.status,
        };
        appendCaseAudit(serviceCase, "exchange_completed", {
          exchangeId: exchange.id,
          replacementOrderId: exchange.replacementOrderId,
          providerId: merchantReceipt.providerId,
          note,
          operator: clone(operator),
        }, this.now());
      },
    });
  }

  async resume(id, { actionId, decision }) {
    return this.runCaseMutation(id, async () => {
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

      await this.processRefund(serviceCase);
      return this.commit(serviceCase);
    });
  }
}
