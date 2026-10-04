import { createHash, timingSafeEqual } from "node:crypto";

function unauthorized(message = "A valid operator Bearer token is required") {
  return Object.assign(new Error(message), {
    statusCode: 401,
    code: "OPERATOR_UNAUTHORIZED",
  });
}

function tokenDigest(value) {
  return createHash("sha256").update(value).digest();
}

export function createOperatorAuthenticator({
  apiKey = process.env.CAMPUSCART_OPERATOR_API_KEY ?? "",
  operatorId = process.env.CAMPUSCART_OPERATOR_ID ?? "sandbox-operator",
  role = "after_sales_operator",
} = {}) {
  const configuredKey = typeof apiKey === "string" ? apiKey : "";
  const expectedDigest = tokenDigest(configuredKey);

  return {
    configured: configuredKey.length > 0,
    authenticate(request) {
      if (!configuredKey) {
        throw Object.assign(new Error("Operator authentication is not configured"), {
          statusCode: 503,
          code: "OPERATOR_AUTH_NOT_CONFIGURED",
        });
      }
      const authorization = Array.isArray(request.headers?.authorization)
        ? request.headers.authorization[0]
        : request.headers?.authorization;
      const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
      const supplied = match?.[1] ?? "";
      const matches = timingSafeEqual(tokenDigest(supplied), expectedDigest);
      if (!match || !matches) throw unauthorized();
      return Object.freeze({ id: operatorId, role });
    },
  };
}
