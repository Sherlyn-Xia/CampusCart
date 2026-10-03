const steps = [
  ["Purchase intent", "意图"],
  ["Agent tools", "工具"],
  ["Compare", "方案"],
  ["Questions", "问答"],
  ["Authorize", "授权"],
  ["Audit result", "审计"],
];

const defaultMessages = {
  success: "帮我购买这台 iPad，预算 HK$3,600，最多使用 100 积分。请比较学生优惠、积分和支付方式。",
  blocked: "帮我购买这台 iPad，预算 HK$3,500，最多使用 100 积分；如果价格上涨就停止。",
};

const state = {
  bootstrap: null,
  capabilities: null,
  run: null,
  transaction: null,
  trace: [],
  traceStream: null,
  paymentPoll: null,
  scenario: "success",
  message: defaultMessages.success,
  answer: null,
  selectedPlanId: null,
  page: 0,
  busy: false,
};

const app = document.querySelector("#app");
const desktopSteps = document.querySelector("#desktop-steps");
const mobileProgress = document.querySelector("#mobile-progress");
const toast = document.querySelector("#toast");

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);
const money = (cents) => cents == null ? "—" : new Intl.NumberFormat("en-HK", {
  style: "currency", currency: "HKD", minimumFractionDigits: cents % 100 ? 2 : 0,
}).format(cents / 100);
const shortHash = (hash = "") => hash ? `${hash.slice(0, 10)}…${hash.slice(-7)}` : "Pending";
const dateTime = (value) => value ? new Intl.DateTimeFormat("en-HK", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Hong_Kong",
}).format(new Date(value)) : "—";

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.code = data.code;
    throw error;
  }
  return data;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3000);
}

function renderProgress() {
  desktopSteps.innerHTML = steps.map(([title], index) => `
    <li class="step-item ${index === state.page ? "active" : ""} ${index < state.page ? "done" : ""}">
      <span class="step-number">${index < state.page ? "✓" : index + 1}</span>
      <span class="step-copy">${title}</span>
    </li>`).join("");
  mobileProgress.innerHTML = `
    <div class="progress-label"><span>${steps[state.page][0]}</span><span>${state.page + 1} / ${steps.length}</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${((state.page + 1) / steps.length) * 100}%"></div></div>`;
}

function heading(eyebrow, title, description) {
  return `<div class="screen-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div><span class="step-kicker">0${state.page + 1} / 0${steps.length}</span></div>`;
}

function footer({ back = true, nextLabel = "Continue", nextAction = "next", nextClass = "button-primary", disabled = false } = {}) {
  return `<div class="screen-footer">
    ${back ? `<button class="button button-link" data-action="back"><span class="arrow">←</span> Back</button>` : `<span></span>`}
    <button class="button ${nextClass}" data-action="${nextAction}" ${disabled ? "disabled" : ""}>${nextLabel} <span class="arrow">→</span></button>
  </div>`;
}

function taskView() {
  const { product } = state.bootstrap;
  const mode = state.capabilities.agentMode;
  return `<section class="screen">
    ${heading("Natural-language entry", "Tell the Agent what you want to buy.", "The exact product still has to match the selected Demo SKU. Unsupported requests stop instead of silently substituting another item.")}
    <div class="screen-body">
      <div class="scenario-switch" role="group" aria-label="Demo scenario">
        <button class="scenario-option ${state.scenario === "success" ? "active" : ""}" data-scenario="success">✓ Success · cap HK$3,600</button>
        <button class="scenario-option ${state.scenario === "blocked" ? "active" : ""}" data-scenario="blocked">⊘ STOP · cap HK$3,500</button>
      </div>
      <div class="intent-layout">
        <div class="intent-panel">
          <label for="intent"><span class="eyebrow">Purchase request</span></label>
          <textarea id="intent" class="intent-input" maxlength="4000">${escapeHtml(state.message)}</textarea>
          <div class="intent-meta"><span>Framework · LangChain + LangGraph</span><span>Mode · ${escapeHtml(mode)}</span></div>
          <div class="data-note"><strong>Try the guardrail:</strong> replace the request with “帮我买一串香蕉，预算 HK$100”. The server must reject it before creating a transaction.</div>
        </div>
        <div class="selected-product">
          <span class="tag tag-verified">User-selected Demo SKU</span>
          <div class="mini-tablet">Campus<br>ready.</div>
          <h3>${escapeHtml(product.name)}</h3>
          <p>${escapeHtml(product.variant)}</p>
          <strong>${money(product.listPriceCents)}</strong>
          <code>${escapeHtml(product.sku)}</code>
        </div>
      </div>
    </div>
    ${footer({ back: false, nextAction: "start-agent", nextLabel: "Run Agent tools", disabled: !state.message.trim() })}
  </section>`;
}

