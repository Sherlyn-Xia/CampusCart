import { randomUUID } from "node:crypto";
import { Command, END, MemorySaver, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import * as z from "zod";
import { AgentFeedbackRequestSchema, AgentMessageRequestSchema, AgentRunRequestSchema, ResumeRequestSchema } from "./contracts.js";
import { AgentCoordinator } from "./coordinator.js";
import { AgentRunStore } from "./run-store.js";
import { AdapterRegistry } from "./adapters/registry.js";

const AgentState = new StateSchema({
  runId: z.string(),
  message: z.string(),
  context: z.any().optional(),
  transactionSessionId: z.string().optional(),
  recommendedPlanId: z.string().optional(),
  proposal: z.any().optional(),
  authorizationDecision: z.any().optional(),
  precheckState: z.string().optional(),
  paymentSession: z.any().optional(),
  paymentDecision: z.any().optional(),
  outcome: z.any().optional(),
  noExecutablePlan: z.boolean().optional(),
  needsClarification: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});

export class AgentRuntime {
  constructor({ transactionService, store, adapters, checkpointer = null, knowledgeBase = null, experienceMemory = null, forceFallback = false } = {}) {
    this.transactionService = transactionService;
    this.store = store ?? new AgentRunStore();
    this.adapters = adapters ?? new AdapterRegistry();
    this.knowledgeBase = knowledgeBase;
    this.experienceMemory = experienceMemory;
    this.coordinator = new AgentCoordinator({
      store: this.store,
      adapters: this.adapters,
      transactionService,
      knowledgeBase,
      experienceMemory,
      forceFallback,
    });
    this.checkpointer = checkpointer ?? new MemorySaver();
    this.graph = this.buildGraph();
  }

  buildGraph() {
    const discovery = async (state) => {
      this.store.append(state.runId, "agent_state_transition", { node: "discovery", status: "started" });
      const result = await this.coordinator.discover(state.runId, state.message);
      if (result.noExecutablePlan || result.needsClarification) {
        this.store.update(state.runId, {
          transactionSessionId: result.transactionSessionId ?? null,
          proposal: result.proposal,
        });
        this.store.append(state.runId, "agent_state_transition", {
          node: "discovery",
          status: result.needsClarification ? "needs_clarification" : "blocked",
        });
        return result;
      }
      const transaction = this.transactionService.snapshot(result.transactionSessionId);
      const proposal = {
        ...result.proposal,
        action: {
          actionId: `authorize_${randomUUID().slice(0, 12)}`,
          type: "purchase_authorization",
          message: "Choose and approve one eligible sandbox plan within the spending boundary.",
          planId: result.recommendedPlanId,
          eligiblePlanIds: transaction.evaluation.plans
            .filter((plan) => plan.eligible)
            .map((plan) => plan.id),
          maxPaymentCents: transaction.policy.budgetCents,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
      };
      this.store.update(state.runId, {
        transactionSessionId: result.transactionSessionId,
        proposal,
      });
      this.store.append(state.runId, "agent_state_transition", { node: "discovery", status: "completed" });
      return { ...result, proposal };
    };

    const waitForAuthorization = (state) => {
      const decision = interrupt(state.proposal.action);
      return { authorizationDecision: decision };
    };

    const authorizeAndPrecheck = async (state) => {
      this.store.append(state.runId, "agent_state_transition", { node: "authorize_and_precheck", status: "started" });
      this.transactionService.authorize(state.transactionSessionId, {
        planId: state.authorizationDecision.planId ?? state.recommendedPlanId,
      });
      this.transactionService.createLock(state.transactionSessionId);
      const prepared = this.transactionService.prepareExecution(state.transactionSessionId);
      this.store.append(state.runId, "agent_state_transition", {
        node: "authorize_and_precheck",
        status: prepared.state === "BLOCKED" ? "blocked" : "completed",
        transactionState: prepared.state,
      });
      return { precheckState: prepared.state, outcome: prepared.outcome ?? undefined };
    };

    const preparePayment = async (state) => {
      const transaction = this.transactionService.snapshot(state.transactionSessionId);
      const actionId = `payment_${randomUUID().slice(0, 12)}`;
      const paymentSession = await this.adapters.payment.createAuthorizationSession({
        runId: state.runId,
        transactionSessionId: state.transactionSessionId,
        paymentMethodId: transaction.lock.paymentMethodId,
        amountCents: transaction.pendingExecution.finalQuote.cashOutCents,
        actionId,
      });
      this.store.append(state.runId, "tool_call_completed", {
        tool: "create_payment_authorization_session",
        providerId: paymentSession.providerId,
        paymentMethodId: paymentSession.paymentMethodId,
        status: paymentSession.status,
      });
      return { paymentSession };
    };

    const waitForPayment = (state) => {
      const decision = interrupt({
        ...state.paymentSession.action,
        paymentSessionId: state.paymentSession.id,
        paymentMethodId: state.paymentSession.paymentMethodId,
        amountCents: state.paymentSession.amountCents,
        disclaimer: "Sandbox authentication only. No funds move.",
      });
      return { paymentDecision: decision };
    };

    const completePayment = async (state) => {
      const receipt = await this.adapters.payment.confirmAuthorization(state.paymentSession.id, state.paymentDecision.decision, {
        runId: state.runId,
        transactionSessionId: state.transactionSessionId,
        actionId: state.paymentDecision.actionId,
      });
      this.store.append(state.runId, "tool_call_completed", {
        tool: "confirm_payment_authorization",
        providerId: receipt.providerId,
        status: receipt.status,
      });
      const completed = this.transactionService.completeExternalPayment(state.transactionSessionId, {
        providerId: receipt.providerId,
        externalPaymentId: receipt.externalPaymentId,
        paymentMethodId: receipt.paymentMethodId,
        status: receipt.status,
        authenticatedAt: receipt.authenticatedAt,
        disclaimer: "Sandbox adapter receipt. No real funds moved.",
      });
      return { outcome: completed.outcome };
    };

    const finish = (state) => {
      const outcome = state.outcome;
      const status = outcome?.type === "blocked" ? "blocked"
        : outcome?.type === "success" ? "completed"
          : outcome?.type === "needs_clarification" ? "needs_clarification"
            : outcome?.type === "expired" ? "expired"
              : "cancelled";
      this.store.update(state.runId, { status, outcome: outcome ?? { type: "cancelled" }, pendingAction: null });
      this.store.append(state.runId, "agent_run_finished", { status, outcomeType: outcome?.type ?? "cancelled" });
      return {};
    };

    const cancel = (state) => {
      const reason = state.paymentDecision
        ? { code: "PAYMENT_AUTHENTICATION_FAILED", message: "Payment authentication was declined or cancelled." }
        : { code: "USER_REJECTED", message: "The user rejected the proposed purchase." };
      const transaction = state.transactionSessionId
        ? this.transactionService.cancel(state.transactionSessionId, reason)
        : null;
      return {
        cancelled: true,
        outcome: transaction?.outcome ?? { type: "cancelled", reason, paymentSubmitted: false },
      };
    };

    const reflect = (state) => {
      if (!this.experienceMemory) return {};
      try {
        const run = this.store.require(state.runId);
        const transaction = run.transactionSessionId
          ? this.transactionService.snapshot(run.transactionSessionId)
          : null;
        const episode = this.experienceMemory.record({ run, transaction });
        if (episode) {
          this.store.append(state.runId, "reflection_memory_recorded", {
            memoryId: episode.id,
            outcomeType: episode.outcomeType,
            reasonCodes: episode.reasonCodes,
            evidenceDigest: episode.evidenceDigest,
          });
        }
      } catch (error) {
        // Reflection is advisory and must never turn a completed transaction into a failure.
        this.store.append(state.runId, "reflection_memory_failed", { error: error.message });
      }
      return {};
    };

    return new StateGraph(AgentState)
      .addNode("discovery", discovery)
      .addNode("wait_for_authorization", waitForAuthorization)
      .addNode("authorize_and_precheck", authorizeAndPrecheck)
      .addNode("prepare_payment", preparePayment)
      .addNode("wait_for_payment", waitForPayment)
      .addNode("complete_payment", completePayment)
      .addNode("cancel", cancel)
      .addNode("finish", finish)
      .addNode("reflect", reflect)
      .addEdge(START, "discovery")
      .addConditionalEdges("discovery", (state) => state.noExecutablePlan || state.needsClarification ? "finish" : "authorize", {
        finish: "finish",
        authorize: "wait_for_authorization",
      })
      .addConditionalEdges("wait_for_authorization", (state) => state.authorizationDecision?.decision === "approve" ? "authorize" : "cancel", {
        authorize: "authorize_and_precheck",
        cancel: "cancel",
      })
      .addConditionalEdges("authorize_and_precheck", (state) => state.precheckState === "BLOCKED" ? "finish" : "payment", {
        finish: "finish",
        payment: "prepare_payment",
      })
      .addEdge("prepare_payment", "wait_for_payment")
      .addConditionalEdges("wait_for_payment", (state) => state.paymentDecision?.decision === "authenticated" ? "complete" : "cancel", {
        complete: "complete_payment",
        cancel: "cancel",
      })
      .addEdge("complete_payment", "finish")
      .addEdge("cancel", "finish")
      .addEdge("finish", "reflect")
      .addEdge("reflect", END)
      .compile({ checkpointer: this.checkpointer });
  }

  config(run) {
    return { configurable: { thread_id: run.threadId } };
  }

  syncResult(runId, result) {
    const action = result.__interrupt__?.[0]?.value;
    if (action) {
      this.store.update(runId, { status: "needs_user_action", pendingAction: action });
      this.store.append(runId, "human_action_requested", { type: action.type, actionId: action.actionId });
    }
    this.store.require(runId).internal.graphState = structuredClone(result);
    return this.store.public(runId);
  }

  async createRun(input) {
    const request = AgentRunRequestSchema.parse(input);
    request.context = {
      locale: "zh-HK",
      currency: "HKD",
      demoScenario: "success",
      ...request.context,
    };
    const run = this.store.create(request, this.coordinator.mode());
    try {
      const result = await this.graph.invoke({
        runId: run.id,
        message: request.message,
        context: request.context,
      }, this.config(run));
      return this.syncResult(run.id, result);
    } catch (error) {
      if (run.transactionSessionId) {
        this.transactionService.cancel(run.transactionSessionId, {
          code: "AGENT_DISCOVERY_FAILED",
          message: "Agent discovery failed and its transaction session was closed.",
        });
      }
      this.store.update(run.id, { status: "failed", pendingAction: null });
      this.store.append(run.id, "agent_run_failed", { error: error.message });
      throw error;
    }
  }

  async resume(runId, input) {
    const request = ResumeRequestSchema.parse(input);
    const run = this.store.require(runId);
    if (run.status !== "needs_user_action" || run.pendingAction?.actionId !== request.actionId) {
      const error = new Error("The action is stale, already used, or does not belong to this run");
      error.statusCode = 409;
      error.code = "ACTION_NOT_CURRENT";
      throw error;
    }
    if (new Date(run.pendingAction.expiresAt).getTime() <= Date.now()) {
      const expiredActionType = run.pendingAction.type;
      const reason = { code: "ACTION_EXPIRED", message: "This human action has expired and can no longer resume the transaction." };
      const transaction = run.transactionSessionId
        ? this.transactionService.expire(run.transactionSessionId, reason)
        : null;
      this.store.update(runId, {
        status: "expired",
        pendingAction: null,
        outcome: transaction?.outcome ?? { type: "expired", reason, paymentSubmitted: false },
      });
      this.store.append(runId, "human_action_expired", { actionId: request.actionId, actionType: expiredActionType });
      const error = new Error(reason.message);
      error.statusCode = 410;
      error.code = reason.code;
      throw error;
    }
    if (run.pendingAction.type === "payment_authentication"
      && request.paymentSessionId !== run.pendingAction.paymentSessionId) {
      const error = new Error("The payment session does not belong to this run and action");
      error.statusCode = 409;
      error.code = "PAYMENT_ACTION_BINDING_MISMATCH";
      throw error;
    }
    if (run.pendingAction.type === "purchase_authorization" && request.decision === "approve") {
      const selectedPlanId = request.planId ?? run.pendingAction.planId;
      if (!run.pendingAction.eligiblePlanIds?.includes(selectedPlanId)) {
        const error = new Error("The selected plan is not available for this authorization");
        error.statusCode = 422;
        error.code = "PLAN_NOT_AVAILABLE";
        throw error;
      }
      request.planId = selectedPlanId;
      this.store.update(runId, {
        proposal: { ...run.proposal, selectedPlanId },
      });
    }
    this.store.append(runId, "human_action_resumed", {
      actionId: request.actionId,
      decision: request.decision,
      planId: request.planId,
    });
    this.store.update(runId, { status: "running", pendingAction: null });
    try {
      const result = await this.graph.invoke(new Command({ resume: request }), this.config(run));
      return this.syncResult(runId, result);
    } catch (error) {
      if (error.code === "ACTION_EXPIRED" && run.transactionSessionId) {
        const expired = this.transactionService.expire(run.transactionSessionId, {
          code: "ACTION_EXPIRED",
          message: "The payment authentication action expired before a verified result was received.",
        });
        this.store.update(runId, { status: "expired", pendingAction: null, outcome: expired.outcome });
        this.store.append(runId, "human_action_expired", { actionId: request.actionId, actionType: "payment_authentication" });
        error.statusCode = 410;
        throw error;
      }
      if (run.transactionSessionId) {
        this.transactionService.cancel(run.transactionSessionId, {
          code: "AGENT_RUNTIME_FAILED",
          message: "The Agent run failed and its transaction authorization was closed.",
        });
      }
      this.store.update(runId, { status: "failed", pendingAction: null });
      this.store.append(runId, "agent_run_failed", { error: error.message });
      throw error;
    }
  }

  async message(runId, input) {
    const request = AgentMessageRequestSchema.parse(input);
    const run = this.store.require(runId);
    const answer = await this.coordinator.answer(runId, request.message);
    run.messages.push({ role: "user", content: request.message, at: this.store.now() });
    run.messages.push({ role: "assistant", content: answer, at: this.store.now() });
    run.updatedAt = this.store.now();
    this.store.save(runId);
    return { runId, message: run.messages.at(-1), agentMode: run.agentMode };
  }

  feedback(runId, input) {
    const request = AgentFeedbackRequestSchema.parse(input);
    const run = this.store.require(runId);
    if (!["completed", "blocked", "cancelled", "expired", "needs_clarification"].includes(run.status)) {
      const error = new Error("Feedback can be recorded only after the Agent run reaches a terminal state");
      error.statusCode = 409;
      error.code = "RUN_NOT_READY_FOR_FEEDBACK";
      throw error;
    }
    const memory = this.experienceMemory?.recordFeedback(runId, request);
    if (!memory) {
      const error = new Error("No reflection memory exists for this Agent run");
      error.statusCode = 404;
      error.code = "REFLECTION_MEMORY_NOT_FOUND";
      throw error;
    }
    this.store.append(runId, "reflection_feedback_recorded", {
      rating: request.rating,
      memoryId: memory.id,
      qualityStatus: memory.quality.status,
    });
    return {
      runId,
      memory: this.experienceMemory.getForRun(runId),
    };
  }

  getRun(id) {
    return this.store.public(id);
  }

  getTrace(id) {
    return { runId: id, events: this.store.require(id).trace };
  }

  getTransaction(id) {
    const run = this.store.require(id);
    if (!run.transactionSessionId) {
      const error = new Error("This Agent run has no transaction session");
      error.statusCode = 404;
      throw error;
    }
    return this.transactionService.snapshot(run.transactionSessionId);
  }

  capabilities() {
    return {
      framework: { agent: "LangChain", orchestration: "LangGraph" },
      agentMode: this.coordinator.mode(),
      modelConfigured: this.coordinator.hasModel(),
      model: this.coordinator.hasModel() ? process.env.CAMPUSCART_AGENT_MODEL ?? "gpt-6-astra" : null,
      knowledge: this.knowledgeBase?.capabilities() ?? { enabled: false },
      experienceMemory: this.experienceMemory?.capabilities() ?? { enabled: false },
      adapters: this.adapters.capabilities(),
      warnings: [
        "All bundled adapters are sandbox implementations.",
        "Future integration entries are interface declarations, not claims of provider connectivity.",
      ],
    };
  }
}
