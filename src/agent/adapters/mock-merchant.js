import { offers, product, purchasePaths } from "../../domain/seed.js";

export class MockMerchantAdapter {
  constructor() {
    this.id = "campuscart-sandbox-merchants";
    this.kind = "merchant";
  }

  async searchProducts({ query }) {
    const normalized = query.toLowerCase();
    const matched = ["ipad", "tablet", "a16", "平板", "学生设备"].some((term) => normalized.includes(term));
    return matched || !query ? [{ ...product, source: "sandbox", adapterId: this.id }] : [];
  }

  async fetchQuotes({ sku }) {
    if (sku !== product.sku) return [];
    return purchasePaths.map((path) => ({
      quoteId: `quote-${path.id}`,
      merchantId: path.merchantId,
      merchantName: path.merchant,
      sku: path.sku,
      currency: "HKD",
      productCents: path.productCents,
      shippingCents: path.shippingCents,
      offerRefs: path.appliedOfferIds.map((id) => {
        const offer = offers.find((candidate) => candidate.id === id);
        return { id, version: offer?.version ?? "unknown" };
      }),
      paymentMethodId: path.paymentMethodId,
      fulfillment: path.fulfillment,
      verificationStatus: "verified_demo",
      source: "sandbox",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }));
  }
}