const traceLabels = {
  agent_run_created: "Agent run created",
  agent_state_transition: "Graph state transition",
  tool_call_started: "Tool started",
  tool_call_completed: "Tool completed",
  tool_call_failed: "Tool failed",
  model_invocation_started: "LLM invocation started",
  model_invocation_completed: "LLM invocation completed",
  model_invocation_failed: "LLM fallback activated",
  human_action_requested: "Human action requested",
  human_action_resumed: "Human action resumed",
  agent_run_finished: "Agent run finished",
};

function traceEvent(event) {
  const tool = event.data.tool ? ` · ${escapeHtml(event.data.tool)}` : "";
  const node = event.data.node ? ` · ${escapeHtml(event.data.node)}` : "";
  return `<div class="trace-event ${event.type.includes("failed") ? "failed" : ""}">
    <span class="trace-sequence">${event.sequence}</span>
    <div><strong>${traceLabels[event.type] || escapeHtml(event.type)}${tool}${node}</strong><small>${dateTime(event.at)}</small></div>
    <code>${shortHash(event.hash)}</code>
  </div>`;
}

function toolsView() {
  const completed = state.trace.filter((event) => event.type === "tool_call_completed");
  return `<section class="screen">
    ${heading("Reason → Act", "A real cross-tool run.", "These events come from the server-side Agent trace, not a prewritten animation. The trace can also be streamed through SSE.")}
    <div class="screen-body">
      <div class="framework-grid">
        <div><small>Agent</small><strong>${escapeHtml(state.run.framework.agent)}</strong></div>
        <div><small>Orchestrator</small><strong>${escapeHtml(state.run.framework.orchestration)}</strong></div>
        <div><small>Runtime mode</small><strong>${escapeHtml(state.run.agentMode)}</strong></div>
        <div><small>Completed tools</small><strong>${completed.length}</strong></div>
      </div>
      <div class="tool-ledger">${state.trace.map(traceEvent).join("")}</div>
    </div>
    ${footer({ nextLabel: state.run.status === "blocked" ? "See blocked result" : "Compare options", nextAction: state.run.status === "blocked" ? "show-outcome" : "next" })}
  </section>`;
}

function allPlans() {
  const proposal = state.run?.proposal;
  if (!proposal) return [];
  return proposal.plan
    ? [proposal.plan, ...proposal.alternativePlans.filter((plan) => plan.id !== proposal.plan.id)]
    : proposal.alternativePlans;
}

function selectedPlan() {
  const plans = allPlans();
  return plans.find((plan) => plan.id === (state.run?.proposal?.selectedPlanId ?? state.selectedPlanId))
    ?? plans.find((plan) => plan.id === state.run?.proposal?.plan?.id)
    ?? null;
}

function paymentName(methodId) {
  return state.bootstrap?.paymentMethods?.find((method) => method.id === methodId)?.name ?? methodId;
}

