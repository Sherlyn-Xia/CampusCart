import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const SCHEMA_VERSION = 5;

function parsePayload(row) {
  return row ? JSON.parse(row.payload_json) : null;
}

function prepareDatabasePath(databasePath) {
  if (databasePath === ":memory:") return databasePath;
  const resolved = resolve(databasePath);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function migrate(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS campuscart_schema (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated
      ON agent_runs(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS transaction_sessions (
      id TEXT PRIMARY KEY,
      owner_run_id TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_owner
      ON transaction_sessions(owner_run_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_state_updated
      ON transaction_sessions(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS payment_authorization_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      transaction_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_authorization_run
      ON payment_authorization_sessions(run_id);

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      version TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      UNIQUE(document_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
      ON knowledge_chunks(document_id, ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chunk_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_model
      ON knowledge_embeddings(model);

    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      outcome_type TEXT NOT NULL,
      intent_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_intent_outcome
      ON memory_episodes(intent_key, outcome_type, created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_feedback (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      rating TEXT NOT NULL CHECK (rating IN ('helpful', 'unhelpful')),
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_feedback_run
      ON memory_feedback(run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS after_sales_cases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      transaction_session_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_after_sales_run
      ON after_sales_cases(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_after_sales_order
      ON after_sales_cases(order_id, created_at DESC);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO campuscart_schema(version, applied_at)
    VALUES (?, ?)
  `).run(SCHEMA_VERSION, new Date().toISOString());
}

class AgentRunRepository {
  constructor(db) {
    this.db = db;
    this.selectAll = db.prepare("SELECT payload_json FROM agent_runs ORDER BY created_at");
    this.selectOne = db.prepare("SELECT payload_json FROM agent_runs WHERE id = ?");
    this.upsert = db.prepare(`
      INSERT INTO agent_runs(id, thread_id, status, created_at, updated_at, payload_json)
      VALUES (@id, @threadId, @status, @createdAt, @updatedAt, @payload)
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
  }

  all() {
    return this.selectAll.all().map(parsePayload);
  }

  get(id) {
    return parsePayload(this.selectOne.get(id));
  }

  save(run) {
    this.upsert.run({
      id: run.id,
      threadId: run.threadId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      payload: JSON.stringify(run),
    });
  }
}

class TransactionRepository {
  constructor(db) {
    this.db = db;
    this.selectAll = db.prepare("SELECT payload_json FROM transaction_sessions ORDER BY created_at");
    this.selectOne = db.prepare("SELECT payload_json FROM transaction_sessions WHERE id = ?");
    this.upsert = db.prepare(`
      INSERT INTO transaction_sessions(id, owner_run_id, state, created_at, updated_at, payload_json)
      VALUES (@id, @ownerRunId, @state, @createdAt, @updatedAt, @payload)
      ON CONFLICT(id) DO UPDATE SET
        owner_run_id = excluded.owner_run_id,
        state = excluded.state,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
  }

  all() {
    return this.selectAll.all().map(parsePayload);
  }

  get(id) {
    return parsePayload(this.selectOne.get(id));
  }

  save(session) {
    const updatedAt = session.audit.at(-1)?.at ?? session.createdAt;
    this.upsert.run({
      id: session.id,
      ownerRunId: session.ownerRunId ?? null,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt,
      payload: JSON.stringify(session),
    });
  }
}

class PaymentAuthorizationRepository {
  constructor(db) {
    this.db = db;
    this.selectAll = db.prepare("SELECT payload_json FROM payment_authorization_sessions");
    this.selectOne = db.prepare("SELECT payload_json FROM payment_authorization_sessions WHERE id = ?");
    this.upsert = db.prepare(`
      INSERT INTO payment_authorization_sessions(
        id, run_id, transaction_session_id, status, expires_at, updated_at, payload_json
      ) VALUES (
        @id, @runId, @transactionSessionId, @status, @expiresAt, @updatedAt, @payload
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
  }

  all() {
    return this.selectAll.all().map(parsePayload);
  }

  get(id) {
    return parsePayload(this.selectOne.get(id));
  }

  save(session) {
    this.upsert.run({
      id: session.id,
      runId: session.runId,
      transactionSessionId: session.transactionSessionId,
      status: session.status,
      expiresAt: session.action.expiresAt,
      updatedAt: session.authenticatedAt ?? new Date().toISOString(),
      payload: JSON.stringify(session),
    });
  }
}

function lexicalTokens(query) {
  const normalized = query.toLowerCase().normalize("NFKC");
  const stopwords = new Set(["the", "and", "for", "this", "that", "with", "from", "have", "what", "why", "how"]);
  const ascii = (normalized.match(/[a-z0-9][a-z0-9_-]+/g) ?? [])
    .filter((token) => token.length >= 3 && !stopwords.has(token));
  const cjk = [...normalized].filter((character) => /[\p{Script=Han}]/u.test(character));
  const cjkPairs = cjk.slice(0, -1).map((character, index) => character + cjk[index + 1]);
  return [...new Set([...ascii, ...cjkPairs])].filter((token) => token.length > 1).slice(0, 24);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

class KnowledgeRepository {
  constructor(db) {
    this.db = db;
    this.documentCount = db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents");
    this.selectDocument = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?");
    this.selectChunks = db.prepare(`
      SELECT c.id, c.document_id, c.ordinal, c.content, c.metadata_json,
             d.title, d.source, d.category, d.version
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
      ORDER BY d.id, c.ordinal
    `);
    this.ftsSearch = db.prepare(`
      SELECT chunk_id FROM knowledge_chunks_fts
      WHERE knowledge_chunks_fts MATCH ?
      ORDER BY bm25(knowledge_chunks_fts)
      LIMIT ?
    `);
    this.pendingEmbeddings = db.prepare(`
      SELECT c.id, c.content
      FROM knowledge_chunks c
      LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.id AND e.model = ?
      WHERE e.chunk_id IS NULL
      ORDER BY c.id
    `);
    this.selectEmbeddings = db.prepare(`
      SELECT c.id, c.document_id, c.ordinal, c.content, c.metadata_json,
             d.title, d.source, d.category, d.version,
             e.dimensions, e.vector_json
      FROM knowledge_embeddings e
      JOIN knowledge_chunks c ON c.id = e.chunk_id
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE e.model = ?
      ORDER BY c.id
    `);
    this.embeddingCount = db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_embeddings WHERE model = ?
    `);
    this.upsertEmbeddings = db.transaction((model, entries) => {
      const statement = this.db.prepare(`
        INSERT INTO knowledge_embeddings(chunk_id, model, dimensions, vector_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id, model) DO UPDATE SET
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at
      `);
      const now = new Date().toISOString();
      for (const entry of entries) {
        if (!Array.isArray(entry.vector) || !entry.vector.length || entry.vector.some((value) => !Number.isFinite(value))) {
          throw new TypeError("Embedding vectors must be non-empty arrays of finite numbers");
        }
        statement.run(entry.chunkId, model, entry.vector.length, JSON.stringify(entry.vector), now);
      }
    });
    this.replaceDocument = db.transaction((document) => {
      const now = new Date().toISOString();
      const existing = this.selectDocument.get(document.id);
      this.db.prepare(`
        INSERT INTO knowledge_documents(id, title, source, category, version, metadata_json, created_at, updated_at)
        VALUES (@id, @title, @source, @category, @version, @metadata, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          source = excluded.source,
          category = excluded.category,
          version = excluded.version,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run({
        id: document.id,
        title: document.title,
        source: document.source,
        category: document.category,
        version: document.version ?? "1",
        metadata: JSON.stringify(document.metadata ?? {}),
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });
      const oldChunkIds = this.db.prepare("SELECT id FROM knowledge_chunks WHERE document_id = ?").all(document.id);
      const deleteFts = this.db.prepare("DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?");
      for (const chunk of oldChunkIds) deleteFts.run(chunk.id);
      this.db.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(document.id);
      const insertChunk = this.db.prepare(`
        INSERT INTO knowledge_chunks(id, document_id, ordinal, content, metadata_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare("INSERT INTO knowledge_chunks_fts(chunk_id, content) VALUES (?, ?)");
      document.chunks.forEach((chunk, ordinal) => {
        const id = `${document.id}:${ordinal}`;
        const content = typeof chunk === "string" ? chunk : chunk.content;
        const metadata = typeof chunk === "string" ? {} : chunk.metadata ?? {};
        insertChunk.run(id, document.id, ordinal, content, JSON.stringify(metadata));
        insertFts.run(id, content);
      });
    });
  }

  count() {
    return this.documentCount.get().count;
  }

  versionOf(id) {
    return this.selectDocument.get(id)?.version ?? null;
  }

  upsert(document) {
    if (!document?.id || !document?.title || !document?.source || !document?.category || !document?.chunks?.length) {
      throw new TypeError("A knowledge document needs id, title, source, category and at least one chunk");
    }
    this.replaceDocument(document);
  }

  search(query, { limit = 4, category = null } = {}) {
    const tokens = lexicalTokens(query);
    const asciiTokens = tokens.filter((token) => /^[a-z0-9_-]+$/.test(token));
    const ftsIds = new Set();
    if (asciiTokens.length) {
      const expression = asciiTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
      for (const row of this.ftsSearch.all(expression, Math.max(limit * 3, 10))) ftsIds.add(row.chunk_id);
    }
    const normalizedQuery = query.toLowerCase().normalize("NFKC");
    return this.selectChunks.all()
      .filter((row) => !category || row.category === category)
      .map((row) => {
        const haystack = `${row.title} ${row.category} ${row.content}`.toLowerCase().normalize("NFKC");
        let score = ftsIds.has(row.id) ? 5 : 0;
        if (haystack.includes(normalizedQuery)) score += 12;
        for (const token of tokens) if (haystack.includes(token)) score += token.length >= 4 ? 3 : 1;
        return { row, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.row.ordinal - right.row.ordinal)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: row.id,
        documentId: row.document_id,
        title: row.title,
        source: row.source,
        category: row.category,
        version: row.version,
        content: row.content,
        metadata: JSON.parse(row.metadata_json),
        score,
      }));
  }

  chunksMissingEmbeddings(model) {
    return this.pendingEmbeddings.all(model);
  }

  saveEmbeddings(model, entries) {
    if (!model || !entries?.length) return;
    this.upsertEmbeddings(model, entries);
  }

  embeddingStats(model) {
    return { model, chunkCount: model ? this.embeddingCount.get(model).count : 0 };
  }

  searchVector(queryVector, { model, limit = 4, category = null } = {}) {
    return this.selectEmbeddings.all(model)
      .filter((row) => !category || row.category === category)
      .map((row) => ({ row, score: cosineSimilarity(queryVector, JSON.parse(row.vector_json)) }))
      .filter(({ score }) => score > -1)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: row.id,
        documentId: row.document_id,
        title: row.title,
        source: row.source,
        category: row.category,
        version: row.version,
        content: row.content,
        metadata: JSON.parse(row.metadata_json),
        score,
      }));
  }
}

class MemoryRepository {
  constructor(db) {
    this.db = db;
    this.upsert = db.prepare(`
      INSERT INTO memory_episodes(id, run_id, outcome_type, intent_key, created_at, payload_json)
      VALUES (@id, @runId, @outcomeType, @intentKey, @createdAt, @payload)
      ON CONFLICT(run_id) DO UPDATE SET
        outcome_type = excluded.outcome_type,
        intent_key = excluded.intent_key,
        payload_json = excluded.payload_json
    `);
    this.byIntent = db.prepare(`
      SELECT payload_json FROM memory_episodes
      WHERE intent_key = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.recent = db.prepare(`
      SELECT payload_json FROM memory_episodes
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.byRun = db.prepare("SELECT payload_json FROM memory_episodes WHERE run_id = ?");
    this.byId = db.prepare("SELECT payload_json FROM memory_episodes WHERE id = ?");
    this.insertFeedback = db.prepare(`
      INSERT INTO memory_feedback(id, memory_id, run_id, rating, note, created_at)
      VALUES (@id, @memoryId, @runId, @rating, @note, @createdAt)
    `);
    this.selectFeedback = db.prepare(`
      SELECT id, memory_id AS memoryId, run_id AS runId, rating, note, created_at AS createdAt
      FROM memory_feedback WHERE run_id = ? ORDER BY created_at
    `);
  }

  save(episode) {
    this.upsert.run({
      id: episode.id,
      runId: episode.runId,
      outcomeType: episode.outcomeType,
      intentKey: episode.intentKey,
      createdAt: episode.createdAt,
      payload: JSON.stringify(episode),
    });
  }

  find({ intentKey = null, limit = 3 } = {}) {
    const rows = intentKey ? this.byIntent.all(intentKey, Math.max(limit * 3, 10)) : this.recent.all(Math.max(limit * 3, 10));
    return rows.map(parsePayload)
      .filter((episode) => episode.quality?.status !== "rejected")
      .slice(0, limit);
  }

  getByRunId(runId) {
    return parsePayload(this.byRun.get(runId));
  }

  markRetrieved(memoryIds, at = new Date().toISOString()) {
    for (const memoryId of memoryIds) {
      const row = this.byId.get(memoryId);
      const episode = parsePayload(row);
      if (!episode) continue;
      episode.usage = {
        retrievalCount: (episode.usage?.retrievalCount ?? 0) + 1,
        lastRetrievedAt: at,
      };
      this.save(episode);
    }
  }

  addFeedback({ id, runId, rating, note = null, createdAt }) {
    const episode = this.getByRunId(runId);
    if (!episode) return null;
    episode.feedback = [...(episode.feedback ?? []), { id, rating, note, createdAt }];
    episode.quality = {
      status: rating === "helpful" ? "verified" : "rejected",
      score: rating === "helpful" ? 1 : 0,
      source: "user_feedback",
      updatedAt: createdAt,
    };
    this.save(episode);
    this.insertFeedback.run({ id, memoryId: episode.id, runId, rating, note, createdAt });
    return episode;
  }

  feedbackForRun(runId) {
    return this.selectFeedback.all(runId);
  }
}

class AfterSalesRepository {
  constructor(db) {
    this.db = db;
    this.selectAll = db.prepare("SELECT payload_json FROM after_sales_cases ORDER BY created_at");
    this.selectOne = db.prepare("SELECT payload_json FROM after_sales_cases WHERE id = ?");
    this.upsert = db.prepare(`
      INSERT INTO after_sales_cases(
        id, run_id, transaction_session_id, order_id, status, requested_action,
        created_at, updated_at, payload_json
      ) VALUES (
        @id, @runId, @transactionSessionId, @orderId, @status, @requestedAction,
        @createdAt, @updatedAt, @payload
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
  }

  all() {
    return this.selectAll.all().map(parsePayload);
  }

  get(id) {
    return parsePayload(this.selectOne.get(id));
  }

  save(serviceCase) {
    this.upsert.run({
      id: serviceCase.id,
      runId: serviceCase.runId,
      transactionSessionId: serviceCase.transactionSessionId,
      orderId: serviceCase.orderId,
      status: serviceCase.status,
      requestedAction: serviceCase.requestedAction,
      createdAt: serviceCase.createdAt,
      updatedAt: serviceCase.updatedAt,
      payload: JSON.stringify(serviceCase),
    });
  }
}

export function openSqlitePersistence({ databasePath = "data/campuscart.sqlite" } = {}) {
  const resolvedPath = prepareDatabasePath(databasePath);
  const checkpointer = SqliteSaver.fromConnString(resolvedPath);
  const db = checkpointer.db;
  migrate(db);
  let closed = false;
  return {
    databasePath: resolvedPath,
    checkpointer,
    runs: new AgentRunRepository(db),
    transactions: new TransactionRepository(db),
    paymentAuthorizations: new PaymentAuthorizationRepository(db),
    knowledge: new KnowledgeRepository(db),
    memories: new MemoryRepository(db),
    afterSales: new AfterSalesRepository(db),
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
