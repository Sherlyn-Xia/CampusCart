const params = new URLSearchParams(window.location.search);
const runId = params.get("runId");
const actionId = params.get("actionId");
const paymentSessionId = window.location.pathname.split("/").filter(Boolean).at(-1);

const result = document.querySelector("#payment-auth-result");
const approve = document.querySelector("#approve-payment");
const fail = document.querySelector("#fail-payment");
const returnLink = document.querySelector("#return-link");
const channel = "BroadcastChannel" in window ? new BroadcastChannel("campuscart-payment") : null;

document.querySelector("#payment-session").textContent = paymentSessionId || "Missing";
document.querySelector("#agent-run").textContent = runId || "Missing";
returnLink.href = runId ? `/?run=${encodeURIComponent(runId)}` : "/";

async function finish(decision) {
  if (!runId || !actionId) {
    result.textContent = "Invalid sandbox redirect: runId or actionId is missing.";
    result.classList.add("error-note");
    return;
  }
  approve.disabled = true;
  fail.disabled = true;
  result.textContent = "Resuming the waiting Agent run…";
  try {
    const response = await fetch(`/api/v1/agent/runs/${encodeURIComponent(runId)}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId, decision, paymentSessionId }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error || "Payment authentication could not be recorded");
      error.code = body.code;
      throw error;
    }
    result.textContent = decision === "authenticated"
      ? "Sandbox authentication recorded. The transaction completed after the second deterministic pre-check."
      : "Authentication failed. The Agent run was cancelled and its Benefit Lock was closed.";
    result.classList.add(decision === "authenticated" ? "success-note" : "error-note");
    channel?.postMessage({ type: "campuscart-payment-result", runId, paymentSessionId, status: body.status });
  } catch (error) {
    result.textContent = error.code === "ACTION_EXPIRED" ? `ACTION_EXPIRED: ${error.message}` : error.message;
    result.classList.add("error-note");
  }
}

approve.addEventListener("click", () => finish("authenticated"));
fail.addEventListener("click", () => finish("failed"));
