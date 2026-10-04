import { createHash } from "node:crypto";
import { OpenAIEmbeddings } from "@langchain/openai";

function positiveInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class OpenAICompatibleEmbeddingProvider {
  constructor({ apiKey, baseURL, model, dimensions, client = null } = {}) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.dimensions = positiveInteger(dimensions);
    this.enabled = Boolean(apiKey && model);
    const endpointFingerprint = createHash("sha256").update(baseURL || "https://api.openai.com/v1").digest("hex").slice(0, 12);
    this.id = this.enabled
      ? `openai-compatible:${endpointFingerprint}:${model}:${this.dimensions ?? "default"}`
      : null;
    this.client = client;
  }

  getClient() {
    if (!this.enabled) throw new Error("Embedding provider is not configured");
    if (!this.client) {
      this.client = new OpenAIEmbeddings({
        apiKey: this.apiKey,
        model: this.model,
        dimensions: this.dimensions,
        configuration: this.baseURL ? { baseURL: this.baseURL } : undefined,
      });
    }
    return this.client;
  }

  embedDocuments(texts) {
    return this.getClient().embedDocuments(texts);
  }

  embedQuery(text) {
    return this.getClient().embedQuery(text);
  }

  capabilities() {
    return {
      enabled: this.enabled,
      provider: "openai_compatible",
      model: this.enabled ? this.model : null,
      dimensions: this.dimensions ?? null,
    };
  }
}

export function createEmbeddingProviderFromEnv(environment = process.env) {
  return new OpenAICompatibleEmbeddingProvider({
    apiKey: environment.CAMPUSCART_EMBEDDING_API_KEY || environment.OPENAI_API_KEY,
    baseURL: environment.CAMPUSCART_EMBEDDING_BASE_URL || environment.OPENAI_BASE_URL,
    model: environment.CAMPUSCART_EMBEDDING_MODEL,
    dimensions: environment.CAMPUSCART_EMBEDDING_DIMENSIONS,
  });
}
