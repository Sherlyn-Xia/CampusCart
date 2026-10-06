import * as z from "zod";

const IdempotencyKey = z.string().min(8).max(200);

const ReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().min(1).max(1000).optional(),
  idempotencyKey: IdempotencyKey,
}).strict();

const ReceiveReturnSchema = z.object({
  note: z.string().min(1).max(1000).optional(),
  idempotencyKey: IdempotencyKey,
}).strict();

const CompleteExchangeSchema = z.object({
  replacementOrderId: z.string().min(1).max(200).optional(),
  note: z.string().min(1).max(1000).optional(),
  idempotencyKey: IdempotencyKey,
}).strict();

export async function handleOperatorApi({ request, response, url, service, authenticator, sendJson, bodyOf }) {
  if (!url.pathname.startsWith("/api/v1/operator/")) return false;
  const operator = authenticator.authenticate(request);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/v1/operator/after-sales/cases") {
    sendJson(response, 200, {
      operator,
      cases: service.list({
        runId: url.searchParams.get("runId"),
        orderId: url.searchParams.get("orderId"),
        status: url.searchParams.get("status"),
      }),
    });
    return true;
  }

  if (parts.slice(0, 5).join("/") !== "api/v1/operator/after-sales/cases" || !parts[5]) return false;
  const caseId = parts[5];
  if (request.method === "GET" && parts.length === 6) {
    sendJson(response, 200, { operator, case: service.snapshot(service.requireCase(caseId)) });
    return true;
  }
  if (request.method === "POST" && parts[6] === "review") {
    sendJson(response, 200, await service.review(caseId, ReviewSchema.parse(await bodyOf(request)), operator));
    return true;
  }
  if (request.method === "POST" && parts[6] === "receive-return") {
    sendJson(response, 200, await service.receiveReturn(caseId, ReceiveReturnSchema.parse(await bodyOf(request)), operator));
    return true;
  }
  if (request.method === "POST" && parts[6] === "complete-exchange") {
    sendJson(response, 200, await service.completeExchange(caseId, CompleteExchangeSchema.parse(await bodyOf(request)), operator));
    return true;
  }
  return false;
}
