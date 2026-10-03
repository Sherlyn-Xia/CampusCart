import { ZodError } from "zod";

export async function handleAgentApi({ request, response, url, runtime, sendJson, bodyOf }) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/api/v1/agent/capabilities") {
    sendJson(response, 200, runtime.capabilities());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/agent/runs") {
    sendJson(response, 201, await runtime.createRun(await bodyOf(request)));
    return true;
  }
  if (parts.slice(0, 4).join("/") !== "api/v1/agent/runs" || !parts[4]) return false;

  const runId = parts[4];
  if (request.method === "GET" && parts.length === 5) {
    sendJson(response, 200, runtime.getRun(runId));
    return true;
  }
  if (request.method === "GET" && parts[5] === "trace") {
    sendJson(response, 200, runtime.getTrace(runId));
    return true;
  }
  if (request.method === "GET" && parts[5] === "transaction") {
    sendJson(response, 200, runtime.getTransaction(runId));
    return true;
  }
  if (request.method === "POST" && parts[5] === "resume") {
    sendJson(response, 200, await runtime.resume(runId, await bodyOf(request)));
    return true;
  }
  if (request.method === "POST" && parts[5] === "messages") {
    sendJson(response, 200, await runtime.message(runId, await bodyOf(request)));
    return true;
  }
  if (request.method === "GET" && parts[5] === "events") {
    const run = runtime.getRun(runId);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of run.trace) response.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = runtime.store.subscribe(runId, (event) => response.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`));
    request.on("close", unsubscribe);
    return true;
  }
  return false;
}

export function agentApiError(error) {
  if (error instanceof ZodError) return { statusCode: 422, message: "Invalid Agent API request", issues: error.issues };
  return { statusCode: error.statusCode ?? 500, message: error.message, code: error.code };
}
