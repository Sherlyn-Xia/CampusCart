import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeBase } from "../src/knowledge/knowledge-base.js";
import { openSqlitePersistence } from "../src/persistence/sqlite.js";

class FakeEmbeddingProvider {
  constructor() {
    this.enabled = true;
    this.id = "fake-semantic-v1";
    this.documentCalls = 0;
  }

  vector(text) {
    const value = text.toLowerCase();
    if (/reversal|regret|changed my mind/.test(value)) return [1, 0];
    if (/student|identity/.test(value)) return [0, 1];
    return [0.5, 0.5];
  }

  async embedDocuments(texts) {
    this.documentCalls += 1;
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text) {
    return this.vector(text);
  }

  capabilities() {
    return { enabled: true, provider: "fake", model: this.id, dimensions: 2 };
  }
}

const documents = [
  {
    id: "merchant-reversal",
    title: "Merchant reversal procedure",
    source: "test://merchant-reversal",
    category: "after_sales",
    version: "1",
    chunks: ["A reversal closes the captured sandbox payment after a separate human confirmation."],
  },
  {
    id: "identity-proof",
    title: "Identity evidence",
    source: "test://identity-proof",
    category: "identity",
    version: "1",
    chunks: ["Student identity status is read from the minimum verified adapter response."],
  },
];

test("hybrid RAG persists vectors and finds semantic matches without lexical overlap", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "campuscart-knowledge-"));
  const databasePath = join(directory, "campuscart.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));

  let persistence = openSqlitePersistence({ databasePath });
  let provider = new FakeEmbeddingProvider();
  let knowledge = new KnowledgeBase({
    repository: persistence.knowledge,
    embeddingProvider: provider,
    seedDocuments: documents,
  });
  const results = await knowledge.retrieve("I regret buying it", { limit: 1 });
  assert.equal(results[0].source, "test://merchant-reversal");
  assert.equal(results[0].retrieval.strategy, "hybrid");
  assert.equal(persistence.knowledge.embeddingStats(provider.id).chunkCount, 2);
  assert.equal(provider.documentCalls, 1);
  persistence.close();

  persistence = openSqlitePersistence({ databasePath });
  provider = new FakeEmbeddingProvider();
  knowledge = new KnowledgeBase({
    repository: persistence.knowledge,
    embeddingProvider: provider,
    seedDocuments: documents,
  });
  const restoredResults = await knowledge.retrieve("I regret buying it", { limit: 1 });
  assert.equal(restoredResults[0].source, "test://merchant-reversal");
  assert.equal(provider.documentCalls, 0);
  persistence.close();
});

test("RAG falls back to lexical results when the embedding provider fails", async () => {
  const persistence = openSqlitePersistence({ databasePath: ":memory:" });
  const provider = {
    enabled: true,
    id: "failing-provider",
    embedDocuments: async () => { throw new Error("provider unavailable"); },
    embedQuery: async () => { throw new Error("provider unavailable"); },
    capabilities: () => ({ enabled: true, provider: "fake", model: "failing-provider", dimensions: 2 }),
  };
  const knowledge = new KnowledgeBase({
    repository: persistence.knowledge,
    embeddingProvider: provider,
    seedDocuments: documents,
  });
  const results = await knowledge.retrieve("reversal procedure", { limit: 1 });
  assert.equal(results[0].source, "test://merchant-reversal");
  assert.equal(results[0].retrieval.strategy, "lexical_fallback");
  assert.equal(knowledge.capabilities().embedding.lastError, "provider unavailable");
  persistence.close();
});
