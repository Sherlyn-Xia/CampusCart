import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import * as z from "zod";
import { createAgentTools, parseFallbackIntent } from "./tools.js";

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((item) => item.text ?? "").join("\n");
  return "";
}

function refersToSelectedProduct(message) {
  return /这台|这个(?:商品|产品|设备)|已选(?:商品|产品)|this\s+(?:item|product|device)|selected\s+(?:item|product)/i.test(message);
}

export class AgentCoordinator {
  constructor({ store, adapters, transactionService, forceFallback = false } = {}) {
    this.store = store;
    this.adapters = adapters;
    this.transactionService = transactionService;
    this.forceFallback = forceFallback;
  }

  hasModel() {
    return !this.forceFallback && Boolean(process.env.OPENAI_API_KEY);
  }

  mode() {
    return this.hasModel() ? "langchain_llm_tools" : "langgraph_deterministic_fallback";
  }

  async discover(runId, message) {
    const tools = createAgentTools({
      runId,
      store: this.store,
      adapters: this.adapters,
      transactionService: this.transactionService,
    });
    const intent = parseFallbackIntent(message);
    const run = this.store.require(runId);
    const [searchProducts, fetchQuotes, inspectIdentity, listPayments, evaluateOptions] = tools;
    const productLanguage = intent.product.language;

    if (productLanguage.accessory || productLanguage.negated) {
      const error = new Error(productLanguage.accessory
        ? "The request targets an iPad accessory, not the supported demo iPad SKU."
        : "The request explicitly negates the supported iPad, so CampusCart will not substitute it.");
      error.statusCode = 422;
      error.code = "UNSUPPORTED_PRODUCT";
      throw error;
    }
    if ((productLanguage.deictic && !productLanguage.supportedProductMention && !run.request.context?.selectedProduct)
      || productLanguage.ambiguousQuantity
      || productLanguage.ambiguousSpecification) {
      const reason = productLanguage.deictic && !productLanguage.supportedProductMention && !run.request.context?.selectedProduct
        ? { code: "PRODUCT_CONTEXT_REQUIRED", message: "“Buy this” requires an explicit, user-confirmed selectedProduct context." }
        : productLanguage.ambiguousQuantity
          ? { code: "AMBIGUOUS_QUANTITY", message: "Confirm a quantity of exactly one for this single-SKU demo." }
          : { code: "AMBIGUOUS_PRODUCT_SPEC", message: "Confirm the exact supported SKU before purchase." };
      return {
        intent,
        needsClarification: true,
        outcome: {
          type: "needs_clarification",
          reason,
          paymentSubmitted: false,
        },
        proposal: {
          summary: reason.message,
          plan: null,
          alternativePlans: [],
          merchantQuotes: [],
          identity: null,
          paymentMethods: [],
          intent,
        },
      };
    }

    // Establish the exact product before the model runs. A model cannot substitute an
    // unsupported request with the demo SKU. Deictic requests such as “buy this item”
    // may use an explicit, user-confirmed product-page context.
    await searchProducts.invoke({ query: intent.rawText });
    if (!run.internal.toolContext.products?.length && run.request.context?.selectedProduct && refersToSelectedProduct(message)) {
      await searchProducts.invoke({ query: run.request.context.selectedProduct.sku });
    }
    const selectedProduct = run.internal.toolContext.products?.[0];
    if (!selectedProduct) {
      const error = new Error("No supported exact product matched the request. Select the demo product explicitly or name the supported iPad/tablet SKU.");
      error.statusCode = 422;
      error.code = "UNSUPPORTED_PRODUCT";
      throw error;
    }
    if (run.request.context?.selectedProduct
      && run.request.context.selectedProduct.sku !== selectedProduct.sku) {
      const error = new Error("The natural-language product does not match the user-confirmed selectedProduct SKU.");
      error.statusCode = 422;
      error.code = "PRODUCT_CONTEXT_MISMATCH";
      throw error;
    }
    run.internal.toolContext.authoritativeProduct = selectedProduct;
    intent.product.sku = selectedProduct.sku;
    intent.product.userConfirmed = Boolean(
      run.request.context?.selectedProduct?.userConfirmed
      && run.request.context.selectedProduct.sku === selectedProduct.sku,
    );

    if (this.hasModel()) {
      this.store.append(runId, "model_invocation_started", {
        provider: "openai_via_langchain",
        model: process.env.CAMPUSCART_AGENT_MODEL ?? "gpt-6-astra",
      });
      try {
        const configuration = process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : undefined;
        const model = new ChatOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.CAMPUSCART_AGENT_MODEL ?? "gpt-6-astra",
          temperature: 0,
          configuration,
        });
        const agent = createAgent({
          model,
          tools,
          systemPrompt: [
            "You are the CampusCart shopping-intent agent.",
            "For a purchase request, call the catalog, quote, identity, payment-method, and deterministic evaluation tools.",
            "Never claim that a future_integration payment method works.",
            "Never authorize, create a Benefit Lock, or pay. Those require explicit human approval outside your tool set.",
            "Never invent a budget. A null budget means compare-only and must not be replaced by a default.",
            "Treat allowed payment methods as hard constraints and preferred methods as soft preferences.",
            "Use integer HKD cents for tool arguments. Ground the final explanation only in tool results.",
          ].join(" "),
        });
        const result = await agent.invoke({ messages: [{ role: "user", content: message }] });
        run.internal.toolContext.agentResponse = messageText(result.messages?.at(-1));
        this.store.append(runId, "model_invocation_completed", { status: "completed" });
      } catch (error) {
        this.store.append(runId, "model_invocation_failed", { error: error.message, fallback: true });
        this.store.update(runId, { agentMode: "langgraph_fallback_after_model_error" });
      }
    }

    // Deterministically fill required evidence after the model. The model may choose
    // tools and explain them, but it cannot replace the validated SKU, identity check,
    // or policy values used by the transaction core.
    const context = run.internal.toolContext;
    const sku = context.authoritativeProduct.sku;
    if (!context.quotes?.length || context.quotes.some((quote) => quote.sku !== sku)) await fetchQuotes.invoke({ sku });
    if (!context.identity) await inspectIdentity.invoke({});
    await evaluateOptions.invoke({
      budgetCents: intent.constraints.budgetCents,
      allowPoints: intent.constraints.allowPoints,
      maxPoints: intent.constraints.maxPoints,
      paymentMethodIds: intent.constraints.allowedPaymentMethodIds
        ?? this.transactionService.getBootstrap().scenarios.success.paymentMethodIds,
    });
    const recommended = context.evaluation.plans.find((plan) => plan.id === context.evaluation.recommendedPlanId);
    if (!recommended) {
      const failure = {
        code: "NO_EXECUTABLE_PLAN",
        message: "No verified purchase plan fits the requested product, eligibility, payment and budget constraints.",
      };
      const blocked = this.transactionService.blockBeforeAuthorization(context.transactionSessionId, failure);
      return {
        intent,
        transactionSessionId: context.transactionSessionId,
        recommendedPlanId: undefined,
        noExecutablePlan: true,
        outcome: blocked.outcome,
        proposal: {
          summary: failure.message,
          plan: null,
          alternativePlans: context.evaluation.plans,
          merchantQuotes: context.quotes,
          identity: context.identity,
          paymentMethods: [],
          intent,
        },
      };
    }
    if (!context.paymentMethods) await listPayments.invoke({
      merchantId: recommended.merchantId,
      amountCents: recommended.cashOutCents,
    });

    if (intent.missingFields.includes("constraints.budgetCents")) {
      const reason = intent.evidence.budget.status === "invalid"
        ? { code: "BUDGET_FORMAT_UNCLEAR", message: "The budget format could not be confirmed. Use a value such as HK$99, HK$99.5, or HK$3,600.50." }
        : { code: "BUDGET_REQUIRED_FOR_AUTHORIZATION", message: "No spending cap was provided. The comparison is available, but purchase authorization is disabled." };
      const clarified = this.transactionService.requireClarification(context.transactionSessionId, reason);
      return {
        intent,
        transactionSessionId: context.transactionSessionId,
        recommendedPlanId: context.evaluation.recommendedPlanId,
        needsClarification: true,
        outcome: clarified.outcome,
        proposal: {
          summary: reason.message,
          plan: recommended,
          alternativePlans: context.evaluation.plans.filter((plan) => plan.id !== recommended.id),
          merchantQuotes: context.quotes,
          identity: context.identity,
          paymentMethods: context.paymentMethods,
          intent,
          comparisonOnly: true,
        },
      };
    }

    return {
      intent,
      transactionSessionId: context.transactionSessionId,
      recommendedPlanId: context.evaluation.recommendedPlanId,
      proposal: {
        summary: context.agentResponse || `Recommended ${recommended.merchant} at HK$${(recommended.cashOutCents / 100).toFixed(2)} after deterministic checks.`,
        plan: recommended,
        alternativePlans: context.evaluation.plans.filter((plan) => plan.id !== recommended.id),
        merchantQuotes: context.quotes,
        identity: context.identity,
        paymentMethods: context.paymentMethods,
        intent,
      },
    };
  }

  model() {
    const configuration = process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : undefined;
    return new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.CAMPUSCART_AGENT_MODEL ?? "gpt-6-astra",
      temperature: 0,
      configuration,
    });
  }

  async answer(runId, question) {
    const run = this.store.require(runId);
    const transaction = run.transactionSessionId ? this.transactionService.snapshot(run.transactionSessionId) : null;
    const facts = {
      runStatus: run.status,
      recommendedPlan: run.proposal?.plan ?? null,
      alternatives: run.proposal?.alternativePlans ?? [],
      outcome: run.outcome,
      transactionState: transaction?.state ?? null,
      auditEventTypes: transaction?.audit?.map((event) => event.type) ?? [],
    };

    if (this.hasModel()) {
      try {
        const inspect = tool(async () => {
          this.store.append(runId, "tool_call_started", { tool: "inspect_current_decision", input: {} });
          this.store.append(runId, "tool_call_completed", { tool: "inspect_current_decision", resultSummary: { status: run.status } });
          return JSON.stringify(facts);
        }, {
          name: "inspect_current_decision",
          description: "Read the authoritative recommendation, outcome, transaction state and audit event types for this run.",
          schema: z.object({}),
        });
        this.store.append(runId, "model_invocation_started", { purpose: "grounded_question_answer" });
        const agent = createAgent({
          model: this.model(),
          tools: [inspect],
          systemPrompt: "Answer CampusCart questions only from inspect_current_decision. Call it before answering. If facts are missing, say so. Never claim a real payment or provider integration.",
        });
        const result = await agent.invoke({ messages: [{ role: "user", content: question }] });
        this.store.append(runId, "model_invocation_completed", { purpose: "grounded_question_answer" });
        return messageText(result.messages?.at(-1));
      } catch (error) {
        this.store.append(runId, "model_invocation_failed", {
          purpose: "grounded_question_answer",
          error: error.message,
          fallback: true,
        });
      }
    }

    if (/为什么|why.*(block|stop)|blocked/i.test(question) && run.outcome?.type === "blocked") {
      return `${run.outcome.reason.code}: ${run.outcome.reason.message}`;
    }
    if (/为什么|why.*(choose|chosen|recommend)/i.test(question) && run.proposal?.plan) {
      const plan = run.proposal.plan;
      return `${plan.merchant} was recommended because its verified reference cost is HK$${(plan.referenceCostCents / 100).toFixed(2)}, the lowest eligible result returned by the deterministic rule engine.`;
    }
    return "No LLM is configured. I can currently explain the recommended plan or a recorded block reason from deterministic evidence.";
  }
}