function offerLabel(offer) {
  if (!Number.isInteger(offer.valueCents)) return offer.title;
  const value = offer.kind === "shipping_waiver" ? `saves ${money(offer.valueCents)}` : `−${money(offer.valueCents)}`;
  return `${offer.title} (${value})`;
}

function planCard(plan, recommendedId, selectedId, comparisonOnly) {
  const recommended = plan.id === recommendedId;
  const selected = plan.id === selectedId;
  const selectable = plan.eligible && !comparisonOnly;
  const offers = plan.appliedOffers.length ? plan.appliedOffers.map(offerLabel).join(" · ") : "No offers applied";
  const points = plan.pointsUsed
    ? `${plan.pointsUsed} ${escapeHtml(plan.pointsProgram?.name ?? "points")} (−${money(plan.pointsValueCents)})`
    : "No points used";
  return `<article class="plan-card ${selected ? "selected" : ""} ${recommended ? "recommended" : ""} ${plan.eligible ? "" : "ineligible"}" ${selectable ? `data-plan-id="${escapeHtml(plan.id)}"` : ""}>
    <div>
      <div class="plan-title-row"><h3>${escapeHtml(plan.merchant)}</h3>${recommended ? `<span class="winner-pill">Recommended</span>` : ""}${!plan.eligible ? `<span class="tag">Not executable</span>` : ""}</div>
      <div class="plan-details">${escapeHtml(plan.fulfillment)} · ${escapeHtml(paymentName(plan.paymentMethodId))}</div>
      <div class="plan-benefits"><div><strong>Offers</strong><span>${escapeHtml(offers)}</span></div><div><strong>Points</strong><span>${points}</span></div></div>
      <div class="equation" style="margin-top:9px">${escapeHtml(plan.equation)}</div>
      ${plan.reasons.length ? `<div class="plan-reasons">${plan.reasons.map(escapeHtml).join(" · ")}</div>` : ""}
    </div>
    <div class="plan-choice"><div class="plan-price"><strong>${money(plan.cashOutCents)}</strong><span>pay now</span></div>${selectable ? `<button class="plan-select ${selected ? "active" : ""}" data-plan-id="${escapeHtml(plan.id)}">${selected ? "✓ Your choice" : "Choose"}</button>` : ""}</div>
  </article>`;
}

function compareView() {
  const { proposal } = state.run;
  const plans = allPlans();
  const comparisonOnly = state.run.status === "needs_clarification";
  return `<section class="screen">
    ${heading("Your options", comparisonOnly ? "Compare now, decide after adding a budget." : proposal.plan ? "Choose the option that works for you." : "No option is currently available.", "The Agent marks its lowest-cost recommendation, but the final decision is yours.")}
    <div class="screen-body">
      <div class="plan-stack">${plans.map((plan) => planCard(plan, proposal.plan?.id, state.selectedPlanId, comparisonOnly)).join("")}</div>
    </div>
    ${footer({ nextLabel: comparisonOnly ? "Resolve missing details" : proposal.plan ? "Continue with my choice" : "See result", nextAction: comparisonOnly ? "show-outcome" : proposal.plan ? "next" : "show-outcome", disabled: !comparisonOnly && proposal.plan && !state.selectedPlanId })}
  </section>`;
}

function explanationView() {
  return `<section class="screen">
    ${heading("Questions", "Anything you want to check?", "Ask about an offer, points, delivery, payment method or the difference between options.")}
    <div class="screen-body">
      <div class="qa-card">
        <label for="question"><strong>Ask about these options</strong></label>
        <div class="qa-input"><input id="question" value="这些方案的优惠和积分有什么区别？"><button class="button button-secondary" data-action="ask">Ask</button></div>
        ${state.answer ? `<div class="qa-answer"><p>${escapeHtml(state.answer)}</p></div>` : ""}
      </div>
    </div>
    ${footer({ nextLabel: "Review my choice" })}
  </section>`;
}

