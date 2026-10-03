import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TransactionService } from "./domain/transaction-service.js";
import { AgentRuntime } from "./agent/runtime.js";
import { agentApiError, handleAgentApi } from "./agent/api.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body, null, 2));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Request body is too large");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function api(request, response, url, { service, agentRuntime }) {
  if (await handleAgentApi({ request, response, url, runtime: agentRuntime, sendJson, bodyOf })) return;
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

export function createCampusCartServer({ service = new TransactionService(), agentRuntime = null } = {}) {
  const runtime = agentRuntime ?? new AgentRuntime({ transactionService: service });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) return await api(request, response, url, { service, agentRuntime: runtime });
      if (url.pathname.startsWith("/sandbox/payment-auth/")) return await staticFile(response, "/payment-auth.html");
      return await staticFile(response, url.pathname);
    } catch (error) {
      const formatted = agentApiError(error);
      sendJson(response, formatted.statusCode, { error: formatted.message, code: formatted.code, issues: formatted.issues });
    }
  });
  return { agentRuntime: runtime, server, service };
}

const { agentRuntime, server, service } = createCampusCartServer();
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`CampusCart sandbox is running at http://${host}:${server.address().port}`);
  });
}

export { agentRuntime, server, service };
