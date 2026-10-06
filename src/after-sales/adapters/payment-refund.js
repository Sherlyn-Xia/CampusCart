import { createHash } from "node:crypto";

function stableId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function adapterError(message, code = "PAYMENT_REFUND_ADAPTER_INVALID_REQUEST") {
  return Object.assign(new Error(message), { code });
}

export class PaymentRefundAdapter {
  capabilities() {
    throw new Error("PaymentRefundAdapter.capabilities() must be implemented");
  }

  async refund() {
    throw new Error("PaymentRefundAdapter.refund() must be implemented");
  }
}

export class SandboxPaymentRefundAdapter extends PaymentRefundAdapter {
  constructor({ clock = () => new Date() } = {}) {
    super();
    this.clock = clock;
  }

  capabilities() {
    return {
      providerId: "campuscart-sandbox-refunds",
      mode: "sandbox",
      supports: ["refund"],
      movesRealFunds: false,
    };
  }

  async refund({ paymentId, amountCents, currency = "HKD", idempotencyKey }) {
    if (typeof paymentId !== "string" || !paymentId) throw adapterError("A paymentId is required for a refund");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw adapterError("Refund amount must be a positive integer in cents");
    if (typeof idempotencyKey !== "string" || !idempotencyKey) throw adapterError("A refund idempotency key is required");
    return {
      providerId: "campuscart-sandbox-refunds",
      providerRefundId: stableId("refund", idempotencyKey),
      paymentId,
      status: "succeeded",
      amountCents,
      currency,
      idempotencyKey,
      processedAt: this.clock().toISOString(),
      disclaimer: "Sandbox provider receipt. No real funds moved.",
    };
  }
}
