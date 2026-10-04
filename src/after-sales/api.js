import * as z from "zod";

const CreateCaseSchema = z.object({
  runId: z.string().uuid(),
  requestedAction: z.enum(["cancel_order", "refund", "return", "exchange"]),
  reason: z.string().min(3).max(1000),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();

const ResumeCaseSchema = z.object({
  actionId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
}).strict();

const NaturalLanguageRequestSchema = z.object({
  runId: z.string().uuid(),
  message: z.string().min(3).max(1000),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();

export async function handleAfterSalesApi({ request, response, url, service, sendJson, bodyOf }) {
  if (!url.pathname.startsWith("/api/v1/after-sales/")) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/api/v1/after-sales/capabilities") {
    sendJson(response, 200, service.capabilities());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/after-sales/requests") {
    const input = NaturalLanguageRequestSchema.parse(await bodyOf(request));
    sendJson(response, 201, await service.createCaseFromMessage(input));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/after-sales/cases") {
    const input = CreateCaseSchema.parse(await bodyOf(request));
    sendJson(response, 201, service.createCase(input));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/after-sales/cases") {
    sendJson(response, 200, {
      cases: service.list({
        runId: url.searchParams.get("runId"),
        orderId: url.searchParams.get("orderId"),
      }),
    });
    return true;
  }
  if (parts.slice(0, 4).join("/") !== "api/v1/after-sales/cases" || !parts[4]) return false;
  const caseId = parts[4];
  if (request.method === "GET" && parts.length === 5) {
    sendJson(response, 200, service.snapshot(service.requireCase(caseId)));
    return true;
  }
  if (request.method === "POST" && parts[5] === "resume") {
    sendJson(response, 200, service.resume(caseId, ResumeCaseSchema.parse(await bodyOf(request))));
    return true;
  }
  return false;
}