function lockDetails(transaction) {
  const lock = transaction?.lock;
  const plan = selectedPlan();
  return `<div class="lock-document"><div class="lock-head"><div><span class="eyebrow">${lock ? `${escapeHtml(lock.status)} · single use` : "Authorization proposal"}</span><h3>Benefit Lock</h3></div><div class="lock-seal">⌁</div></div>
    <div class="lock-rows">
      <div class="lock-row"><span>SKU</span><strong>${escapeHtml(plan.sku)}</strong></div>
      <div class="lock-row"><span>Merchant</span><strong>${escapeHtml(plan.merchant)}</strong></div>
      <div class="lock-row"><span>Pay now</span><strong>${money(plan.cashOutCents)}</strong></div>
      <div class="lock-row"><span>Authorization cap</span><strong>${money(transaction?.policy.budgetCents ?? plan.cashOutCents)}</strong></div>
      <div class="lock-row"><span>Payment</span><strong>${escapeHtml(paymentName(plan.paymentMethodId))}</strong></div>
      <div class="lock-row"><span>Offers</span><strong>${plan.appliedOffers.map((offer) => escapeHtml(offer.title)).join(" · ") || "None"}</strong></div>
      <div class="lock-row"><span>Points</span><strong>${plan.pointsUsed ? `${plan.pointsUsed} ${escapeHtml(plan.pointsProgram?.name ?? "points")} (−${money(plan.pointsValueCents)})` : "None"}</strong></div>
      <div class="lock-row"><span>Valid until</span><strong>${lock ? dateTime(lock.expiresAt) : "Created only after approval"}</strong></div>
    </div><div class="lock-hash">${lock ? `SHA-256 · ${lock.digest}` : "No lock exists before the first human action."}</div></div>`;
}

function authorizationView() {
  const action = state.run.pendingAction;
  const paymentPending = action?.type === "payment_authentication";
  return `<section class="screen">
    ${heading("Human-in-the-loop", paymentPending ? "Benefit locked. Payment authentication is still required." : "The Agent cannot approve its own proposal.", paymentPending ? "The deterministic pre-check passed. Continue to a real sandbox redirect page, then the server will re-check once more." : "Rejecting this action closes the transaction. Approving creates a single-use Benefit Lock and runs PRECHECK before any payment session exists.")}
    <div class="screen-body">
      <div class="lock-preview">
        ${lockDetails(state.transaction)}
        <div class="lock-side">
          <div class="check-card"><span class="check-dot">✓</span><div><strong>Action ID is single use</strong><small>${escapeHtml(action?.actionId || "Already resolved")}</small></div></div>
          <div class="check-card"><span class="check-dot">✓</span><div><strong>Agent-owned transaction</strong><small>The retired legacy API cannot execute this session.</small></div></div>
          ${paymentPending ? `
            <div class="payment-redirect-card"><span class="eyebrow">Second human action</span><h3>Mock provider redirect</h3><p>${escapeHtml(action.disclaimer)}</p><a class="button button-accent" target="_blank" rel="noopener" href="${escapeHtml(action.url)}">Open payment authentication ↗</a><button class="button button-secondary" data-action="refresh-run">Refresh result</button></div>
          ` : `
            <label class="consent"><input id="consent" type="checkbox"> I authorize this exact sandbox plan. I understand a separate payment authentication is still required.</label>
            <button class="button button-accent" data-action="approve" disabled>Approve & create Benefit Lock</button>
            <button class="button button-secondary" data-action="reject">Reject and close transaction</button>
          `}
        </div>
      </div>
    </div>
    <div class="screen-footer"><button class="button button-link" data-action="back"><span class="arrow">←</span> Back to explanation</button><span class="action-required">Action required above</span></div>
  </section>`;
}

