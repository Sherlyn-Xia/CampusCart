import { MockIdentityAdapter } from "./mock-identity.js";
import { MockMerchantAdapter } from "./mock-merchant.js";
import { MockPaymentAdapter } from "./mock-payment.js";

export class AdapterRegistry {
  constructor({ merchants, identity, payment } = {}) {
    this.merchants = merchants ?? [new MockMerchantAdapter()];
    this.identity = identity ?? new MockIdentityAdapter();
    this.payment = payment ?? new MockPaymentAdapter();
  }

  registerMerchant(adapter) {
    if (!adapter?.id || typeof adapter.fetchQuotes !== "function") throw new TypeError("Invalid merchant adapter");
    this.merchants.push(adapter);
  }

  async searchProducts(input) {
    return (await Promise.all(this.merchants.map((adapter) => adapter.searchProducts(input)))).flat();
  }

  async fetchQuotes(input) {
    return (await Promise.all(this.merchants.map((adapter) => adapter.fetchQuotes(input)))).flat();
  }

  capabilities() {
    return {
      merchantAdapters: this.merchants.map(({ id }) => ({ id, status: "sandbox" })),
      identityAdapter: { id: this.identity.id, status: "sandbox" },
      paymentAdapter: { id: this.payment.id, status: "sandbox_and_future_interfaces" },
    };
  }
}
