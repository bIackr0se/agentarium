import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDemoSnapshot } from "./fixtures.mjs";
import { assertPrivacySafe, redactText, safeLabel, safeWarning } from "./privacy.mjs";
import {
  classifyItem,
  classifyThread,
  isActiveState,
  isAttentionState,
  stateAction,
  STALE_AFTER_MS,
} from "./classifier.mjs";

export const DEFAULT_STATE_DB = join(homedir(), ".codex", "state_5.sqlite");
export const DEFAULT_HISTORY_DB = join(homedir(), ".codex", "thread_history_1.sqlite");
export const DEFAULT_CATALOG_DB = join(homedir(), ".codex", "sqlite", "codex-dev.db");

const MAX_EVENT_LIMIT = 24;
const MAX_AGENT_LIMIT = 240;
const DEFAULT_OPEN_RETRY_AFTER_MS = 1_000;
const MAX_OPEN_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_OPEN_ATTEMPTS = 3;
const MAX_OPEN_ATTEMPTS = 5;
const DEFAULT_SNAPSHOT_EVENT_LIMIT = 4;
const RECENT_ARCHIVED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const COLORS = ["#7ee7d1", "#f4b860", "#a99bff", "#f58ca8", "#79a7ff", "#b6e27a"];
const OPTIONAL_THREAD_COLUMNS = Object.freeze(["name", "agent_nickname", "agent_role"]);
const CATALOG_REQUIRED_COLUMNS = Object.freeze(["thread_id", "display_title", "missing_candidate", "source_recency_at"]);
const MAX_CATALOG_ROWS = 5000;
const LIFECYCLE_CANDIDATE_LIMIT = 16;
const MAX_LIFECYCLE_JSON_BYTES = 32 * 1024;
export const HISTORY_ITEM_METADATA_COLUMNS = Object.freeze([
  "thread_id",
  "turn_id",
  "item_id",
  "rollout_ordinal",
  "created_at_ms",
  "item_type",
]);
const HISTORY_ITEM_METADATA_SELECT = HISTORY_ITEM_METADATA_COLUMNS.join(", ");

const REQUIRED_SCHEMA = Object.freeze({
  state: {
    threads: [
      "id", "title", "created_at", "updated_at", "updated_at_ms", "archived", "source",
      "model", "reasoning_effort", "tokens_used", "approval_mode", "git_branch", "agent_path",
      "project_id", "cwd",
    ],
    projects: ["id", "name"],
    thread_spawn_edges: ["parent_thread_id", "child_thread_id", "status"],
  },
  history: {
    thread_turns: [
      "thread_id", "turn_id", "rollout_ordinal", "status", "started_at", "completed_at", "duration_ms",
    ],
    thread_items: ["thread_id", "turn_id", "item_id", "rollout_ordinal", "created_at_ms", "item_json", "item_type"],
  },
});

const CATALOG_SCHEMA = Object.freeze({
  local_thread_catalog: CATALOG_REQUIRED_COLUMNS,
});

const EVENT_LABELS = Object.freeze({
  reasoning: "Thinking",
  userMessage: "New task input",
  agentMessage: "Agent response",
  commandExecution: "Command activity",
  fileChange: "File change",
  mcpToolCall: "Tool activity",
  dynamicToolCall: "Tool activity",
  webSearch: "Evidence lookup",
  imageView: "Image inspection",
  imageGeneration: "Artifact generation",
  subAgentActivity: "Agent delegation",
  collabAgentToolCall: "Agent collaboration",
  contextCompaction: "Context maintenance",
  verification: "Verification activity",
  approval: "Approval requested",
  approvalRequest: "Approval requested",
});

const EVENT_KIND = Object.freeze({
  reasoning: "turn",
  userMessage: "message",
  agentMessage: "message",
  commandExecution: "command",
  fileChange: "file",
  mcpToolCall: "tool",
  dynamicToolCall: "tool",
  webSearch: "tool",
  imageView: "tool",
  imageGeneration: "tool",
  subAgentActivity: "collaboration",
  collabAgentToolCall: "collaboration",
  contextCompaction: "system",
  verification: "verification",
  approval: "approval",
  approvalRequest: "approval",
});

const ALLOWED_EVENT_KINDS = new Set(["turn", "command", "file", "tool", "collaboration", "message", "approval", "verification", "system"]);
const ALLOWED_EVENT_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted", "declined"]);
const ALLOWED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const ALLOWED_EFFORT = /^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/;
const GENERIC_ASSIGNMENT_NAMES = new Set(["agent", "default", "root", "task", "thread", "unknown", "untitled", "worker"]);

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteInt(value, fallback = null) {
  const n = finiteNumber(value, fallback);
  return n === null ? fallback : Math.trunc(n);
}

