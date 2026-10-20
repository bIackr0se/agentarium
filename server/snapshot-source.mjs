import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

import {
  emptyLiveSnapshot,
  MAX_EVENT_LIMIT,
  MAX_SNAPSHOT_BYTES,
  MAX_WARNINGS,
  normalizeSnapshot,
} from "./snapshot-contract.mjs";
import { assertPrivacySafe, safeWarning } from "./privacy.mjs";

const MAX_SNAPSHOT_PATH_LENGTH = 1_024;
const MAX_JSONL_LINES = 16_384;

function finiteNow(options) {
  return Number.isFinite(options?.nowMs) ? options.nowMs : Date.now();
}

function safeFormat(format, snapshotPath) {
  const normalized = typeof format === "string" ? format.toLowerCase().replace(/^[.]+/, "") : "";
  if (normalized === "json" || normalized === "jsonl" || normalized === "ndjson") return normalized === "ndjson" ? "jsonl" : normalized;
  const extension = extname(snapshotPath).toLowerCase();
  return extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : "json";
}

function boundedLimit(value, fallback = 12) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, number));
}

/**
 * Read a normalized snapshot from a startup-configured JSON or JSONL file.
 * This adapter has no write capability and intentionally never exposes the
 * configured path in diagnostics or browser-facing warnings.
 */
export class SnapshotFileSource {
  constructor(options = {}) {
    const configuredPath = options.snapshotPath ?? options.path ?? process.env.AGENTARIUM_SNAPSHOT_PATH ?? "";
    this.snapshotPath = typeof configuredPath === "string" && configuredPath.length <= MAX_SNAPSHOT_PATH_LENGTH && !configuredPath.includes("\0")
      ? resolve(configuredPath)
      : "";
    this.format = safeFormat(options.format, this.snapshotPath);
    this.provider = this.format === "jsonl" ? "snapshot-jsonl" : "snapshot-json";
    this.closed = false;
    this.lastReadAt = null;
    this.lastError = null;
    this.skippedRecords = 0;
    this.readCount = 0;
    this.recordCache = new Map();
  }

  _unavailable(nowMs, warning = "Configured snapshot source is unavailable.") {
    this.lastError = warning;
    return emptyLiveSnapshot(nowMs, [warning]);
  }

  _readText() {
    if (this.closed || !this.snapshotPath) throw new Error("snapshot source is not configured");
    let stats;
    try {
      stats = statSync(this.snapshotPath);
    } catch {
      throw new Error("snapshot source cannot be read");
    }
    if (!stats.isFile()) throw new Error("snapshot source is not a file");
    if (stats.size > MAX_SNAPSHOT_BYTES) throw new Error("snapshot source exceeds the size limit");
    // readFileSync opens the file read-only. No source path or file contents
    // are copied into diagnostics, warnings, or the public contract.
    const text = readFileSync(this.snapshotPath, { encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("snapshot source exceeds the size limit");
    return text;
  }

  _parse(text, nowMs) {
    if (this.format === "jsonl") {
      if (text.length === 0) throw new Error("snapshot source is empty");
      const lines = text.split(/\r?\n/);
      if (lines.at(-1)?.trim() === "") lines.pop();
      if (lines.length > MAX_JSONL_LINES) throw new Error("snapshot source has too many records");
      let lastValid = null;
      let skippedRecords = 0;
      // Keep only records present in this bounded read. Exact line keys also
      // handle append, partial-line completion, rotation, and same-size edits
      // without trusting filesystem timestamps or retaining removed history.
      const nextCache = new Map();
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        if (nextCache.has(line)) {
          parsed = nextCache.get(line);
        } else if (this.recordCache.has(line)) {
          parsed = this.recordCache.get(line);
        } else {
          try {
            parsed = JSON.parse(line);
            normalizeSnapshot(parsed, { nowMs });
          } catch {
            // Cache invalid records too, preserving the skipped-record count
            // without repeating contract projection on every refresh.
            parsed = null;
          }
        }
        nextCache.set(line, parsed);
        if (parsed === null) skippedRecords += 1;
        else lastValid = parsed;
      }
      this.recordCache = nextCache;
      if (!lastValid) throw new Error("snapshot source contains no valid snapshot");
      // Re-project only the selected raw record: fallback timestamps must use
      // this refresh's clock, and callers must receive fresh mutable objects.
      return { snapshot: normalizeSnapshot(lastValid, { nowMs }), skippedRecords };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("snapshot source is malformed JSON");
    }
    return { snapshot: normalizeSnapshot(parsed, { nowMs }), skippedRecords: 0 };
  }

  getSnapshot(options = {}) {
    const nowMs = finiteNow(options);
    if (!this.snapshotPath) return this._unavailable(nowMs, "Snapshot source was not configured.");
    try {
      // An invalid clock must throw before _parse replaces the record cache.
      const readAt = new Date(nowMs).toISOString();
      const parsed = this._parse(this._readText(), nowMs);
      let snapshot = parsed.snapshot;
      this.skippedRecords = parsed.skippedRecords;
      if (this.skippedRecords > 0) {
        const warning = safeWarning("Showing the last complete snapshot; newer JSONL records were malformed or incomplete.");
        snapshot = {
          ...snapshot,
          warnings: [...new Set([warning, ...snapshot.warnings])].slice(0, MAX_WARNINGS),
        };
        assertPrivacySafe(snapshot);
      }
      this.lastReadAt = readAt;
      this.lastError = null;
      this.readCount += 1;
      return snapshot;
    } catch (error) {
      this.readCount += 1;
      this.skippedRecords = 0;
      return this._unavailable(nowMs, error?.message === "snapshot source exceeds the size limit"
        ? "Snapshot source exceeded the size limit."
        : "Snapshot source was malformed, unavailable, or failed contract validation.");
    }
  }

  getEvents(agentId, options = {}) {
    if (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/.test(agentId)) return [];
    const snapshot = this.getSnapshot(options);
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    return (agent?.events ?? []).slice(0, boundedLimit(options.limit));
  }

  diagnostics() {
    return {
      ready: Boolean(this.snapshotPath && !this.closed && this.lastReadAt && !this.lastError),
      provider: this.provider,
      source: this.provider,
      readOnly: true,
      configured: Boolean(this.snapshotPath),
      format: this.format,
      recordsRead: this.readCount,
      skippedRecords: this.skippedRecords,
      recovered: this.skippedRecords > 0,
      degraded: this.skippedRecords > 0,
      lastReadAt: this.lastReadAt,
      ...((this.lastError || this.skippedRecords > 0) ? {
        warning: this.lastError ?? "Showing the last complete snapshot; newer JSONL records were malformed or incomplete.",
      } : {}),
    };
  }

  close() {
    this.closed = true;
    this.recordCache.clear();
  }
}

export function createSnapshotSource(options = {}) {
  return new SnapshotFileSource(options);
}
