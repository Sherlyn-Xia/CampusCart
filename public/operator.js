"use strict";

const state = {
  key: "",
  operator: null,
  cases: [],
  selectedId: null,
  actionKeys: new Map(),
};

const byId = (id) => document.getElementById(id);
const loginView = byId("login-view");
const workspace = byId("workspace");
const loginForm = byId("login-form");
const loginError = byId("login-error");
const workspaceError = byId("workspace-error");
const caseList = byId("case-list");
const caseDetail = byId("case-detail");

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

function showError(target, message = "") {
  target.textContent = message;
  target.hidden = !message;
}

function toast(message) {
  const target = byId("toast");
  target.textContent = message;
  target.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => target.classList.remove("show"), 2600);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.key}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let body = {};
  try { body = await response.json(); } catch { /* empty or non-JSON response */ }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed with HTTP ${response.status}`);
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function shortId(value) {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 11)}…${value.slice(-7)}` : value;
}

function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function money(cents) {
  return Number.isInteger(cents) ? `HK$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—";
}

function statusTone(status) {
  if (["REFUNDED", "COMPLETED"].includes(status)) return "success";
  if (["MANUAL_REVIEW", "USER_CONFIRMATION_REQUIRED"].includes(status)) return "review";
  if (["RETURN_AUTHORIZED", "RETURN_RECEIVED", "EXCHANGE_AUTHORIZED", "REFUND_PENDING"].includes(status)) return "progress";
  if (["REVIEW_REJECTED", "REJECTED", "CANCELLED", "EXPIRED"].includes(status)) return "rejected";
  return "";
}

function statusBadge(status) {
  return node("span", `status ${statusTone(status)}`, status.replaceAll("_", " "));
}

function setBusy(button, busy, label = "Working…") {
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
  }
}

async function loadCases({ preserveSelection = true } = {}) {
  showError(workspaceError);
  const filter = byId("status-filter").value;
  const query = filter ? `?status=${encodeURIComponent(filter)}` : "";
  const body = await request(`/api/v1/operator/after-sales/cases${query}`);
  state.operator = body.operator;
  state.cases = body.cases;
  if (!preserveSelection || !state.cases.some((item) => item.id === state.selectedId)) {
    state.selectedId = state.cases[0]?.id ?? null;
  }
  byId("operator-name").textContent = state.operator.id;
  byId("last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  renderSummary();
  renderList();
  if (state.selectedId) await selectCase(state.selectedId, { fetchFresh: true });
  else renderEmptyDetail();
}

function renderSummary() {
  const statuses = state.cases.map((item) => item.status);
  byId("stat-total").textContent = String(state.cases.length);
  byId("stat-review").textContent = String(statuses.filter((status) => status === "MANUAL_REVIEW").length);
  byId("stat-progress").textContent = String(statuses.filter((status) => ["RETURN_AUTHORIZED", "RETURN_RECEIVED", "EXCHANGE_AUTHORIZED", "REFUND_PENDING"].includes(status)).length);
  byId("stat-resolved").textContent = String(statuses.filter((status) => ["REFUNDED", "COMPLETED", "REVIEW_REJECTED"].includes(status)).length);
  byId("case-count").textContent = String(state.cases.length);
}

function renderList() {
  caseList.replaceChildren();
  if (!state.cases.length) {
    caseList.append(node("p", "list-empty", "No cases match this status."));
    return;
  }
  for (const serviceCase of state.cases) {
    const button = node("button", `case-card${serviceCase.id === state.selectedId ? " active" : ""}`);
    button.type = "button";
    const top = node("div", "case-card-top");
    top.append(node("strong", "", shortId(serviceCase.id)), statusBadge(serviceCase.status));
    const reason = node("p", "", serviceCase.reason || "No reason supplied");
    const meta = node("div", "case-card-meta");
    meta.append(node("span", "", serviceCase.requestedAction.replaceAll("_", " ")), node("span", "", dateTime(serviceCase.updatedAt)));
    button.append(top, reason, meta);
    button.addEventListener("click", () => selectCase(serviceCase.id));
    caseList.append(button);
  }
}

function renderEmptyDetail() {
  caseDetail.replaceChildren();
  const empty = node("div", "empty-state");
  empty.append(node("span", "", "◎"), node("h2", "", "Select a case"), node("p", "", "Choose a case to inspect its evidence and available actions."));
  caseDetail.append(empty);
}

async function selectCase(id, { fetchFresh = true } = {}) {
  state.selectedId = id;
  renderList();
  try {
    const serviceCase = fetchFresh
      ? (await request(`/api/v1/operator/after-sales/cases/${encodeURIComponent(id)}`)).case
      : state.cases.find((item) => item.id === id);
    renderDetail(serviceCase);
  } catch (error) {
    showError(workspaceError, `${error.code ? `${error.code}: ` : ""}${error.message}`);
  }
}

function section(title) {
  const element = node("section", "detail-section");
  element.append(node("h3", "", title));
  return element;
}

function factGrid(entries) {
  const list = node("dl", "facts");
  for (const [label, value] of entries) {
    const wrapper = node("div", "fact");
    wrapper.append(node("dt", "", label), node("dd", "", value ?? "—"));
    list.append(wrapper);
  }
  return list;
}

function inputField(labelText, { multiline = false, placeholder = "", value = "" } = {}) {
  const wrapper = node("div");
  const id = `field-${crypto.randomUUID()}`;
  const label = node("label", "", labelText);
  label.htmlFor = id;
  const input = node(multiline ? "textarea" : "input");
  input.id = id;
  input.placeholder = placeholder;
  input.value = value;
  wrapper.append(label, input);
  return { wrapper, input };
}

function actionButton(text, kind = "primary-button") {
  const button = node("button", kind, text);
  button.type = "button";
  return button;
}

function actionFingerprint(caseId, route, payload) {
  return `${caseId}:${route}:${JSON.stringify(payload)}`;
}

async function mutateCase(serviceCase, route, payload, button, successMessage) {
  const fingerprint = actionFingerprint(serviceCase.id, route, payload);
  const idempotencyKey = state.actionKeys.get(fingerprint) || `operator-ui-${crypto.randomUUID()}`;
  state.actionKeys.set(fingerprint, idempotencyKey);
  setBusy(button, true);
  showError(workspaceError);
  try {
    const result = await request(`/api/v1/operator/after-sales/cases/${encodeURIComponent(serviceCase.id)}/${route}`, {
      method: "POST",
      body: JSON.stringify({ ...payload, idempotencyKey }),
    });
    state.actionKeys.delete(fingerprint);
    state.selectedId = serviceCase.id;
    toast(successMessage);
    await loadCases();
    if (!state.cases.some((item) => item.id === serviceCase.id)) renderDetail(result);
  } catch (error) {
    showError(workspaceError, `${error.code ? `${error.code}: ` : ""}${error.message}. The same idempotency key will be reused if you retry.`);
    setBusy(button, false);
  }
}

function renderActions(serviceCase) {
  const area = section("Available action");
  const box = node("div", "action-box");
  const form = node("div", "action-form");
  const failure = [...(serviceCase.audit || [])].reverse().find((event) => event.type === "after_sales_provider_failed");

  if (serviceCase.status === "MANUAL_REVIEW" && failure?.data?.operation === "refund") {
    box.append(node("h3", "", "Reconcile failed refund"), node("p", "", "Confirm the provider has not already refunded this payment before retrying. The provider idempotency key remains unchanged."));
    const note = inputField("Reconciliation note", { multiline: true, placeholder: "What did you verify with the provider?" });
    const retry = actionButton("Retry sandbox refund");
    retry.addEventListener("click", () => {
      if (!window.confirm("Retry this refund after checking the provider result?")) return;
      mutateCase(serviceCase, "retry-refund", { ...(note.input.value.trim() ? { note: note.input.value.trim() } : {}) }, retry, "Refund reconciliation completed");
    });
    form.append(note.wrapper, retry);
  } else if (serviceCase.status === "MANUAL_REVIEW" && ["return", "exchange"].includes(serviceCase.requestedAction)) {
    box.append(node("h3", "", `Review ${serviceCase.requestedAction} request`), node("p", "", "Check the request evidence before approving a merchant authorization or rejecting the case."));
    const note = inputField("Review note", { multiline: true, placeholder: "Add a reason for the audit trail" });
    const buttons = node("div", "action-buttons");
    const approve = actionButton(`Approve ${serviceCase.requestedAction}`);
    const reject = actionButton("Reject request", "danger-button");
    approve.addEventListener("click", () => mutateCase(serviceCase, "review", { decision: "approve", ...(note.input.value.trim() ? { note: note.input.value.trim() } : {}) }, approve, "Request approved"));
    reject.addEventListener("click", () => {
      if (!window.confirm("Reject this after-sales request?")) return;
      mutateCase(serviceCase, "review", { decision: "reject", ...(note.input.value.trim() ? { note: note.input.value.trim() } : {}) }, reject, "Request rejected");
    });
    buttons.append(approve, reject);
    form.append(note.wrapper, buttons);
  } else if (serviceCase.status === "RETURN_AUTHORIZED") {
    box.append(node("h3", "", "Record returned item"), node("p", "", "Only continue after the merchant confirms the authorized return was received."));
    const note = inputField("Receipt note", { multiline: true, placeholder: "Inspection or parcel reference" });
    const receive = actionButton("Confirm receipt and refund");
    receive.addEventListener("click", () => {
      if (!window.confirm("Confirm receipt and submit the sandbox refund?")) return;
      mutateCase(serviceCase, "receive-return", { ...(note.input.value.trim() ? { note: note.input.value.trim() } : {}) }, receive, "Return received and refund processed");
    });
    form.append(note.wrapper, receive);
  } else if (serviceCase.status === "EXCHANGE_AUTHORIZED") {
    box.append(node("h3", "", "Create replacement"), node("p", "", "Create the merchant replacement evidence without refunding the original payment."));
    const replacement = inputField("Replacement order ID", { placeholder: "Optional — generated by the sandbox if blank" });
    const note = inputField("Completion note", { multiline: true, placeholder: "Replacement handling note" });
    const complete = actionButton("Complete exchange");
    complete.addEventListener("click", () => mutateCase(serviceCase, "complete-exchange", {
      ...(replacement.input.value.trim() ? { replacementOrderId: replacement.input.value.trim() } : {}),
      ...(note.input.value.trim() ? { note: note.input.value.trim() } : {}),
    }, complete, "Replacement order created"));
    form.append(replacement.wrapper, note.wrapper, complete);
  } else {
    box.append(node("p", "resolved-note", "No operator action is available from this state."));
  }
  box.append(form);
  area.append(box);
  return area;
}

function providerEvidence(serviceCase) {
  const receipts = {
    returnAuthorization: serviceCase.returnAuthorization?.providerReceipt ?? null,
    returnReceipt: serviceCase.returnAuthorization?.receipt ?? null,
    exchangeAuthorization: serviceCase.exchangeAuthorization?.providerReceipt ?? null,
    replacementReceipt: serviceCase.exchangeAuthorization?.merchantReceipt ?? serviceCase.outcome?.exchange?.merchantReceipt ?? null,
    refundReceipt: serviceCase.outcome?.refund?.providerReceipt ?? null,
  };
  return Object.fromEntries(Object.entries(receipts).filter(([, value]) => value));
}

function renderDetail(serviceCase) {
  caseDetail.replaceChildren();
  const shell = node("article", "detail-shell");
  const head = node("div", "detail-head");
  const title = node("div");
  title.append(node("h2", "", serviceCase.id), node("p", "", `Updated ${dateTime(serviceCase.updatedAt)}`));
  head.append(title, statusBadge(serviceCase.status));
  shell.append(head);

  const overview = section("Case overview");
  overview.append(factGrid([
    ["Requested action", serviceCase.requestedAction.replaceAll("_", " ")],
    ["Refund estimate", money(serviceCase.refundEstimate?.amountCents)],
    ["Order", serviceCase.orderId],
    ["Agent run", serviceCase.runId],
    ["Within policy window", serviceCase.eligibility?.withinWindow ? "Yes" : "No"],
    ["Audit chain", serviceCase.auditChainValid ? "Valid" : "Invalid"],
  ]));
  shell.append(overview);

  const reason = section("Customer reason");
  reason.append(node("p", "reason", serviceCase.reason || "No reason supplied."));
  shell.append(reason, renderActions(serviceCase));

  const evidence = providerEvidence(serviceCase);
  if (Object.keys(evidence).length) {
    const evidenceSection = section("Provider evidence");
    const pre = node("pre", "evidence");
    pre.textContent = JSON.stringify(evidence, null, 2);
    evidenceSection.append(pre);
    shell.append(evidenceSection);
  }

  const auditSection = section(`Audit timeline · ${serviceCase.audit?.length ?? 0} events`);
  const audit = node("div", "audit");
  for (const event of [...(serviceCase.audit || [])].reverse()) {
    const row = node("div", "audit-event");
    const content = node("div");
    content.append(node("strong", "", event.type.replaceAll("_", " ")), node("p", "", `${dateTime(event.at)} · sequence ${event.sequence}`));
    row.append(node("span", "audit-dot"), content);
    audit.append(row);
  }
  auditSection.append(audit);
  shell.append(auditSection);
  caseDetail.append(shell);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  const keyInput = byId("operator-key");
  state.key = keyInput.value;
  showError(loginError);
  setBusy(button, true, "Verifying…");
  try {
    await loadCases({ preserveSelection: false });
    keyInput.value = "";
    loginView.hidden = true;
    workspace.hidden = false;
    byId("operator-session").hidden = false;
  } catch (error) {
    state.key = "";
    showError(loginError, `${error.code ? `${error.code}: ` : ""}${error.message}`);
  } finally {
    setBusy(button, false);
  }
});

byId("disconnect").addEventListener("click", () => {
  state.key = "";
  state.operator = null;
  state.cases = [];
  state.selectedId = null;
  state.actionKeys.clear();
  workspace.hidden = true;
  byId("operator-session").hidden = true;
  loginView.hidden = false;
  byId("operator-key").focus();
});

byId("refresh").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true, "Refreshing…");
  try { await loadCases(); } catch (error) { showError(workspaceError, error.message); }
  finally { setBusy(event.currentTarget, false); }
});

byId("status-filter").addEventListener("change", async () => {
  try { await loadCases({ preserveSelection: false }); } catch (error) { showError(workspaceError, error.message); }
});

window.addEventListener("pagehide", () => {
  state.key = "";
  state.actionKeys.clear();
});
