import { Worker } from "node:worker_threads";

import { emptyLiveSnapshot, normalizeEvents, normalizeSnapshot } from "./snapshot-contract.mjs";

const DEFAULT_REFRESH_MS = 1_500;
const MIN_REFRESH_MS = 250;
const MAX_REFRESH_MS = 30_000;
const MAX_PATH_LENGTH = 1_024;
const WORKER_OPTIONS = Object.freeze([
  "stateDbPath",
  "historyDbPath",
  "catalogDbPath",
  "maxAgents",
  "eventLimit",
  "snapshotEventLimit",
  "staleAfterMs",
  "openRetryAfterMs",
  "maxOpenAttempts",
]);

function boundedRefreshMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_REFRESH_MS;
  return Math.max(MIN_REFRESH_MS, Math.min(MAX_REFRESH_MS, Math.trunc(number)));
}

function workerOptions(options) {
  const result = {};
  for (const key of WORKER_OPTIONS) {
    const value = options?.[key];
    if (typeof value === "string") {
      if (value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes("\0")) result[key] = value;
    } else if (Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

function boundedCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1_000_000, Math.trunc(number))) : 0;
}

function workerDiagnostics(value) {
  if (!value || typeof value !== "object") return {};
  const diagnostics = {};
  if (typeof value.ready === "boolean") diagnostics.ready = value.ready;
  if (value.schema && typeof value.schema === "object") {
    diagnostics.schema = {
      valid: Boolean(value.schema.valid),
      missingCount: boundedCount(value.schema.missingCount),
      ...(value.schema.state && typeof value.schema.state === "object" ? {
        state: { valid: Boolean(value.schema.state.valid), missingCount: boundedCount(value.schema.state.missingCount) },
      } : {}),
      ...(value.schema.history && typeof value.schema.history === "object" ? {
        history: { valid: Boolean(value.schema.history.valid), missingCount: boundedCount(value.schema.history.missingCount) },
      } : {}),
    };
  }
  if (value.retry && typeof value.retry === "object") {
    diagnostics.retry = {
      attempts: boundedCount(value.retry.attempts),
      maxAttempts: boundedCount(value.retry.maxAttempts),
      retrying: Boolean(value.retry.retrying),
      nextAttemptAt: typeof value.retry.nextAttemptAt === "string" && Number.isFinite(Date.parse(value.retry.nextAttemptAt))
        ? new Date(value.retry.nextAttemptAt).toISOString()
        : null,
    };
  }
  return diagnostics;
}

function defaultWorkerFactory(url, options) {
  return new Worker(url, options);
}

/**
 * Main-thread handle for the optional Codex adapter. SQLite work happens in
 * codex-worker.mjs; reads from this object only return the most recent safe
 * snapshot and never call into the observer synchronously.
 */
export class CodexWorkerSource {
  constructor(options = {}) {
    this.closed = false;
    this.hasSafeSnapshot = false;
    this.ready = false;
    this.workerState = "starting";
    this.lastRefreshAt = null;
    this.warning = "Codex observer is starting in an isolated worker.";
    this.workerDiagnostics = {};
    this.snapshot = emptyLiveSnapshot(Date.now(), [this.warning]);
    this.worker = null;
    this.workerFactory = typeof options.workerFactory === "function" ? options.workerFactory : defaultWorkerFactory;
    this.refreshMs = boundedRefreshMs(options.codexRefreshMs ?? options.workerRefreshMs ?? options.refreshMs);

    try {
      this.worker = this.workerFactory(new URL("./codex-worker.mjs", import.meta.url), {
        type: "module",
        workerData: { options: workerOptions(options), refreshMs: this.refreshMs },
      });
      this.worker.on?.("message", (message) => this._receive(message));
      this.worker.on?.("error", () => this._fail());
      this.worker.on?.("exit", (code) => {
        if (!this.closed && code !== 0) this._fail();
      });
    } catch {
      this._fail();
    }
  }

  _fail() {
    if (this.closed || this.workerState === "failed") return;
    this.workerState = "failed";
    this.ready = false;
    this.workerDiagnostics = {
      ...this.workerDiagnostics,
      ready: false,
      ...(this.workerDiagnostics.retry ? {
        retry: { ...this.workerDiagnostics.retry, retrying: false, nextAttemptAt: null },
      } : {}),
    };
    this.warning = this.hasSafeSnapshot
      ? "Codex observer stopped. Showing the last safe snapshot; restart Agentarium to reconnect."
      : "Codex observer stopped before a safe snapshot was available. Restart Agentarium to reconnect.";
    this.snapshot = this.hasSafeSnapshot
      ? normalizeSnapshot({
        ...this.snapshot,
        warnings: [this.warning, ...(this.snapshot.warnings ?? [])],
      }, { mode: "live" })
      : emptyLiveSnapshot(Date.now(), [this.warning]);

    // Worker failure is terminal for this process. Do not accept late worker
    // messages that could make stale data look recovered without a clean open.
    this.worker?.terminate?.();
  }

  _receive(message) {
    if (this.closed || this.workerState === "failed" || !message || typeof message !== "object") return;
    if (message.type === "snapshot") {
      try {
        const receivedAt = Date.now();
        this.snapshot = normalizeSnapshot(message.snapshot, { mode: "live", nowMs: receivedAt });
        this.hasSafeSnapshot = true;
        this.lastRefreshAt = new Date(receivedAt).toISOString();
        this.workerDiagnostics = workerDiagnostics(message.diagnostics);
        this.ready = Boolean(this.workerDiagnostics.ready);
        this.workerState = this.ready ? "ready" : "degraded";
        this.warning = this.ready
          ? ""
          : "Codex observer returned no ready schema; showing its latest safe snapshot.";
      } catch {
        this._fail();
      }
      return;
    }
    if (message.type === "error") {
      this.workerDiagnostics = workerDiagnostics(message.diagnostics);
      this._fail();
    }
  }

  getSnapshot(options = {}) {
    if (this.closed) return emptyLiveSnapshot(options.nowMs, ["Codex worker source is closed."]);
    return this.snapshot;
  }

  getEvents(agentId, options = {}) {
    if (this.closed || typeof agentId !== "string") return [];
    const agent = this.snapshot.agents.find((candidate) => candidate.id === agentId);
    return normalizeEvents(agent?.events ?? [], { agentId, nowMs: options.nowMs, limit: options.limit });
  }

  diagnostics() {
    if (this.closed) {
      return { ready: false, provider: "codex-sqlite", source: "worker", readOnly: true, isolated: true, closed: true };
    }
    return {
      provider: "codex-sqlite",
      source: "worker",
      readOnly: true,
      isolated: true,
      worker: this.workerState,
      refreshMs: this.refreshMs,
      lastRefreshAt: this.lastRefreshAt,
      ...this.workerDiagnostics,
      ready: this.ready,
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker?.terminate?.();
    this.worker = null;
  }
}

export function createCodexWorkerSource(options = {}) {
  return new CodexWorkerSource(options);
}