function timestampMs(value, fallback = null) {
  const n = finiteNumber(value, fallback);
  if (n === null || n <= 0) return fallback;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function isoTime(value, fallbackMs) {
  const ms = timestampMs(value, fallbackMs);
  if (ms === null || !Number.isFinite(ms)) return new Date(0).toISOString();
  try {
    return new Date(Math.max(0, ms)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function isoMilliseconds(value, fallbackMs) {
  const ms = finiteNumber(value, fallbackMs);
  if (ms === null || !Number.isFinite(ms)) return new Date(0).toISOString();
  try {
    return new Date(Math.max(0, ms)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function safeOpaqueId(value, fallback = "unknown") {
  const source = typeof value === "string" ? value : "";
  const sanitized = redactText(source);
  if (SAFE_ID.test(source) && sanitized.redactions === 0) return source;
  if (!source) return fallback;
  return `id-${hash(source).slice(0, 16)}`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function basenameWithoutPath(value) {
  if (typeof value !== "string") return "";
  const pieces = value.split(/[\\/]/).filter(Boolean);
  const last = pieces.at(-1) ?? "";
  return last.replace(/^[.]+$/, "");
}

function assignmentLabel(value) {
  const basename = basenameWithoutPath(value).trim();
  if (!basename) return { value: "", redactions: 0 };

  // Detect secrets before humanizing separators. Replacing `_` or `-` first
  // can disguise patterns such as `api_key=...` from the privacy scanner.
  const safe = safeLabel(basename, "", 64);
  if (!safe.value || safe.redactions > 0) return { value: "", redactions: safe.redactions };

  const normalized = safe.value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return { value: "", redactions: 0 };
  if (GENERIC_ASSIGNMENT_NAMES.has(normalized.toLocaleLowerCase())) return { value: "", redactions: 0 };

  const lower = normalized.toLocaleLowerCase();
  const firstLetter = lower.search(/[\p{L}]/u);
  const display = firstLetter < 0
    ? lower
    : `${lower.slice(0, firstLetter)}${lower[firstLetter].toLocaleUpperCase()}${lower.slice(firstLetter + 1)}`;
  return { value: display, redactions: safe.redactions };
}

function safeProjectName(value, fallback = "Unassigned") {
  const result = safeLabel(value, fallback, 64);
  return { name: result.value || fallback, redactions: result.redactions };
}

function safeThreadTitle(value, fallback) {
  // The persisted title may be synthesized from the first user message.  A
  // long title is therefore treated as transcript-like and not truncated into
  // the browser.  Short task names remain useful in the island view.
  if (typeof value === "string" && value.trim().length > 96) {
    return { value: fallback, redactions: 1 };
  }
  return safeLabel(value, fallback, 96);
}

function meaningfulThreadTitle(value) {
  return typeof value === "string" && /[\p{L}\p{N}]/u.test(value);
}

function catalogValueIsMissing(value) {
  return !(value === false || value === 0 || value === "0" || value === "false");
}

function catalogRecency(value) {
  const n = finiteNumber(value);
  return n === null ? Number.NEGATIVE_INFINITY : n;
}

function readCatalogTitles(db) {
  if (!db) return null;
  try {
    const rows = db.prepare(`
      SELECT thread_id, display_title, missing_candidate, source_recency_at
      FROM local_thread_catalog
      ORDER BY source_recency_at DESC, thread_id DESC
      LIMIT ?
    `).all(MAX_CATALOG_ROWS);
    const titles = new Map();
    for (const row of rows) {
      const threadId = typeof row.thread_id === "string" ? row.thread_id : "";
      if (!threadId || catalogValueIsMissing(row.missing_candidate)) continue;
      const recency = catalogRecency(row.source_recency_at);
      const current = titles.get(threadId);
      if (!current) titles.set(threadId, { value: "", redactions: 0, recency });
      const candidate = safeThreadTitle(row.display_title, "");
      if (!meaningfulThreadTitle(candidate.value)) continue;
      if (!current || !current.value || recency > current.recency) {
        titles.set(threadId, { value: candidate.value, redactions: candidate.redactions, recency });
      }
    }
    return titles;
  } catch {
    // An optional catalog that cannot be read must not disable the main
    // observer or change the legacy title path.
    return null;
  }
}

function taskTitle(row, threadId, catalogEntry) {
  let redactions = 0;
  if (catalogEntry?.value) return { value: catalogEntry.value, redactions: catalogEntry.redactions };
  for (const candidate of [row.name, row.title]) {
    const result = safeThreadTitle(candidate, "");
    redactions += result.redactions;
    if (meaningfulThreadTitle(result.value)) return { value: result.value, redactions };
  }
  const suffix = threadId.slice(-8) || "unknown";
  return { value: `Untitled task · ${suffix}`, redactions };
}

function optionalThreadLabel(value, maxLength) {
  if (typeof value !== "string" || !value.trim()) return { value: "", redactions: 0 };
  return safeLabel(value, "", maxLength);
}

function projectColor(projectId) {
  const index = Number.parseInt(hash(projectId).slice(0, 8), 16) % COLORS.length;
  return COLORS[index];
}

function modelValue(value) {
  if (typeof value !== "string" || !ALLOWED_MODEL.test(value)) return undefined;
  const result = safeLabel(value, "", 80);
  if (result.redactions || !ALLOWED_MODEL.test(result.value)) return undefined;
  return result.value;
}

function effortValue(value) {
  if (typeof value !== "string" || !ALLOWED_EFFORT.test(value)) return undefined;
  return value;
}

function normalizeItemStatus(item) {
  if (!item || typeof item !== "object") return undefined;
  const candidates = [item.status, item.result && typeof item.result === "object" ? item.result.status : undefined];
  for (const candidate of candidates) {
    let status = typeof candidate === "string" ? candidate : "";
    if (status === "in_progress" || status === "in-progress") status = "inProgress";
    if (status === "complete") status = "completed";
    if (ALLOWED_EVENT_STATUSES.has(status)) return status;
  }
  return undefined;
}

function durationValue(item, fallback = undefined) {
  const value = item && typeof item === "object" ? finiteInt(item.durationMs, fallback) : fallback;
  if (value === undefined || value === null || value < 0) return undefined;
  return Math.min(value, 24 * 60 * 60 * 1000);
}

function eventForItem(threadId, row, parsed, nowMs) {
  const type = typeof row.item_type === "string" ? row.item_type : "";
  const inferred = classifyItem(type, parsed);
  const kind = ALLOWED_EVENT_KINDS.has(EVENT_KIND[type]) ? EVENT_KIND[type] : "system";
  const status = normalizeItemStatus(parsed);
  const event = {
    id: safeOpaqueId(`${threadId}:item:${row.item_id}`, `event-${hash(`${threadId}:${row.rollout_ordinal}`).slice(0, 16)}`),
    agentId: safeOpaqueId(threadId),
    timestamp: isoMilliseconds(row.created_at_ms, nowMs),
    kind,
    label: EVENT_LABELS[type] ?? "Activity observed",
    state: inferred.state,
    source: "history-db",
    evidence: status ? "observed" : inferred.evidence,
  };
  const durationMs = durationValue(parsed);
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (status) event.status = status;
  return event;
}

function eventForTurn(threadId, turn, nowMs) {
  if (!turn || typeof turn !== "object") return null;
  let status = typeof turn.status === "string" ? turn.status : "";
  if (status === "in_progress" || status === "in-progress") status = "inProgress";
  if (status === "complete") status = "completed";
  const state = status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : status === "completed" ? "complete" : status === "inProgress" ? "thinking" : "unknown";
  const event = {
    id: safeOpaqueId(`${threadId}:turn:${turn.turn_id}`, `turn-${hash(`${threadId}:${turn.rollout_ordinal}`).slice(0, 16)}`),
    agentId: safeOpaqueId(threadId),
    timestamp: isoTime(turn.completed_at ?? turn.started_at, nowMs),
    kind: "turn",
    label: status === "inProgress" ? "Turn in progress" : status === "completed" ? "Turn completed" : status === "failed" ? "Turn failed" : status === "interrupted" ? "Turn interrupted" : "Turn state unavailable",
    state,
    source: "history-db",
    evidence: status ? "observed" : "unknown",
  };
  const durationMs = finiteInt(turn.duration_ms);
  if (durationMs !== null && durationMs >= 0) event.durationMs = Math.min(durationMs, 24 * 60 * 60 * 1000);
  if (ALLOWED_EVENT_STATUSES.has(status)) event.status = status;
  return event;
}

function parseItem(row) {
  if (!row || typeof row.item_json !== "string") return null;
  try {
    const parsed = JSON.parse(row.item_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function latestByWallClock(rows, timestampFor) {
  let latest = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestOrdinal = Number.NEGATIVE_INFINITY;
  for (const row of Array.isArray(rows) ? rows : []) {
    const time = timestampFor(row);
    const ordinal = finiteNumber(row?.rollout_ordinal, Number.NEGATIVE_INFINITY);
    if (time > latestTime || (time === latestTime && ordinal > latestOrdinal)) {
      latest = row;
      latestTime = time;
      latestOrdinal = ordinal;
    }
  }
  return latest;
}

function latestTurnByWallClock(rows) {
  return latestByWallClock(rows, (row) => timestampMs(row?.completed_at ?? row?.started_at, Number.NEGATIVE_INFINITY));
}

function latestItemByWallClock(rows) {
  return latestByWallClock(rows, (row) => finiteNumber(row?.created_at_ms, Number.NEGATIVE_INFINITY));
}

export function selectRecentItemRows(rows, limit = 12) {
  const boundedLimit = Math.max(1, Math.min(MAX_EVENT_LIMIT, finiteInt(limit, 12) ?? 12));
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => {
      const timeDiff = finiteNumber(b?.created_at_ms, Number.NEGATIVE_INFINITY)
        - finiteNumber(a?.created_at_ms, Number.NEGATIVE_INFINITY);
      if (timeDiff) return timeDiff;
      return finiteNumber(b?.rollout_ordinal, Number.NEGATIVE_INFINITY)
        - finiteNumber(a?.rollout_ordinal, Number.NEGATIVE_INFINITY);
    })
    .slice(0, boundedLimit);
}

export function buildRecentEvents(threadId, turn, itemRows, nowMs, eventLimit = 12) {
  const id = safeOpaqueId(threadId);
  const events = [];
  const turnEvent = eventForTurn(id, turn, nowMs);
  if (turnEvent) events.push(turnEvent);
  for (const row of Array.isArray(itemRows) ? itemRows : []) {
    events.push(eventForItem(id, row, parseItem(row), nowMs));
  }
  events.sort((a, b) => {
    const timeDiff = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (timeDiff) return timeDiff;
    // A turn boundary and its first item can share a timestamp.  The item is
    // the more actionable event, so keep it ahead of the aggregate turn row.
    if (a.kind === "turn" && b.kind !== "turn") return 1;
    if (a.kind !== "turn" && b.kind === "turn") return -1;
    return b.id.localeCompare(a.id);
  });
  return events.slice(0, Math.max(1, Math.min(MAX_EVENT_LIMIT, finiteInt(eventLimit, 12) ?? 12)));
}

function emptyLiveSnapshot(nowMs, warnings = []) {
  const generatedAt = isoMilliseconds(nowMs, Date.now());
  const snapshot = {
    schemaVersion: 1,
    mode: "live",
    generatedAt,
    sourceFreshness: "unknown",
    projects: [],
    agents: [],
    attention: [],
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: [...new Set(["Live observer returned no browser-visible records.", ...warnings.map((warning) => safeWarning(warning))])].slice(0, 8),
  };
  // This literal is maintained as a second guard against future warning edits.
  try {
    assertPrivacySafe(snapshot);
  } catch {
    snapshot.warnings = ["Live observer privacy boundary rejected the payload."];
  }
  return snapshot;
}

function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
  return new Set(rows.map((row) => String(row.name)));
}

function detectDatabaseSchema(db, required) {
  const missing = [];
  const tables = {};
  for (const [table, columns] of Object.entries(required)) {
    const available = tableColumns(db, table);
    tables[table] = available.size > 0;
    if (!available.size) {
      missing.push(`${table} (table)`);
      continue;
    }
    for (const column of columns) {
      if (!available.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return { valid: missing.length === 0, missing, tables };
}

function safeSchema(schema) {
  return {
    valid: Boolean(schema?.valid),
    missingCount: Array.isArray(schema?.missing) ? schema.missing.length : 0,
  };
}

export class LocalObserver {
  constructor(options = {}) {
    this.stateDbPath = options.stateDbPath ?? DEFAULT_STATE_DB;
    this.historyDbPath = options.historyDbPath ?? DEFAULT_HISTORY_DB;
    this.catalogDbPath = options.catalogDbPath ?? DEFAULT_CATALOG_DB;
    this.maxAgents = Math.max(1, Math.min(MAX_AGENT_LIMIT, finiteInt(options.maxAgents, 36) ?? 36));
    this.eventLimit = Math.max(1, Math.min(MAX_EVENT_LIMIT, finiteInt(options.eventLimit, 12) ?? 12));
    this.snapshotEventLimit = Math.max(1, Math.min(this.eventLimit, finiteInt(options.snapshotEventLimit, DEFAULT_SNAPSHOT_EVENT_LIMIT) ?? DEFAULT_SNAPSHOT_EVENT_LIMIT));
    this.staleAfterMs = Math.max(1, finiteInt(options.staleAfterMs, STALE_AFTER_MS) ?? STALE_AFTER_MS);
    this.openRetryAfterMs = Math.max(0, Math.min(MAX_OPEN_RETRY_AFTER_MS, finiteInt(options.openRetryAfterMs, DEFAULT_OPEN_RETRY_AFTER_MS) ?? DEFAULT_OPEN_RETRY_AFTER_MS));
    this.maxOpenAttempts = Math.max(1, Math.min(MAX_OPEN_ATTEMPTS, finiteInt(options.maxOpenAttempts, DEFAULT_MAX_OPEN_ATTEMPTS) ?? DEFAULT_MAX_OPEN_ATTEMPTS));
    this._initialized = false;
    this._closed = false;
    this._openAttempts = 0;
    this._nextOpenAt = 0;
    this._openFailure = false;
    this._stateDb = null;
    this._historyDb = null;
    this._catalogDb = null;
    this._schema = { valid: false, missing: ["not_checked"], state: null, history: null };
    this._catalogSchema = null;
    this._openWarnings = [];
    this._optionalThreadColumns = new Set();
  }

  _ensureOpen(nowMs = Date.now()) {
    if (this._closed) return;
    const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (this._initialized) return;
    if (this._openFailure && (this._openAttempts >= this.maxOpenAttempts || currentMs < this._nextOpenAt)) return;
    this._openFailure = false;
    this._openAttempts += 1;
    this._initialized = true;
    this._schema = { valid: false, missing: ["not_checked"], state: null, history: null };
    this._catalogSchema = null;
    this._openWarnings = [];
    this._optionalThreadColumns = new Set();
    this._closeDb("state");
    this._closeDb("history");
    this._closeDb("catalog");
    let mainOpenFailure = false;
    try {
      this._stateDb = new DatabaseSync(this.stateDbPath, { readOnly: true });
      this._stateDb.exec("PRAGMA query_only=ON");
      this._schema.state = detectDatabaseSchema(this._stateDb, REQUIRED_SCHEMA.state);
      const available = tableColumns(this._stateDb, "threads");
      this._optionalThreadColumns = new Set(OPTIONAL_THREAD_COLUMNS.filter((column) => available.has(column)));
    } catch {
      mainOpenFailure = true;
      this._openWarnings.push("State database is unavailable or unreadable.");
      this._schema.state = { valid: false, missing: ["state database"], tables: {} };
      this._closeDb("state");
    }
    try {
      this._historyDb = new DatabaseSync(this.historyDbPath, { readOnly: true });
      this._historyDb.exec("PRAGMA query_only=ON");
      this._schema.history = detectDatabaseSchema(this._historyDb, REQUIRED_SCHEMA.history);
    } catch {
      mainOpenFailure = true;
      this._openWarnings.push("History database is unavailable or unreadable.");
      this._schema.history = { valid: false, missing: ["history database"], tables: {} };
      this._closeDb("history");
    }
    try {
      this._catalogDb = new DatabaseSync(this.catalogDbPath, { readOnly: true });
      this._catalogDb.exec("PRAGMA query_only=ON");
      this._catalogSchema = detectDatabaseSchema(this._catalogDb, CATALOG_SCHEMA);
      if (!this._catalogSchema.valid) this._closeDb("catalog");
    } catch {
      this._catalogSchema = { valid: false, missing: ["catalog database"], tables: {} };
      this._closeDb("catalog");
    }
    const missing = [
      ...(this._schema.state?.missing ?? []).map((item) => `state schema: ${item}`),
      ...(this._schema.history?.missing ?? []).map((item) => `history schema: ${item}`),
    ];
    this._schema.valid = Boolean(this._schema.state?.valid && this._schema.history?.valid);
    this._schema.missing = missing;
    if (mainOpenFailure) {
      this._openFailure = true;
      this._initialized = false;
      this._nextOpenAt = currentMs + this.openRetryAfterMs;
    }
  }

  _closeDb(which) {
    const key = which === "state" ? "_stateDb" : which === "history" ? "_historyDb" : "_catalogDb";
    try {
      this[key]?.close();
    } catch {
      // The close operation is best effort during a failed startup.
    }
    this[key] = null;
  }

  diagnostics() {
    if (this._closed) {
      return {
        ready: false,
        provider: "codex-sqlite",
        schema: { valid: false, state: { valid: false, missingCount: 0 }, history: { valid: false, missingCount: 0 }, missingCount: 0 },
        readOnly: true,
        source: "local observer",
        closed: true,
      };
    }
    this._ensureOpen();
    return {
      ready: Boolean(this._schema.valid && this._stateDb && this._historyDb),
      provider: "codex-sqlite",
      schema: {
        valid: Boolean(this._schema.valid),
        state: safeSchema(this._schema.state),
        history: safeSchema(this._schema.history),
        missingCount: this._schema.missing.length,
      },
      readOnly: true,
      source: "local observer",
      retry: {
        attempts: this._openAttempts,
        maxAttempts: this.maxOpenAttempts,
        retrying: this._openFailure && this._openAttempts < this.maxOpenAttempts,
        nextAttemptAt: this._openFailure && this._openAttempts < this.maxOpenAttempts
          ? new Date(Math.max(0, this._nextOpenAt)).toISOString()
          : null,
      },
    };
  }

  getSnapshot(options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    if (this._closed) return emptyLiveSnapshot(nowMs, ["Live observer is closed."]);
    if (options.mode === "demo") return createDemoSnapshot(nowMs);
    this._ensureOpen(nowMs);
    if (!this._schema.valid || !this._stateDb || !this._historyDb) {
      return emptyLiveSnapshot(nowMs, ["Live observer stopped because the local schema was not recognized.", ...this._openWarnings]);
    }
    try {
      const snapshot = this._readLiveSnapshot(nowMs);
      assertPrivacySafe(snapshot);
      return snapshot;
    } catch {
      return emptyLiveSnapshot(nowMs, ["Live observer stopped after an unreadable local record."]);
    }
  }

  _readLiveSnapshot(nowMs) {
    const state = this._stateDb;
    const history = this._historyDb;
    const projectRows = state.prepare("SELECT id, name, position FROM projects ORDER BY position ASC, id ASC").all();
    const projectLookup = new Map();
    let redactions = 0;
    for (const row of projectRows) {
      const id = safeOpaqueId(row.id, `project-${hash(row.id).slice(0, 16)}`);
      const project = safeProjectName(row.name, "Unnamed project");
      redactions += project.redactions;
      projectLookup.set(String(row.id), { id, name: project.name, color: projectColor(id) });
    }

    const cutoff = nowMs - RECENT_ARCHIVED_WINDOW_MS;
    const catalogTitles = this._catalogSchema?.valid && this._catalogDb ? readCatalogTitles(this._catalogDb) : null;
    const optionalThreadSelect = OPTIONAL_THREAD_COLUMNS.map((column) => (
      this._optionalThreadColumns.has(column) ? `"${column}" AS "${column}"` : `NULL AS "${column}"`
    )).join(",\n             ");
    const candidateThreadRows = state.prepare(`
      SELECT id, title, created_at, updated_at, updated_at_ms, archived, source,
             model, reasoning_effort, tokens_used, approval_mode, git_branch,
             agent_path, project_id, cwd,
             ${optionalThreadSelect}
      FROM threads
      WHERE archived = 0 OR updated_at_ms >= ?
      ORDER BY updated_at_ms DESC, id DESC
      LIMIT ?
    `).all(cutoff, this.maxAgents);

    const edges = state.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges").all();
    const childIds = new Set(edges.map((edge) => String(edge.child_thread_id ?? "")).filter(Boolean));
    const edgeParticipants = new Set();
    for (const edge of edges) {
      const parent = String(edge.parent_thread_id ?? "");
      const child = String(edge.child_thread_id ?? "");
      if (parent) edgeParticipants.add(parent);
      if (child) edgeParticipants.add(child);
    }
    const threadRows = catalogTitles === null ? candidateThreadRows : candidateThreadRows.filter((row) => {
      const rawId = String(row.id ?? "");
      const isRoot = !childIds.has(rawId);
      if (!isRoot) return true;
      const hasName = typeof row.name === "string" && row.name.trim().length > 0;
      const hasTitle = meaningfulThreadTitle(safeThreadTitle(row.title, "").value);
      return hasName || hasTitle || catalogTitles.has(rawId) || edgeParticipants.has(rawId);
    });

    const selectedIds = new Set(threadRows.map((row) => String(row.id)));
    const parentByChild = new Map();
    const childrenByParent = new Map();
    for (const edge of edges) {
      const parent = String(edge.parent_thread_id ?? "");
      const child = String(edge.child_thread_id ?? "");
      if (!parent || !child) continue;
      if (!selectedIds.has(child)) continue;
      parentByChild.set(child, safeOpaqueId(parent));
      const children = childrenByParent.get(parent) ?? new Set();
      children.add(child);
      childrenByParent.set(parent, children);
    }

    const turnStatement = history.prepare(`
      SELECT thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms
      FROM thread_turns
      WHERE thread_id = ?
      ORDER BY rollout_ordinal DESC
      LIMIT ?
    `);
    const latestItemStatement = history.prepare(`
      SELECT ${HISTORY_ITEM_METADATA_SELECT}
      FROM thread_items
      WHERE thread_id = ? AND turn_id = ?
      ORDER BY rollout_ordinal DESC
      LIMIT ?
    `);
    const eventItemStatement = history.prepare(`
      SELECT ${HISTORY_ITEM_METADATA_SELECT}
      FROM thread_items
      WHERE thread_id = ?
      ORDER BY rollout_ordinal DESC
      LIMIT ?
    `);
    const itemPayloadStatement = history.prepare(`
      SELECT CASE
        WHEN length(CAST(item_json AS BLOB)) <= ? THEN item_json
        ELSE NULL
      END AS item_json
      FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND item_id = ?
      LIMIT 1
    `);

    const agents = [];
    const projectAgents = new Map();
    let newestMs = null;
    let malformedItems = 0;
    for (const row of threadRows) {
      const threadId = safeOpaqueId(row.id, `thread-${hash(row.id).slice(0, 16)}`);
      // The history database indexes rollout ordinals, not wall-clock columns.
      // Read a bounded indexed tail, then resolve clock skew in memory. Sorting
      // an unbounded task history by created_at can block the localhost server.
      const turnRows = turnStatement.all(row.id, LIFECYCLE_CANDIDATE_LIMIT);
      const turn = latestTurnByWallClock(turnRows);
      const itemCandidateLimit = Math.max(LIFECYCLE_CANDIDATE_LIMIT, this.snapshotEventLimit * 4);
      const itemRows = eventItemStatement.all(row.id, itemCandidateLimit);
      const latestRows = turn?.turn_id
        ? latestItemStatement.all(row.id, turn.turn_id, LIFECYCLE_CANDIDATE_LIMIT)
        : itemRows;
      const latestRow = latestItemByWallClock(latestRows);
      const payloads = new Map();
      const hydrate = (candidate) => {
        if (!candidate) return null;
        const key = `${candidate.turn_id}\u0000${candidate.item_id}`;
        let itemJson = payloads.get(key);
        if (itemJson === undefined) {
          const payload = itemPayloadStatement.get(MAX_LIFECYCLE_JSON_BYTES, candidate.thread_id, candidate.turn_id, candidate.item_id);
          itemJson = typeof payload?.item_json === "string" ? payload.item_json : "";
          payloads.set(key, itemJson);
        }
        return { ...candidate, item_json: itemJson };
      };
      const latestHydratedRow = hydrate(latestRow);
      const latestItem = latestHydratedRow ? parseItem(latestHydratedRow) : null;
      if (latestRow && !latestItem) malformedItems += 1;
      const recentItemRows = selectRecentItemRows(itemRows, this.snapshotEventLimit)
        .map(hydrate)
        .filter(Boolean);

      const lifecycleMs = Math.max(
        timestampMs(turn?.completed_at ?? turn?.started_at, 0) ?? 0,
        finiteNumber(latestRow?.created_at_ms, 0) ?? 0,
      );

      const classification = classifyThread({
        // Parent metadata can be refreshed when a child changes. Prefer the
        // agent's own turn/item clock so a historical stopped run does not
        // look newly interrupted.
        thread: lifecycleMs > 0 ? { ...row, updated_at_ms: lifecycleMs } : row,
        turn,
        latestItem,
        latestItemType: latestRow?.item_type ?? "",
        nowMs,
        staleAfterMs: this.staleAfterMs,
      });
      const seenMs = classification.lastSeenMs ?? nowMs;
      if (classification.lastSeenMs !== null && (newestMs === null || classification.lastSeenMs > newestMs)) newestMs = classification.lastSeenMs;
      const cwdBase = basenameWithoutPath(row.cwd);
      let project = row.project_id !== null && projectLookup.get(String(row.project_id));
      if (!project) {
        const projectName = safeProjectName(cwdBase, "Unassigned");
        redactions += projectName.redactions;
        const derivedId = `project-${hash(projectName.name.toLowerCase()).slice(0, 16)}`;
        project = projectLookup.get(derivedId) ?? { id: derivedId, name: projectName.name, color: projectColor(derivedId) };
        projectLookup.set(derivedId, project);
      }

      const title = taskTitle(row, threadId, catalogTitles?.get(String(row.id)));
      redactions += title.redactions;
      const agent = {
        id: threadId,
        title: title.value,
        projectId: project.id,
        projectName: project.name,
        state: classification.state,
        evidence: classification.evidence,
        lastSeen: isoMilliseconds(seenMs, nowMs),
        ageMs: classification.ageMs ?? 0,
        currentAction: classification.currentAction || stateAction(classification.state),
        childCount: childrenByParent.get(String(row.id))?.size ?? 0,
        events: buildRecentEvents(threadId, turn, recentItemRows, nowMs, this.snapshotEventLimit),
      };
      const nickname = optionalThreadLabel(row.agent_nickname, 48);
      redactions += nickname.redactions;
      if (nickname.value) agent.nickname = nickname.value;
      const role = optionalThreadLabel(row.agent_role, 64);
      redactions += role.redactions;
      if (role.value) agent.role = role.value;
      const assignment = assignmentLabel(row.agent_path);
      redactions += assignment.redactions;
      if (assignment.value) agent.assignment = assignment.value;
      const model = modelValue(row.model);
      if (model) agent.model = model;
      const effort = effortValue(row.reasoning_effort);
      if (effort) agent.reasoningEffort = effort;
      const tokenUsage = finiteInt(row.tokens_used);
      if (tokenUsage !== null && tokenUsage >= 0) agent.tokenUsage = Math.min(tokenUsage, 10 ** 12);
      const branch = safeLabel(row.git_branch, "", 80);
      redactions += branch.redactions;
      if (branch.value) agent.branch = branch.value;
      const parentAgentId = parentByChild.get(String(row.id));
      if (parentAgentId) agent.parentAgentId = parentAgentId;
      if (classification.attentionReason) agent.attentionReason = classification.attentionReason;
      agents.push(agent);
      const ids = projectAgents.get(project.id) ?? [];
      ids.push(agent.id);
      projectAgents.set(project.id, ids);
    }

    // Keep the project list bounded to projects represented in this snapshot,
    // while retaining deterministic DB order for display.
    const projects = [...projectLookup.values()]
      .filter((project) => projectAgents.has(project.id))
      .map((project) => {
        const ids = projectAgents.get(project.id) ?? [];
        const members = ids.map((id) => agents.find((agent) => agent.id === id)).filter(Boolean);
        const memberAttention = members.filter((agent) => (
          isAttentionState(agent.state) && (agent.state !== "failed" || !agent.parentAgentId)
        ));
        return {
          id: project.id,
          name: project.name,
          color: project.color,
          agentIds: ids,
          activeCount: members.filter((agent) => isActiveState(agent.state)).length,
          attentionCount: memberAttention.length,
        };
      });
    // A child run can fail while its parent keeps going or completes. Preserve
    // that outcome on the child's card and event trail, but reserve the global
    // queue for waits, human gates, and failed root runs.
    const attention = agents
      .filter((agent) => isAttentionState(agent.state) && (agent.state !== "failed" || !agent.parentAgentId))
      .map((agent) => agent.id);
    const snapshot = {
      schemaVersion: 1,
      mode: "live",
      generatedAt: isoMilliseconds(nowMs, Date.now()),
      sourceFreshness: newestMs === null ? "unknown" : isoMilliseconds(newestMs, nowMs),
      sourceLabel: "Local adapter",
      projects,
      agents,
      attention,
      privacy: { rawContentExposed: false, redactionsApplied: redactions },
      warnings: [
        "Read-only local observer: transcript text and tool payloads are omitted.",
        ...(malformedItems ? ["Some local lifecycle records were malformed and classified conservatively."] : []),
      ],
    };
    assertPrivacySafe(snapshot);
    return snapshot;
  }

  getEvents(threadId, options = {}) {
    const normalized = typeof threadId === "string" ? threadId : "";
    if (!normalized || normalized.length > 200 || /[^A-Za-z0-9_.:-]/.test(normalized)) return [];
    if (this._closed) return [];
    if (options.mode === "demo") {
      const snapshot = createDemoSnapshot(Number.isFinite(options.nowMs) ? options.nowMs : Date.now());
      return snapshot.agents.find((agent) => agent.id === normalized)?.events ?? [];
    }
    this._ensureOpen(Number.isFinite(options.nowMs) ? options.nowMs : Date.now());
    if (!this._schema.valid || !this._historyDb) return [];
    try {
      const turn = this._historyDb.prepare(`
        SELECT thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms
        FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1
      `).get(normalized) ?? null;
      const limit = Math.max(1, Math.min(MAX_EVENT_LIMIT, finiteInt(options.limit, this.eventLimit) ?? this.eventLimit));
      const rows = this._historyDb.prepare(`
        SELECT thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type
        FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT ?
      `).all(normalized, limit);
      const events = buildRecentEvents(normalized, turn, rows, Number.isFinite(options.nowMs) ? options.nowMs : Date.now(), limit);
      assertPrivacySafe(events);
      return events;
    } catch {
      return [];
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._closeDb("state");
    this._closeDb("history");
    this._closeDb("catalog");
    this._catalogSchema = null;
    this._optionalThreadColumns = new Set();
    this._initialized = false;
  }
}

export function createObserver(options = {}) {
  return new LocalObserver(options);
}

export function readWorldSnapshot(options = {}) {
  const observer = createObserver(options);
  try {
    return observer.getSnapshot(options);
  } finally {
    observer.close();
  }
}

export function schemaRequirements() {
  return JSON.parse(JSON.stringify(REQUIRED_SCHEMA));
}
