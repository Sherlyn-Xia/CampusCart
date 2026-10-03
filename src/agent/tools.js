import { tool } from "langchain";
import * as z from "zod";

function json(value) {
  return JSON.stringify(value);
}

function tracedTool(runId, store, name, description, schema, handler) {
  return tool(async (input) => {
    store.append(runId, "tool_call_started", { tool: name, input });
    try {
      const output = await handler(input);
      store.append(runId, "tool_call_completed", {
        tool: name,
        resultSummary: Array.isArray(output) ? { count: output.length } : { status: output?.status ?? "ok" },
      });
      return json(output);
    } catch (error) {
      store.append(runId, "tool_call_failed", { tool: name, error: error.message });
      throw error;
    }
  }, { name, description, schema });
}

export function createAgentTools({ runId, store, adapters, transactionService }) {
  const run = store.require(runId);
  const context = run.internal.toolContext;

  return [
    tracedTool(runId, store, "search_supported_products",
      "Search the CampusCart supported catalog for the exact product requested by the user. Read-only.",
      z.object({ query: z.string() }),
      async ({ query }) => {
        context.products = await adapters.searchProducts({ query });
        return context.products;
      }),

    tracedTool(runId, store, "fetch_merchant_quotes",
      "Fetch normalized, time-bound quotes for an exact supported SKU from all registered merchant adapters. Read-only.",
      z.object({ sku: z.string() }),
      async ({ sku }) => {
        context.quotes = await adapters.fetchQuotes({ sku });
        return context.quotes;
      }),

    tracedTool(runId, store, "inspect_student_eligibility",
      "Read the minimum student eligibility status. Never requests or returns a student number or document image.",
      z.object({}),
      async () => {
        context.identity = await adapters.identity.getStatus();
        return context.identity;
      }),

    tracedTool(runId, store, "list_payment_methods",
      "List payment methods exposed by the payment adapter registry. A future_integration item is not executable.",
      z.object({ merchantId: z.string(), amountCents: z.number().int().nonnegative() }),
      async ({ merchantId, amountCents }) => {
        context.paymentMethods = await adapters.payment.listAvailableMethods({ merchantId, amountCents });
        return context.paymentMethods;
      }),

    tracedTool(runId, store, "evaluate_checkout_options",
      "Run the deterministic CampusCart rule engine. This tool may create an evaluation session but cannot authorize, lock, or pay.",
      z.object({
        budgetCents: z.number().int().nonnegative().nullable(),
        allowPoints: z.boolean(),
        maxPoints: z.number().int().nonnegative(),
        paymentMethodIds: z.array(z.string()).optional(),
      }),
      async (policy) => {
        if (!context.identity) {
          const error = new Error("Identity status must be checked before deterministic evaluation");
          error.code = "IDENTITY_REQUIRED";
          throw error;
        }
        if (!context.transactionSessionId) {
          const session = transactionService.createSession({
            scenario: run.request.context?.demoScenario ?? "success",
            policy,
            identity: context.identity,
            channel: "agent",
            ownerRunId: runId,
          });
          context.transactionSessionId = session.id;
        }
        const session = transactionService.evaluate(context.transactionSessionId, policy);
        context.evaluation = session.evaluation;
        store.update(runId, { transactionSessionId: session.id });
        return session.evaluation;
      }),
  ];
}

const paymentMatchers = [
  ["credit-card", /信用卡|credit\s*card/i],
  ["wechat-pay", /微信(?:支付)?|wechat(?:\s*pay)?/i],
  ["alipay-hk", /支付宝|alipay(?:hk)?/i],
  ["mock-tap-go", /tap\s*&?\s*go/i],
  ["octopus", /八达通|octopus/i],
];

function amountToCents(raw) {
  const value = raw.trim();
  const validGrouping = /^\d+(?:\.\d{1,2})?$/.test(value)
    || /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(value);
  if (!validGrouping) return null;
  const normalized = value.replaceAll(",", "");
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? { cents, normalized } : null;
}

