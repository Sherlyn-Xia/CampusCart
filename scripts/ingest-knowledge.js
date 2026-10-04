import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmbeddingProviderFromEnv } from "../src/knowledge/embedding-provider.js";
import { KnowledgeBase } from "../src/knowledge/knowledge-base.js";
import { openSqlitePersistence } from "../src/persistence/sqlite.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run knowledge:ingest -- path/to/documents.json");
  process.exitCode = 1;
} else {
  const databasePath = process.env.CAMPUSCART_DB_PATH || "data/campuscart.sqlite";
  const payload = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  const documents = Array.isArray(payload) ? payload : [payload];
  const persistence = openSqlitePersistence({ databasePath });
  try {
    const knowledgeBase = new KnowledgeBase({
      repository: persistence.knowledge,
      embeddingProvider: createEmbeddingProviderFromEnv(),
      seedDocuments: [],
    });
    const result = await knowledgeBase.ingest(documents);
    console.log(`Ingested ${documents.length} knowledge document(s) and indexed ${result.indexed} embedding chunk(s) into ${persistence.databasePath}`);
  } finally {
    persistence.close();
  }
}
