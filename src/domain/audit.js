import { createHash, randomUUID } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function appendAudit(session, type, payload, at) {
  const previousHash = session.audit.at(-1)?.hash ?? "GENESIS";
  const event = {
    id: randomUUID(),
    sequence: session.audit.length + 1,
    type,
    at,
    state: session.state,
    previousHash,
    payload,
  };
  event.hash = createHash("sha256").update(previousHash + canonical(event)).digest("hex");
  session.audit.push(Object.freeze(event));
  return event;
}

export function verifyAuditChain(events) {
  let previousHash = "GENESIS";
  for (const original of events) {
    const { hash, ...event } = original;
    if (event.previousHash !== previousHash) return false;
    const expected = createHash("sha256").update(previousHash + canonical(event)).digest("hex");
    if (expected !== hash) return false;
    previousHash = hash;
  }
  return true;
}
