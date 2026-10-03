import { emptyLiveSnapshot, normalizeEvents, normalizeSnapshot } from "./snapshot-contract.mjs";
import { safeLabel } from "./privacy.mjs";
import { createSnapshotSource } from "./snapshot-source.mjs";

const SUPPORTED_PROVIDERS = new Set(["codex", "sqlite", "observer", "local", "json", "jsonl", "ndjson", "snapshot", "snapshot-json", "snapshot-jsonl"]);
const PROVIDER_ALIASES = new Map([
  ["sqlite", "codex"],
  ["observer", "codex"],
  ["local", "codex"],
  ["ndjson", "jsonl"],
  ["snapshot-json", "json"],
  ["snapshot-jsonl", "jsonl"],
]);

function providerName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function inferProvider(options, env) {
  const explicit = providerName(options.provider);
  if (explicit) return { requested: explicit, source: "options" };
  const configured = providerName(env.AGENTARIUM_PROVIDER);
  if (configured) return { requested: configured, source: "environment" };
  const path = options.snapshotPath ?? env.AGENTARIUM_SNAPSHOT_PATH;
  if (typeof path === "string" && path.trim()) return { requested: "snapshot", source: "snapshot-path" };
  // A bare server start must remain harness-neutral. In particular, do not
  // turn an absent provider setting into an implicit read of Codex-local
  // SQLite databases. The browser can still request the synthetic Demo route,
  // while Live stays an explicit opt-in through AGENTARIUM_PROVIDER=codex or a
  // configured snapshot provider.
  return { requested: "snapshot", source: "default" };
}

function normalizedName(requested) {
  return PROVIDER_ALIASES.get(requested) ?? requested;
}

const HEALTH_BOOLEAN_FIELDS = [
  "ready", "readOnly", "configured", "recovered", "degraded", "isolated", "closed", "healthy", "normalizationError",
];
const HEALTH_NUMBER_FIELDS = ["refreshMs", "recordsRead", "skippedRecords"];
const HEALTH_TEXT_FIELDS = ["source", "format", "worker", "warning"];

function boundedHealthNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1_000_000_000, Math.trunc(number))) : undefined;
}

function safeHealthText(value) {
  if (typeof value !== "string") return undefined;
  const result = safeLabel(value, "", 160);
  return result.value || undefined;
}

function projectSchema(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  if (typeof value.valid === "boolean") result.valid = value.valid;
  if (value.state && typeof value.state === "object" && !Array.isArray(value.state)) {
    result.state = {
      valid: Boolean(value.state.valid),
      missingCount: boundedHealthNumber(value.state.missingCount) ?? 0,
    };
  }
  if (value.history && typeof value.history === "object" && !Array.isArray(value.history)) {
    result.history = {
      valid: Boolean(value.history.valid),
      missingCount: boundedHealthNumber(value.history.missingCount) ?? 0,
    };
  }
  if ("missingCount" in value) result.missingCount = boundedHealthNumber(value.missingCount) ?? 0;
  return Object.keys(result).length ? result : undefined;
}

function projectRetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {
    attempts: boundedHealthNumber(value.attempts) ?? 0,
    maxAttempts: boundedHealthNumber(value.maxAttempts) ?? 0,
    retrying: Boolean(value.retrying),
    nextAttemptAt: null,
  };
  if (typeof value.nextAttemptAt === "string" && Number.isFinite(Date.parse(value.nextAttemptAt))) {
    result.nextAttemptAt = new Date(value.nextAttemptAt).toISOString();
  }
  return result;
}

function projectDiagnostics(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of HEALTH_BOOLEAN_FIELDS) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  for (const key of HEALTH_NUMBER_FIELDS) {
    const bounded = boundedHealthNumber(input[key]);
    if (bounded !== undefined) result[key] = bounded;
  }
  for (const key of HEALTH_TEXT_FIELDS) {
    const safe = safeHealthText(input[key]);
    if (safe !== undefined) result[key] = safe;
  }
  const schema = projectSchema(input.schema);
  if (schema) result.schema = schema;
  const retry = projectRetry(input.retry);
  if (retry) result.retry = retry;
  for (const key of ["lastReadAt", "lastRefreshAt"]) {
    if (typeof input[key] === "string" && Number.isFinite(Date.parse(input[key]))) {
      result[key] = new Date(input[key]).toISOString();
    }
  }
  return result;
}

class UnavailableDataSource {
  constructor(provider, warning) {
    this.provider = provider;
    this.warning = warning;
    this.closed = false;
  }

  getSnapshot(options = {}) {
    return emptyLiveSnapshot(options.nowMs, [this.warning]);
  }

  getEvents() {
    return [];
  }

  diagnostics() {
    return { ready: false, provider: this.provider, source: this.provider, readOnly: true, configured: false, warning: this.warning };
  }

  close() {
    this.closed = true;
  }
}

class NormalizedSource {
  constructor(source, provider, ownsSource = true) {
    this.source = source;
    this.provider = provider;
    this.ownsSource = ownsSource;
    this.closed = false;
    this.normalizationFailed = false;
  }

