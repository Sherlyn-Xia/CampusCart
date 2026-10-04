import { defaultKnowledgeDocuments } from "./default-documents.js";

function mergeHybrid(lexical, semantic, limit) {
  const merged = new Map();
  lexical.forEach((result, index) => {
    merged.set(result.id, {
      ...result,
      retrieval: { strategy: "hybrid", lexicalRank: index + 1, semanticRank: null },
      hybridScore: 0.45 / (index + 1),
    });
  });
  semantic.forEach((result, index) => {
    const current = merged.get(result.id) ?? {
      ...result,
      retrieval: { strategy: "hybrid", lexicalRank: null, semanticRank: index + 1 },
      hybridScore: 0,
    };
    current.retrieval.semanticRank = index + 1;
    current.retrieval.semanticSimilarity = result.score;
    current.hybridScore += 0.55 / (index + 1);
    merged.set(result.id, current);
  });
  return [...merged.values()]
    .sort((left, right) => right.hybridScore - left.hybridScore)
    .slice(0, limit)
    .map(({ hybridScore, ...result }) => ({ ...result, score: hybridScore }));
}

export class KnowledgeBase {
  constructor({ repository, embeddingProvider = null, seedDocuments = defaultKnowledgeDocuments } = {}) {
    this.repository = repository;
    this.embeddingProvider = embeddingProvider;
    this.indexing = null;
    this.lastEmbeddingError = null;
    if (repository) {
      for (const document of seedDocuments) {
        if (repository.versionOf(document.id) !== (document.version ?? "1")) repository.upsert(document);
      }
    }
  }

  retrieveLexical(query, options = {}) {
    if (!this.repository || !query?.trim()) return [];
    return this.repository.search(query, options);
  }

  async indexPendingEmbeddings() {
    if (!this.repository || !this.embeddingProvider?.enabled) return { indexed: 0 };
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      const pending = this.repository.chunksMissingEmbeddings(this.embeddingProvider.id);
      let indexed = 0;
      for (let offset = 0; offset < pending.length; offset += 64) {
        const batch = pending.slice(offset, offset + 64);
        const vectors = await this.embeddingProvider.embedDocuments(batch.map((chunk) => chunk.content));
        if (vectors.length !== batch.length) throw new Error("Embedding provider returned an unexpected vector count");
        this.repository.saveEmbeddings(this.embeddingProvider.id, batch.map((chunk, index) => ({
          chunkId: chunk.id,
          vector: vectors[index],
        })));
        indexed += batch.length;
      }
      this.lastEmbeddingError = null;
      return { indexed };
    })().catch((error) => {
      this.lastEmbeddingError = error.message;
      throw error;
    }).finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }

  async retrieve(query, options = {}) {
    const limit = options.limit ?? 4;
    const lexical = this.retrieveLexical(query, { ...options, limit: Math.max(limit * 2, 8) });
    if (!this.embeddingProvider?.enabled || !this.repository || !query?.trim()) return lexical.slice(0, limit);
    try {
      await this.indexPendingEmbeddings();
      const queryVector = await this.embeddingProvider.embedQuery(query);
      const semantic = this.repository.searchVector(queryVector, {
        model: this.embeddingProvider.id,
        category: options.category ?? null,
        limit: Math.max(limit * 2, 8),
      });
      return mergeHybrid(lexical, semantic, limit);
    } catch (error) {
      this.lastEmbeddingError = error.message;
      return lexical.slice(0, limit).map((result) => ({
        ...result,
        retrieval: { strategy: "lexical_fallback", embeddingError: true },
      }));
    }
  }

  async ingest(documents) {
    if (!this.repository) throw new Error("Knowledge repository is not configured");
    for (const document of documents) this.repository.upsert(document);
    return this.indexPendingEmbeddings();
  }

  capabilities() {
    const embedding = this.embeddingProvider?.capabilities() ?? { enabled: false };
    return {
      enabled: Boolean(this.repository),
      retrieval: embedding.enabled ? "sqlite_hybrid_fts5_vector" : "sqlite_fts5_plus_lexical",
      documentCount: this.repository?.count() ?? 0,
      citations: true,
      embedding: {
        ...embedding,
        indexedChunkCount: embedding.enabled
          ? this.repository?.embeddingStats(this.embeddingProvider.id).chunkCount ?? 0
          : 0,
        lastError: this.lastEmbeddingError,
      },
    };
  }
}