function outcomeView() {
  const outcome = state.run.outcome;
  const status = state.run.status;
  const blocked = status === "blocked";
  const cancelled = status === "cancelled";
  const clarification = status === "needs_clarification";
  const expired = status === "expired";
  const success = status === "completed";
  const reason = typeof outcome?.reason === "string" ? outcome.reason : outcome?.reason?.message;
  const code = typeof outcome?.reason === "object" ? outcome.reason.code : status.toUpperCase();
  const quote = outcome?.finalQuote;
  const audits = state.transaction?.audit ?? [];
  return `<section class="screen"><div class="screen-body receipt-wrap">
    <div class="outcome-banner ${success ? "" : "blocked"}"><div class="outcome-icon">${success ? "✓" : "!"}</div><span class="eyebrow">${success ? "Sandbox transaction complete" : blocked ? "STOP was the correct outcome" : clarification ? "More information required" : expired ? "Authorization expired" : "Authorization closed"}</span><h1>${success ? "Benefit secured." : blocked ? "Payment safely stopped." : clarification ? "Clarify before buying." : expired ? "Action expired safely." : "Transaction cancelled."}</h1><p>${escapeHtml(reason || (success ? "Both human actions and both deterministic checks completed." : "No payment was submitted."))}</p></div>
    ${!success ? `<div class="blocked-reason"><strong>${escapeHtml(code)}</strong>${escapeHtml(reason || "The transaction cannot continue.")}</div>` : ""}
    <div class="receipt ${success ? "" : "blocked"}" style="margin-top:14px">
      <div class="receipt-top"><div><span>${success ? "Sandbox receipt" : "Final state"}</span><strong>${money(quote?.cashOutCents ?? state.run.proposal?.plan?.cashOutCents)}</strong></div><span class="receipt-status ${success ? "" : "blocked"}">${success ? "Mock captured" : "Not paid"}</span></div>
      <div class="receipt-lines">
        <div class="receipt-line"><span>Agent run</span><strong>${escapeHtml(state.run.id)}</strong></div>
        <div class="receipt-line"><span>Transaction state</span><strong>${escapeHtml(state.transaction?.state || "Not created")}</strong></div>
        <div class="receipt-line"><span>Benefit Lock</span><strong>${escapeHtml(state.transaction?.lock?.status || "Not created")}</strong></div>
        <div class="receipt-line"><span>Payment adapter calls</span><strong>${state.transaction?.paymentAdapterCallCount ?? 0}</strong></div>
      </div>
    </div>
    <section class="audit-section"><div class="audit-head"><h3>Agent tool / action trace</h3><span class="chain-valid">${state.trace.length} hash-chained events</span></div><div class="tool-ledger compact">${state.trace.map(traceEvent).join("")}</div></section>
    <section class="audit-section"><div class="audit-head"><h3>Deterministic transaction audit</h3><span class="chain-valid">${state.transaction?.auditChainValid ? "✓ Chain verified" : "No chain"}</span></div>
      <div class="timeline">${audits.map((event) => `<div class="audit-event ${event.type.includes("blocked") || event.type.includes("cancelled") ? "blocked" : ""}"><span class="audit-node"></span><strong>${escapeHtml(event.type)}</strong><small>#${event.sequence} · ${shortHash(event.hash)}</small></div>`).join("")}</div>
    </section>
  </div><div class="screen-footer"><button class="button button-secondary" data-action="restart">Run another request</button><button class="button button-primary" data-action="download">Download both audit chains ↓</button></div></section>`;
}

function render() {
  renderProgress();
  if (!state.bootstrap || !state.capabilities || state.busy) {
    app.innerHTML = `<div class="loading-state"><span class="spinner"></span><p>Running Agent tools and deterministic checks…</p></div>`;
    return;
  }
  const views = [taskView, toolsView, compareView, explanationView, authorizationView, outcomeView];
  app.innerHTML = views[state.page]();
  bindInputs();
}

function bindInputs() {
  document.querySelector("#intent")?.addEventListener("input", (event) => {
    state.message = event.target.value;
    document.querySelector('[data-action="start-agent"]').disabled = !state.message.trim();
  });
  document.querySelector("#consent")?.addEventListener("change", (event) => {
    document.querySelector('[data-action="approve"]').disabled = !event.target.checked;
  });
}

function mergeTrace(events) {
  const bySequence = new Map(state.trace.map((event) => [event.sequence, event]));
  for (const event of events) bySequence.set(event.sequence, event);
  state.trace = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

function startTraceStream(runId) {
  state.traceStream?.close();
  state.traceStream = new EventSource(`/api/v1/agent/runs/${encodeURIComponent(runId)}/events`);
  state.traceStream.addEventListener("trace", (event) => {
    mergeTrace([JSON.parse(event.data)]);
    if (state.page === 1 || state.page === 5) render();
  });
}

async function refreshRun(runId = state.run?.id) {
  if (!runId) return;
  state.run = await request(`/api/v1/agent/runs/${encodeURIComponent(runId)}`);
  const availablePlanIds = allPlans().map((plan) => plan.id);
  if (state.run.proposal?.selectedPlanId) state.selectedPlanId = state.run.proposal.selectedPlanId;
  else if (!availablePlanIds.includes(state.selectedPlanId)) state.selectedPlanId = state.run.proposal?.plan?.id ?? null;
  const trace = await request(`/api/v1/agent/runs/${encodeURIComponent(runId)}/trace`);
  mergeTrace(trace.events);
  try {
    state.transaction = await request(`/api/v1/agent/runs/${encodeURIComponent(runId)}/transaction`);
  } catch {
    state.transaction = null;
  }
  if (["completed", "blocked", "cancelled", "failed", "expired"].includes(state.run.status)
    || (state.run.status === "needs_clarification" && !state.run.proposal?.plan)) state.page = 5;
  else if (state.run.pendingAction?.type === "payment_authentication") state.page = 4;
  syncPaymentPolling();
}

function syncPaymentPolling() {
  const waiting = state.run?.status === "needs_user_action"
    && state.run.pendingAction?.type === "payment_authentication";
  if (waiting && !state.paymentPoll) {
    state.paymentPoll = window.setInterval(async () => {
      try {
        await refreshRun();
        render();
      } catch {
        // SSE/manual refresh remain available; the next poll retries.
      }
    }, 2500);
  } else if (!waiting && state.paymentPoll) {
    window.clearInterval(state.paymentPoll);
    state.paymentPoll = null;
  }
}

async function startAgent() {
  state.busy = true;
  state.answer = null;
  state.trace = [];
  render();
  try {
    state.run = await request("/api/v1/agent/runs", {
      method: "POST",
      body: {
        message: state.message,
        context: {
          demoScenario: state.scenario,
          selectedProduct: {
            sku: state.bootstrap.product.sku,
            source: "product_page",
            userConfirmed: true,
          },
        },
      },
    });
    await refreshRun(state.run.id);
    startTraceStream(state.run.id);
    history.replaceState({}, "", `/?run=${encodeURIComponent(state.run.id)}`);
    state.page = state.run.status === "blocked"
      || (state.run.status === "needs_clarification" && !state.run.proposal?.plan) ? 5 : 1;
  } catch (error) {
    notify(error.message);
    state.page = 0;
  } finally {
    state.busy = false;
    render();
  }
}

async function resume(decision) {
  if (!state.run?.pendingAction) return;
  state.busy = true;
  render();
  try {
    const body = { actionId: state.run.pendingAction.actionId, decision };
    if (decision === "approve" && state.run.pendingAction.type === "purchase_authorization") body.planId = state.selectedPlanId;
    state.run = await request(`/api/v1/agent/runs/${encodeURIComponent(state.run.id)}/resume`, {
      method: "POST",
      body,
    });
    await refreshRun();
    if (state.run.pendingAction?.type === "payment_authentication") notify("Benefit Lock created. Complete the separate sandbox authentication.");
  } catch (error) {
    notify(error.message);
    await refreshRun();
  } finally {
    state.busy = false;
    render();
  }
}

async function askQuestion() {
  const question = document.querySelector("#question")?.value.trim();
  if (!question) return;
  try {
    const response = await request(`/api/v1/agent/runs/${encodeURIComponent(state.run.id)}/messages`, {
      method: "POST", body: { message: question },
    });
    state.answer = response.message.content;
    const trace = await request(`/api/v1/agent/runs/${encodeURIComponent(state.run.id)}/trace`);
    mergeTrace(trace.events);
    render();
  } catch (error) { notify(error.message); }
}

function downloadAudits() {
  const payload = {
    exportedAt: new Date().toISOString(),
    environment: "sandbox",
    agentRunId: state.run.id,
    agentTrace: state.trace,
    transaction: state.transaction,
  };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  link.download = `campuscart-agent-audit-${state.run.id}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function restart() {
  state.traceStream?.close();
  if (state.paymentPoll) window.clearInterval(state.paymentPoll);
  state.paymentPoll = null;
  state.run = null;
  state.transaction = null;
  state.trace = [];
  state.answer = null;
  state.selectedPlanId = null;
  state.page = 0;
  state.scenario = state.scenario === "success" ? "blocked" : "success";
  state.message = defaultMessages[state.scenario];
  history.replaceState({}, "", "/");
  render();
}

document.addEventListener("click", async (event) => {
  const planId = event.target.closest("[data-plan-id]")?.dataset.planId;
  if (planId) {
    const plan = allPlans().find((candidate) => candidate.id === planId);
    if (plan?.eligible) {
      state.selectedPlanId = planId;
      state.answer = null;
      render();
    }
    return;
  }
  const scenario = event.target.closest("[data-scenario]")?.dataset.scenario;
  if (scenario && !state.run) {
    state.scenario = scenario;
    state.message = defaultMessages[scenario];
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "start-agent") return startAgent();
  if (action === "next") { state.page = Math.min(5, state.page + 1); render(); return; }
  if (action === "back") { state.page = Math.max(0, state.page - 1); render(); return; }
  if (action === "show-outcome") { state.page = 5; render(); return; }
  if (action === "approve") return resume("approve");
  if (action === "reject") return resume("reject");
  if (action === "refresh-run") { state.busy = true; render(); await refreshRun(); state.busy = false; render(); return; }
  if (action === "ask") return askQuestion();
  if (action === "download") return downloadAudits();
  if (action === "restart") return restart();
});

const paymentChannel = "BroadcastChannel" in window ? new BroadcastChannel("campuscart-payment") : null;
paymentChannel?.addEventListener("message", async (event) => {
  if (event.data?.type !== "campuscart-payment-result" || event.data.runId !== state.run?.id) return;
  state.busy = true;
  render();
  await refreshRun();
  state.busy = false;
  render();
});

document.querySelector("#help-button").addEventListener("click", () => document.querySelector("#about-dialog").showModal());
document.querySelector(".dialog-close").addEventListener("click", () => document.querySelector("#about-dialog").close());

try {
  [state.bootstrap, state.capabilities] = await Promise.all([
    request("/api/bootstrap"),
    request("/api/v1/agent/capabilities"),
  ]);
  const runId = new URLSearchParams(window.location.search).get("run");
  if (runId) {
    await refreshRun(runId);
    startTraceStream(runId);
    if (!["completed", "blocked", "cancelled", "failed", "expired"].includes(state.run.status)
      && state.run.pendingAction?.type !== "payment_authentication"
      && !(state.run.status === "needs_clarification" && !state.run.proposal?.plan)) state.page = 1;
  }
  render();
} catch (error) {
  app.innerHTML = `<div class="loading-state"><p>Could not start CampusCart: ${escapeHtml(error.message)}</p></div>`;
}
