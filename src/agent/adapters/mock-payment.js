import { randomUUID } from "node:crypto";

const method = (methodId, displayName, methodType, integrationStatus, actionType) => ({
  methodId,
  displayName,
  methodType,
  integrationStatus,
  actionType,
  requiresUserAuthentication: true,
  supportedMerchantIds: ["campus-demo-store", "harbour-tech-sandbox", "unimall-demo"],
  disclaimer: integrationStatus === "sandbox"
    ? "Local sandbox adapter only; no financial network is connected."
    : "Interface placeholder only; provider access and capabilities are not claimed.",
});

export class MockPaymentAdapter {
  constructor({ clock = () => new Date() } = {}) {
    this.id = "campuscart-payment-orchestrator";
    this.kind = "payment";
    this.sessions = new Map();
    this.clock = clock;
  }

  async listAvailableMethods({ merchantId }) {
    return [
      method("mock-tap-go", "Tap & Go · Sandbox", "wallet", "sandbox", "redirect"),
      method("mock-campus-wallet", "Campus Wallet · Sandbox", "wallet", "sandbox", "redirect"),
      method("credit-card", "Credit card", "card", "future_integration", "sdk_token"),
      method("wechat-pay", "WeChat Pay", "wallet", "future_integration", "redirect"),
      method("alipay-hk", "AlipayHK / Alipay", "wallet", "future_integration", "redirect"),
      method("octopus", "Octopus", "stored_value", "future_integration", "app_deep_link"),
    ].filter((option) => option.supportedMerchantIds.includes(merchantId));
  }

  async createAuthorizationSession({ runId, transactionSessionId, paymentMethodId, amountCents, actionId }) {
    const option = (await this.listAvailableMethods({ merchantId: "campus-demo-store" }))
      .find((candidate) => candidate.methodId === paymentMethodId);
    if (!option || option.integrationStatus !== "sandbox") {
      const error = new Error("Selected payment method has no executable sandbox adapter");
      error.code = "PAYMENT_ADAPTER_UNAVAILABLE";
      throw error;
    }
    const id = `pauth_${randomUUID().slice(0, 12)}`;
    const session = {
      id,
      runId,
      transactionSessionId,
      paymentMethodId,
      amountCents,
      providerId: this.id,
      status: "requires_user_action",
      action: {
        type: "payment_authentication",
        actionId,
        url: `/sandbox/payment-auth/${id}?runId=${encodeURIComponent(runId)}&actionId=${encodeURIComponent(actionId)}`,
        expiresAt: new Date(this.clock().getTime() + 10 * 60_000).toISOString(),
      },
    };
    this.sessions.set(id, session);
    return structuredClone(session);
  }

  async confirmAuthorization(id, decision, binding) {
    const session = this.sessions.get(id);
    if (!session) {
      const error = new Error("Payment authorization session not found");
      error.code = "PAYMENT_SESSION_NOT_FOUND";
      throw error;
    }
    if (session.runId !== binding.runId
      || session.transactionSessionId !== binding.transactionSessionId
      || session.action.actionId !== binding.actionId) {
      const error = new Error("Payment session, run and action binding do not match");
      error.code = "PAYMENT_ACTION_BINDING_MISMATCH";
      throw error;
    }
    if (this.clock().getTime() >= new Date(session.action.expiresAt).getTime()) {
      const error = new Error("Payment authentication action has expired");
      error.code = "ACTION_EXPIRED";
      throw error;
    }
    if (decision !== "authenticated") return { ...session, status: "failed" };
    session.status = "authorized";
    session.authenticatedAt = this.clock().toISOString();
    session.externalPaymentId = `pay_agent_${randomUUID().slice(0, 10)}`;
    return structuredClone(session);
  }
}
