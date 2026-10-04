import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAfterSalesApi } from "./after-sales/api.js";
import { AfterSalesService } from "./after-sales/service.js";
import { TransactionService } from "./domain/transaction-service.js";
import { AgentRuntime } from "./agent/runtime.js";
import { AgentRunStore } from "./agent/run-store.js";
import { AdapterRegistry } from "./agent/adapters/registry.js";
import { MockPaymentAdapter } from "./agent/adapters/mock-payment.js";
import { ExperienceMemory } from "./agent/experience-memory.js";
import { agentApiError, handleAgentApi } from "./agent/api.js";
import { KnowledgeBase } from "./knowledge/knowledge-base.js";
import { createEmbeddingProviderFromEnv } from "./knowledge/embedding-provider.js";
import { openSqlitePersistence } from "./persistence/sqlite.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body, null, 2));
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Request body is too large"), { statusCode: 413, code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400, code: "INVALID_JSON" });
  }
}

async function api(request, response, url, { service, agentRuntime, afterSalesService }) {
  if (await handleAgentApi({ request, response, url, runtime: agentRuntime, sendJson, bodyOf })) return;
  if (await handleAfterSalesApi({ request, response, url, service: afterSalesService, sendJson, bodyOf })) return;
  if (request.method === "GET" && url.pathname === "/api/bootstrap") return sendJson(response, 200, service.getBootstrap());
  if (url.pathname === "/api/sessions" || url.pathname.startsWith("/api/sessions/")) {
    return sendJson(response, 410, {
      error: "Legacy transaction mutations are retired. Use /api/v1/agent/runs so human authorization cannot be bypassed.",
      code: "LEGACY_TRANSACTION_API_RETIRED",
    });
  }
  return sendJson(response, 404, { error: "API route not found" });
}

async function staticFile(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDirectory, safePath);
  try {
    const data = await readFile(filePath);
    response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
    response.end(data);
  } catch (error) {
    if (extname(pathname)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } else {
      const data = await readFile(join(publicDirectory, "index.html"));
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(data);
    }
  }
}

export function createCampusCartServer({ service = null, agentRuntime = null, persistence = null } = {}) {
  const transactionService = service ?? new TransactionService({ repository: persistence?.transactions });
  const knowledgeBase = persistence ? new KnowledgeBase({
    repository: persistence.knowledge,
    embeddingProvider: createEmbeddingProviderFromEnv(),
  }) : null;
  const experienceMemory = persistence ? new ExperienceMemory({ repository: persistence.memories }) : null;
  const afterSalesService = new AfterSalesService({
    transactionService,
    repository: persistence?.afterSales,
    knowledgeBase,
  });
  const runtime = agentRuntime ?? new AgentRuntime({
    transactionService,
    store: persistence ? new AgentRunStore({ repository: persistence.runs }) : undefined,
    adapters: persistence ? new AdapterRegistry({
      payment: new MockPaymentAdapter({ repository: persistence.paymentAuthorizations }),
    }) : undefined,
    checkpointer: persistence?.checkpointer,
    knowledgeBase,
    experienceMemory,
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      // 前后端分开部署时：设置环境变量 CORS_ORIGIN（例如 http://localhost:5173）即可允许该前端跨域调用 API
      if (process.env.CORS_ORIGIN && url.pathname.startsWith("/api/")) {
        response.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN);
        response.setHeader("access-control-allow-headers", "content-type");
        response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        response.setHeader("vary", "origin");
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (url.pathname.startsWith("/api/")) return await api(request, response, url, {
        service: transactionService,
        agentRuntime: runtime,
        afterSalesService,
      });
      if (url.pathname.startsWith("/sandbox/payment-auth/")) return await staticFile(response, "/payment-auth.html");
      return await staticFile(response, url.pathname);
    } catch (error) {
      const formatted = agentApiError(error);
      sendJson(response, formatted.statusCode, { error: formatted.message, code: formatted.code, issues: formatted.issues });
    }
  });
  return { afterSalesService, agentRuntime: runtime, experienceMemory, knowledgeBase, persistence, server, service: transactionService };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const defaultPersistence = isMain
  ? openSqlitePersistence({ databasePath: process.env.CAMPUSCART_DB_PATH || "data/campuscart.sqlite" })
  : null;
const { agentRuntime, server, service } = createCampusCartServer({ persistence: defaultPersistence });
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`CampusCart sandbox is running at http://${host}:${server.address().port}`);
    console.log(`Persistent Agent state: ${defaultPersistence.databasePath}`);
  });
  const shutdown = () => server.close(() => {
    defaultPersistence.close();
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export { agentRuntime, server, service };
