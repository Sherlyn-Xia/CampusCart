import { createHash } from "node:crypto";

function stableId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function requireInput(value, name) {
  if (typeof value !== "string" || !value) {
    throw Object.assign(new Error(`${name} is required`), { code: "MERCHANT_AFTER_SALES_ADAPTER_INVALID_REQUEST" });
  }
}

export class MerchantAfterSalesAdapter {
  capabilities() {
    throw new Error("MerchantAfterSalesAdapter.capabilities() must be implemented");
  }

  async authorizeReturn() {
    throw new Error("MerchantAfterSalesAdapter.authorizeReturn() must be implemented");
  }

  async authorizeExchange() {
    throw new Error("MerchantAfterSalesAdapter.authorizeExchange() must be implemented");
  }

  async recordReturnReceived() {
    throw new Error("MerchantAfterSalesAdapter.recordReturnReceived() must be implemented");
  }

  async createReplacement() {
    throw new Error("MerchantAfterSalesAdapter.createReplacement() must be implemented");
  }
}

export class SandboxMerchantAfterSalesAdapter extends MerchantAfterSalesAdapter {
  constructor({ clock = () => new Date() } = {}) {
    super();
    this.clock = clock;
  }

  capabilities() {
    return {
      providerId: "campuscart-sandbox-merchant",
      mode: "sandbox",
      supports: ["return_authorization", "exchange_authorization", "return_receipt", "replacement_order"],
      shipsRealItems: false,
    };
  }

  receipt({ operation, idempotencyKey, fields = {} }) {
    requireInput(idempotencyKey, "idempotencyKey");
    return {
      providerId: "campuscart-sandbox-merchant",
      operation,
      status: "succeeded",
      idempotencyKey,
      processedAt: this.clock().toISOString(),
      disclaimer: "Sandbox merchant receipt. No parcel will be shipped.",
      ...fields,
    };
  }

  async authorizeReturn({ orderId, caseId, idempotencyKey }) {
    requireInput(orderId, "orderId");
    requireInput(caseId, "caseId");
    return this.receipt({
      operation: "authorize_return",
      idempotencyKey,
      fields: { orderId, caseId, authorizationId: stableId("rma", idempotencyKey) },
    });
  }

  async authorizeExchange({ orderId, caseId, idempotencyKey }) {
    requireInput(orderId, "orderId");
    requireInput(caseId, "caseId");
    return this.receipt({
      operation: "authorize_exchange",
      idempotencyKey,
      fields: { orderId, caseId, authorizationId: stableId("exchange_auth", idempotencyKey) },
    });
  }

  async recordReturnReceived({ orderId, caseId, authorizationId, idempotencyKey }) {
    requireInput(orderId, "orderId");
    requireInput(caseId, "caseId");
    requireInput(authorizationId, "authorizationId");
    return this.receipt({
      operation: "record_return_received",
      idempotencyKey,
      fields: { orderId, caseId, authorizationId, receiptId: stableId("return_receipt", idempotencyKey) },
    });
  }

  async createReplacement({ orderId, caseId, replacementOrderId = null, idempotencyKey }) {
    requireInput(orderId, "orderId");
    requireInput(caseId, "caseId");
    return this.receipt({
      operation: "create_replacement",
      idempotencyKey,
      fields: {
        orderId,
        caseId,
        replacementOrderId: replacementOrderId || stableId("replacement_order", idempotencyKey),
      },
    });
  }
}
