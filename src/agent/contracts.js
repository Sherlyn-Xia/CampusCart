import * as z from "zod";

export const AgentRunRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  context: z.object({
    locale: z.string().default("zh-HK"),
    currency: z.literal("HKD").default("HKD"),
    demoScenario: z.enum(["success", "blocked"]).default("success"),
    selectedProduct: z.object({
      sku: z.string().min(1),
      source: z.enum(["product_page", "catalog_selection"]),
      userConfirmed: z.literal(true),
    }).strict().optional(),
  }).optional(),
}).strict();

export const ResumeRequestSchema = z.discriminatedUnion("decision", [
  z.object({
    actionId: z.string().min(1),
    decision: z.literal("approve"),
    planId: z.string().min(1).optional(),
  }).strict(),
  z.object({ actionId: z.string().min(1), decision: z.literal("reject") }).strict(),
  z.object({
    actionId: z.string().min(1),
    decision: z.enum(["authenticated", "failed"]),
    paymentSessionId: z.string().min(1),
  }).strict(),
]);

export const AgentMessageRequestSchema = z.object({
  message: z.string().min(1).max(2000),
}).strict();

export const PurchaseIntentSchema = z.object({
  rawText: z.string(),
  product: z.object({
    sku: z.string().nullable(),
    quantity: z.number().int().positive(),
    userConfirmed: z.boolean(),
    language: z.record(z.string(), z.unknown()),
  }),
  constraints: z.object({
    budgetCents: z.number().int().nonnegative().nullable(),
    allowedPaymentMethodIds: z.array(z.string()).nullable(),
    allowPoints: z.boolean(),
    maxPoints: z.number().int().nonnegative(),
    fulfillmentDeadline: z.string().nullable(),
  }),
  preferences: z.object({
    optimizeFor: z.literal("reference_cost"),
    preferredPaymentMethodIds: z.array(z.string()),
  }),
  missingFields: z.array(z.string()),
  evidence: z.object({
    budget: z.object({
      original: z.string().nullable(),
      parsedValue: z.number().int().nonnegative().nullable(),
      normalized: z.string().nullable(),
      status: z.enum(["parsed", "missing", "invalid"]),
    }),
  }),
});

export const PaymentMethodOptionSchema = z.object({
  methodId: z.string(),
  displayName: z.string(),
  methodType: z.enum(["card", "wallet", "stored_value"]),
  integrationStatus: z.enum(["sandbox", "future_integration", "unavailable"]),
  actionType: z.enum(["redirect", "qr_code", "app_deep_link", "sdk_token", "not_available"]),
  requiresUserAuthentication: z.boolean(),
  supportedMerchantIds: z.array(z.string()),
  disclaimer: z.string(),
});

export function publicRun(run) {
  if (!run) return null;
  const { internal, ...safe } = structuredClone(run);
  return safe;
}