  getSnapshot(options = {}) {
    if (this.closed) return emptyLiveSnapshot(options.nowMs, ["Data source is closed."]);
    try {
      const raw = this.source.getSnapshot(options);
      const normalized = normalizeSnapshot(raw, { ...options, mode: options.mode === "demo" ? "demo" : "live" });
      this.normalizationFailed = false;
      return normalized;
    } catch {
      this.normalizationFailed = true;
      return emptyLiveSnapshot(options.nowMs, ["Data source returned an invalid or privacy-unsafe snapshot."]);
    }
  }

  getEvents(agentId, options = {}) {
    if (this.closed) return [];
    try {
      const events = this.source.getEvents(agentId, options);
      return normalizeEvents(events, { agentId, nowMs: options.nowMs, limit: options.limit });
    } catch {
      return [];
    }
  }

  diagnostics() {
    if (this.closed) return { ready: false, provider: this.provider, readOnly: true, closed: true };
    let diagnostics = {};
    try { diagnostics = this.source.diagnostics?.() ?? {}; } catch { /* diagnostics are best effort */ }
    return {
      ...projectDiagnostics(diagnostics),
      ...(this.normalizationFailed ? { ready: false, healthy: false, normalizationError: true } : {}),
      provider: this.provider,
      readOnly: true,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsSource) this.source.close?.();
  }
}

/**
 * Select exactly one startup-configured source. Browser query parameters are
 * never consulted here. The resulting object has the same small interface
 * regardless of whether it is backed by Codex SQLite or a snapshot file.
 */
export function createDataSource(options = {}) {
  if (options.dataSource) {
    if (!isDataSource(options.dataSource)) {
      return new UnavailableDataSource("injected", "Injected data source does not implement the required interface.");
    }
    return new NormalizedSource(options.dataSource, "injected", false);
  }

  // Dependency injection is intentionally stronger than process startup
  // configuration. Tests and embedded integrations can provide an observer
  // without being redirected by a developer's shell environment.
  if (options.observer && typeof options.observer.getSnapshot === "function") {
    return new NormalizedSource(options.observer, "codex-sqlite", false);
  }

  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const selection = inferProvider(options, env);
  const requested = selection.requested;
  if (!SUPPORTED_PROVIDERS.has(requested)) {
    return new UnavailableDataSource(requested || "unknown", "Configured data source provider is not supported.");
  }

  const selected = normalizedName(requested);
  if (selected === "codex") {
    if (typeof options.createCodexWorkerSource === "function") {
      try {
        const workerSource = options.createCodexWorkerSource(options);
        if (isDataSource(workerSource)) return new NormalizedSource(workerSource, "codex-sqlite", true);
      } catch {
        return new UnavailableDataSource("codex-sqlite", "The isolated Codex adapter could not be started.");
      }
    }
    const observer = options.createObserver?.(options);
    if (!observer) {
      return new UnavailableDataSource("codex-sqlite", "The Codex adapter was not loaded by this startup entrypoint.");
    }
    return new NormalizedSource(observer, "codex-sqlite", true);
  }

  const snapshotPath = options.snapshotPath ?? env.AGENTARIUM_SNAPSHOT_PATH;
  const format = selected === "snapshot" ? undefined : selected;
  if (!snapshotPath || (typeof snapshotPath === "string" && !snapshotPath.trim())) {
    const provider = format === "jsonl" ? "snapshot-jsonl" : "snapshot-json";
    return new UnavailableDataSource(provider, "Snapshot source was not configured.");
  }
  const source = createSnapshotSource({ snapshotPath, format });
  return new NormalizedSource(source, source.provider, true);
}

export function dataSourceSelection(options = {}) {
  if (options.dataSource) {
    return { requested: "injected", source: "options", provider: "injected", configuredPath: false };
  }
  if (options.observer && typeof options.observer.getSnapshot === "function") {
    return { requested: "observer", source: "options", provider: "codex", configuredPath: false };
  }
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const selection = inferProvider(options, env);
  return {
    requested: selection.requested,
    source: selection.source,
    provider: normalizedName(selection.requested),
    configuredPath: Boolean(options.snapshotPath ?? env.AGENTARIUM_SNAPSHOT_PATH),
  };
}

export function isDataSource(value) {
  return Boolean(value)
    && typeof value.getSnapshot === "function"
    && typeof value.getEvents === "function"
    && typeof value.diagnostics === "function"
    && typeof value.close === "function";
}

/**
 * Load the optional Codex adapter only when startup actually selected it.
 * JSON/JSONL harnesses never import node:sqlite or touch Codex-local paths.
 */
export async function loadDataSourceOptions(options = {}) {
  if (options.dataSource || options.observer || options.createObserver) return options;
  const selection = dataSourceSelection(options);
  if (selection.provider !== "codex") return options;
  const { createCodexWorkerSource } = await import("./data-source-runtime.mjs");
  return { ...options, createCodexWorkerSource };
}
