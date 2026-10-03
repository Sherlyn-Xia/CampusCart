export class MockIdentityAdapter {
  constructor() {
    this.id = "campuscart-sandbox-identity";
    this.kind = "identity";
  }

  async getStatus() {
    return {
      providerId: this.id,
      studentStatus: "valid",
      credentialStatus: "active",
      requiresUserAction: false,
      dataMinimization: "No student number or document image is stored.",
      source: "sandbox",
    };
  }
}
