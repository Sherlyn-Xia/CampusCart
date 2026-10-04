import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { publicRun } from "./contracts.js";

export class AgentRunStore {
  constructor({ clock = () => new Date(), repository = null } = {}) {
    this.clock = clock;
    this.repository = repository;
    this.runs = new Map((repository?.all() ?? []).map((run) => [run.id, run]));
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
  }

  now() {
    return this.clock().toISOString();
  }

  create(request, agentMode) {
    const id = randomUUID();
    const run = {
      id,
      threadId: `thread-${id}`,
      status: "running",
      agentMode,
      framework: { agent: "LangChain", orchestration: "LangGraph" },
      request: structuredClone(request),
      transactionSessionId: null,
      proposal: null,
      pendingAction: null,
      outcome: null,
      messages: [{ role: "user", content: request.message, at: this.now() }],
      createdAt: this.now(),
      updatedAt: this.now(),
      trace: [],
      internal: { toolContext: {}, graphState: null },
    };
    this.runs.set(id, run);
    this.append(id, "agent_run_created", { agentMode, messageLength: request.message.length });
    return run;
  }

  require(id) {
    const run = this.runs.get(id);
    if (!run) {
      const error = new Error("Agent run not found");
      error.statusCode = 404;
      throw error;
    }
    return run;
  }

  update(id, patch) {
    const run = this.require(id);
    Object.assign(run, structuredClone(patch), { updatedAt: this.now() });
    this.save(id);
    return run;
  }

  save(id) {
    const run = this.require(id);
    this.repository?.save(run);
    return run;
  }

  append(id, type, data = {}) {
    const run = this.require(id);
    const previousHash = run.trace.at(-1)?.hash ?? "GENESIS";
    const event = {
      id: randomUUID(),
      sequence: run.trace.length + 1,
      type,
      at: this.now(),
      data: structuredClone(data),
      previousHash,
    };
    event.hash = createHash("sha256").update(previousHash + JSON.stringify(event)).digest("hex");
    run.trace.push(event);
    run.updatedAt = event.at;
    this.save(id);
    this.events.emit(`trace:${id}`, event);
    return event;
  }

  subscribe(id, listener) {
    this.require(id);
    const channel = `trace:${id}`;
    this.events.on(channel, listener);
    return () => this.events.off(channel, listener);
  }

  public(id) {
    return publicRun(this.require(id));
  }
}