function parseBudget(message) {
  const budgetMarker = /预算|消费上限|金额上限|budget|\bcap\b/i.test(message);
  const patterns = [
    /(?:预算(?:上限)?|消费上限|金额上限|budget(?:\s*cap)?|\bcap\b)\s*(?:是|为|of|:|=)?\s*(?:HK\$|HKD|港币|港元)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /(?:HK\$|HKD)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:港币|港元)(?:\s*(?:预算|上限))?/i,
  ];
  const match = patterns.map((pattern) => message.match(pattern)).find(Boolean);
  if (!match) {
    return {
      status: budgetMarker ? "invalid" : "missing",
      original: budgetMarker ? message.match(/(?:预算|消费上限|金额上限|budget|\bcap\b)[^，,。;；]*/i)?.[0] ?? null : null,
      normalized: null,
      cents: null,
    };
  }
  const parsed = amountToCents(match[1]);
  return {
    status: parsed ? "parsed" : "invalid",
    original: match[0],
    normalized: parsed?.normalized ?? null,
    cents: parsed?.cents ?? null,
  };
}

export function inspectProductLanguage(message) {
  const accessory = /(?:ipad|平板)(?:电脑)?[^，,。;；]{0,10}(?:保护壳|壳|case|cover|键盘|keyboard|pencil|配件)|(?:保护壳|case|cover|配件)[^，,。;；]{0,10}(?:ipad|平板)/i.test(message);
  const negated = /(?:不要|别|不想|无需|do\s+not|don't|not)\s*(?:买|购买|purchase|buy)?[^，,。;；]{0,8}(?:ipad|平板)/i.test(message);
  const deictic = /这台|这个(?:商品|产品|设备)?|已选(?:商品|产品)|this\s+(?:item|product|device)|selected\s+(?:item|product)/i.test(message);
  const supportedProductMention = /\bipad\b|平板(?:电脑)?|EDU-IPAD-A16-128-SLV/i.test(message);
  const quantityMatch = message.match(/(\d+)\s*(?:台|部|个|units?)/i);
  const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
  const ambiguousQuantity = /(?:几|多台|若干|several|multiple)\s*(?:台|部|个|units?)?/i.test(message) || quantity > 1;
  const ambiguousSpecification = /任意规格|随便(?:什么)?规格|哪个规格|64\s*(?:GB)?\s*(?:或|还是|\/)+\s*128|which\s+(?:model|spec)/i.test(message);
  return { accessory, negated, deictic, supportedProductMention, quantity, ambiguousQuantity, ambiguousSpecification };
}

export function parseFallbackIntent(message) {
  const budget = parseBudget(message);
  const pointsPatterns = [
    /(?:最多|不超过|max(?:imum)?(?: of)?)?\s*(\d{1,5})\s*(?:积分|points?|pts?)/i,
  ];
  const pointsMatch = pointsPatterns.map((pattern) => message.match(pattern)).find(Boolean);
  const denyPoints = /不用积分|不使用积分|禁止使用积分|no points|do not use points/i.test(message);
  const mentionedPayments = paymentMatchers.filter(([, pattern]) => pattern.test(message)).map(([id]) => id);
  const hardPayment = /只能(?:使用|用)?|必须(?:使用|用)?|仅限|only\s+(?:use|pay)|must\s+(?:use|pay)/i.test(message);
  const softPayment = /最好(?:使用|用)?|优先(?:使用|用)?|倾向|prefer(?:ably)?/i.test(message);
  const productLanguage = inspectProductLanguage(message);
  const missingFields = [];
  if (budget.status !== "parsed") missingFields.push("constraints.budgetCents");
  if (productLanguage.ambiguousQuantity) missingFields.push("product.quantity");
  if (productLanguage.ambiguousSpecification) missingFields.push("product.sku");

  return {
    rawText: message,
    product: {
      sku: null,
      quantity: productLanguage.quantity,
      userConfirmed: false,
      language: productLanguage,
    },
    constraints: {
      budgetCents: budget.cents,
      allowedPaymentMethodIds: hardPayment && mentionedPayments.length ? mentionedPayments : null,
      allowPoints: !denyPoints,
      maxPoints: denyPoints ? 0 : Number(pointsMatch?.[1] ?? 100),
      fulfillmentDeadline: null,
    },
    preferences: {
      optimizeFor: "reference_cost",
      preferredPaymentMethodIds: !hardPayment && (softPayment || mentionedPayments.length) ? mentionedPayments : [],
    },
    missingFields,
    evidence: {
      budget: {
        original: budget.original,
        parsedValue: budget.cents,
        normalized: budget.normalized,
        status: budget.status,
      },
    },
  };
}
