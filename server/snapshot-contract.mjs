import { createHash } from "node:crypto";

import { assertPrivacySafe, safeLabel, safeWarning } from "./privacy.mjs";

/**
 * The browser-facing world contract is deliberately small.  File-backed
 * sources are untrusted input, so they are projected through this module
 * before anything can reach the API or the UI.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECTS = 64;
export const MAX_AGENTS = 240;
export const MAX_EVENTS_PER_AGENT = 24;
export const MAX_WARNINGS = 8;
export const MAX_EVENT_LIMIT = 24;

const MAX_PROJECT_NAME_LENGTH = 96;
const MAX_AGENT_NAME_LENGTH = 96;
const MAX_ACTION_LENGTH = 120;
const MAX_ROLE_LENGTH = 64;
const MAX_ASSIGNMENT_LENGTH = 64;
const MAX_BRANCH_LENGTH = 80;
const MAX_MODEL_LENGTH = 80;
const MAX_REASONING_LENGTH = 16;
const MAX_EVENT_LABEL_LENGTH = 120;
const MAX_EVENT_SOURCE_LENGTH = 48;
const MAX_SOURCE_LABEL_LENGTH = 48;
const MAX_TIMESTAMP_LENGTH = 40;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const STATES = new Set([
  "thinking", "reading", "editing", "running", "delegating", "waiting", "needs-you", "verifying",
  "failed", "complete", "interrupted", "idle", "stale", "unknown",
]);
const EVIDENCE = new Set(["observed", "derived", "unknown"]);
const EVENT_KINDS = new Set(["turn", "command", "file", "tool", "collaboration", "message", "approval", "verification", "system"]);
const EVENT_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted", "declined"]);
const WORKING_STATES = new Set(["thinking", "reading", "editing", "running", "delegating", "verifying"]);
const QUEUE_STATES = new Set(["waiting", "needs-you", "failed"]);
const DEFAULT_COLORS = ["#7ee7d1", "#f4b860", "#a99bff", "#f58ca8", "#79a7ff", "#b6e27a"];

export class SnapshotContractError extends Error {
  constructor(message, code = "SNAPSHOT_CONTRACT") {
    super(message);
    this.name = "SnapshotContractError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new SnapshotContractError(message, code);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeId(value, fallback = "unknown") {
  const safeFallback = SAFE_ID.test(fallback) ? fallback : `id-${hash(fallback).slice(0, 16)}`;
  const text = typeof value === "string" ? value.trim() : "";
  if (SAFE_ID.test(text)) return text;
  if (!text) return safeFallback;
  return `id-${hash(text).slice(0, 16)}`;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function boundedLabel(value, fallback, maxLength) {
  const result = safeLabel(value, fallback, maxLength);
  const valueText = result.value || fallback;
  if (valueText && !/[\p{L}\p{N}]/u.test(valueText)) {
    return { value: fallback, redactions: result.redactions + 1 };
  }
  return { value: valueText, redactions: result.redactions };
}

function safeTimestamp(value, fallback) {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

function safeState(value) {
  return typeof value === "string" && STATES.has(value) ? value : "unknown";
}

function safeEvidence(value) {
  return typeof value === "string" && EVIDENCE.has(value) ? value : "unknown";
}

function colorFor(id) {
  return DEFAULT_COLORS[Number.parseInt(hash(id).slice(0, 8), 16) % DEFAULT_COLORS.length];
}

function safeColor(value, id) {
  return typeof value === "string" && SAFE_HEX_COLOR.test(value) ? value : colorFor(id);
}

function projectEvent(input, agentId = "agent-unknown", nowIso = new Date().toISOString()) {
  if (!isRecord(input)) return null;
  const id = safeId(input.id, `event-${hash(`${agentId}:${nowIso}`).slice(0, 16)}`);
  // Legacy thread-shaped producers remain readable, while the canonical wire
  // contract names the execution unit as an agent.
  const eventAgentId = safeId(input.agentId ?? input.threadId, agentId);
  const label = boundedLabel(input.label, "Activity observed", MAX_EVENT_LABEL_LENGTH);
  const source = boundedLabel(input.source, "provider", MAX_EVENT_SOURCE_LENGTH);
  const timestamp = safeTimestamp(input.timestamp, nowIso);
  const kind = typeof input.kind === "string" && EVENT_KINDS.has(input.kind) ? input.kind : "system";
  const state = safeState(input.state);
  const event = {
    id,
    agentId: eventAgentId,
    timestamp,
    kind,
    label: label.value,
    state,
    source: source.value,
    evidence: safeEvidence(input.evidence),
  };
  if (Number.isFinite(Number(input.durationMs))) {
    event.durationMs = boundedNumber(input.durationMs, 0, 0, 24 * 60 * 60 * 1000);
  }
  if (typeof input.status === "string" && EVENT_STATUSES.has(input.status)) event.status = input.status;
  return { event, redactions: label.redactions + source.redactions };
}

/** Return one browser-safe event with all unknown fields removed. */
export function normalizeEvent(input, agentId = "agent-unknown", nowIso = new Date().toISOString()) {
  return projectEvent(input, agentId, nowIso)?.event ?? null;
}

/**
 * Strictly project an event list from any provider. Unknown event keys are
 * discarded, malformed entries are skipped, and the result is bounded before
 * it can be returned from the agent-events endpoint.
 */
export function normalizeEvents(input, options = {}) {
  if (!Array.isArray(input)) return [];
  const agentId = safeId(options.agentId ?? options.threadId, "agent-unknown");
  const nowValue = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const nowIso = new Date(Math.max(0, nowValue)).toISOString();
  const limit = boundedNumber(options.limit, MAX_EVENT_LIMIT, 1, MAX_EVENT_LIMIT);
  const events = [];
  for (const candidate of input.slice(0, MAX_EVENT_LIMIT)) {
    const normalized = projectEvent(candidate, agentId, nowIso);
    if (!normalized) continue;
    events.push(normalized.event);
    if (events.length >= limit) break;
  }
  try {
    assertPrivacySafe(events);
  } catch {
    return [];
  }
  return events;
}

function normalizeAgent(input, index, nowIso) {
  if (!isRecord(input)) fail(`Agent ${index + 1} is not an object`, "SCHEMA_MISMATCH");
  const rawId = typeof input.id === "string" ? input.id : "";
  if (!rawId.trim()) fail(`Agent ${index + 1} has no identifier`, "SCHEMA_MISMATCH");
  const id = safeId(rawId, `agent-${hash(`${rawId}:${index}`).slice(0, 16)}`);
  const projectId = safeId(input.projectId, "project-unassigned");
  const title = boundedLabel(input.title, `Untitled task · ${id.slice(-8)}`, MAX_AGENT_NAME_LENGTH);
  const projectName = boundedLabel(input.projectName, "Unassigned", MAX_PROJECT_NAME_LENGTH);
  const action = boundedLabel(input.currentAction, "State unavailable", MAX_ACTION_LENGTH);
  const lastSeen = safeTimestamp(input.lastSeen, nowIso);
  const ageMs = boundedNumber(input.ageMs, Math.max(0, Date.parse(nowIso) - Date.parse(lastSeen)), 0, 365 * 24 * 60 * 60 * 1000);
  const agent = {
    id,
    title: title.value,
    projectId,
    projectName: projectName.value,
    state: safeState(input.state),
    evidence: safeEvidence(input.evidence),
    lastSeen,
    ageMs,
    currentAction: action.value,
    childCount: boundedNumber(input.childCount, 0, 0, MAX_AGENTS),
    events: [],
  };
  const optionalLabels = [
    ["nickname", input.nickname, MAX_AGENT_NAME_LENGTH],
    ["role", input.role, MAX_ROLE_LENGTH],
    ["assignment", input.assignment, MAX_ASSIGNMENT_LENGTH],
    ["branch", input.branch, MAX_BRANCH_LENGTH],
    ["model", input.model, MAX_MODEL_LENGTH],
    ["reasoningEffort", input.reasoningEffort, MAX_REASONING_LENGTH],
    ["attentionReason", input.attentionReason, MAX_ACTION_LENGTH],
  ];
  let redactions = title.redactions + projectName.redactions + action.redactions;
  for (const [key, value, maxLength] of optionalLabels) {
    if (value === undefined || value === null || value === "") continue;
    const label = boundedLabel(value, "", maxLength);
    redactions += label.redactions;
    if (label.value) agent[key] = label.value;
  }
  const tokenUsage = Number(input.tokenUsage);
  if (Number.isFinite(tokenUsage) && tokenUsage >= 0) agent.tokenUsage = Math.min(Math.trunc(tokenUsage), 10 ** 12);
  const parentId = typeof input.parentAgentId === "string" ? input.parentAgentId : input.parentThreadId;
  if (typeof parentId === "string" && parentId.trim()) {
    agent.parentAgentId = safeId(parentId, `parent-${hash(parentId).slice(0, 16)}`);
  }
  const sourceEvents = Array.isArray(input.events) ? input.events : [];
  for (const eventInput of sourceEvents.slice(0, MAX_EVENTS_PER_AGENT)) {
    const normalized = projectEvent(eventInput, id, nowIso);
    if (!normalized) continue;
    agent.events.push(normalized.event);
    redactions += normalized.redactions;
  }
  return { agent, redactions };
}

function requireArray(input, key) {
  if (!Array.isArray(input[key])) fail(`Snapshot field ${key} must be an array`, "SCHEMA_MISMATCH");
}

/**
 * Project a normalized snapshot from an untrusted source. Unknown fields are
 * intentionally ignored. Required shape errors throw so callers can return
 * an empty live snapshot rather than showing a partially trusted view.
 */
export function normalizeSnapshot(input, options = {}) {
  if (!isRecord(input)) fail("Snapshot must be an object", "SCHEMA_MISMATCH");
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail("Snapshot schema version is not supported", "SCHEMA_MISMATCH");
  if (input.mode !== "live" && input.mode !== "demo") fail("Snapshot mode is not supported", "SCHEMA_MISMATCH");
  if (typeof input.generatedAt !== "string" || typeof input.sourceFreshness !== "string") fail("Snapshot timestamps are missing", "SCHEMA_MISMATCH");
  for (const key of ["projects", "agents"]) requireArray(input, key);
  if (input.attention !== undefined) requireArray(input, "attention");
  if (input.warnings !== undefined) requireArray(input, "warnings");
  if (!isRecord(input.privacy)) fail("Snapshot privacy metadata is missing", "SCHEMA_MISMATCH");
  if (input.privacy.rawContentExposed !== false) fail("Snapshot is marked as exposing raw content", "PRIVACY_BOUNDARY");
  if (input.projects.length > MAX_PROJECTS || input.agents.length > MAX_AGENTS) fail("Snapshot exceeds the record bound", "SNAPSHOT_BOUND");

  const nowValue = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const nowIso = new Date(Math.max(0, nowValue)).toISOString();
  const sourceGeneratedAt = safeTimestamp(input.generatedAt, nowIso);
  const sourceFreshness = input.sourceFreshness === "unknown"
    ? "unknown"
    : safeTimestamp(input.sourceFreshness, sourceGeneratedAt);
  const projects = [];
  const projectMap = new Map();
  let redactions = boundedNumber(input.privacy.redactionsApplied, 0, 0, 10 ** 6);

  for (const [index, projectInput] of input.projects.entries()) {
    if (!isRecord(projectInput)) fail(`Project ${index + 1} is not an object`, "SCHEMA_MISMATCH");
    const rawId = typeof projectInput.id === "string" ? projectInput.id : "";
    if (!rawId.trim()) fail(`Project ${index + 1} has no identifier`, "SCHEMA_MISMATCH");
    const id = safeId(rawId, `project-${hash(`${rawId}:${index}`).slice(0, 16)}`);
    if (projectMap.has(id)) continue;
    const name = boundedLabel(projectInput.name, "Unnamed project", MAX_PROJECT_NAME_LENGTH);
    redactions += name.redactions;
    const project = { id, name: name.value, color: safeColor(projectInput.color, id), agentIds: [], activeCount: 0, attentionCount: 0 };
    projectMap.set(id, project);
    projects.push(project);
  }

  const agents = [];
  const agentIds = new Set();
  for (const [index, agentInput] of input.agents.entries()) {
    const normalized = normalizeAgent(agentInput, index, nowIso);
    if (agentIds.has(normalized.agent.id)) continue;
    agentIds.add(normalized.agent.id);
    redactions += normalized.redactions;
    agents.push(normalized.agent);
    if (!projectMap.has(normalized.agent.projectId)) {
      const projectName = boundedLabel(normalized.agent.projectName, "Unassigned", MAX_PROJECT_NAME_LENGTH);
      redactions += projectName.redactions;
      const project = { id: normalized.agent.projectId, name: projectName.value, color: colorFor(normalized.agent.projectId), agentIds: [], activeCount: 0, attentionCount: 0 };
      projectMap.set(project.id, project);
      projects.push(project);
    }
  }

  const attentionCandidates = Array.isArray(input.attention)
    ? input.attention.map((id) => safeId(id, "unknown"))
    : agents
      .filter((agent) => QUEUE_STATES.has(agent.state) && (agent.state !== "failed" || !agent.parentAgentId))
      .map((agent) => agent.id);
  const attention = [...new Set(attentionCandidates)].filter((id) => {
    const agent = agents.find((candidate) => candidate.id === id);
    return Boolean(agent && QUEUE_STATES.has(agent.state));
  });
  const attentionIds = new Set(attention);
  for (const project of projects) {
    const members = agents.filter((agent) => agent.projectId === project.id);
    project.agentIds = members.map((agent) => agent.id);
    project.activeCount = members.filter((agent) => WORKING_STATES.has(agent.state)).length;
    project.attentionCount = members.filter((agent) => attentionIds.has(agent.id)).length;
  }
  const warnings = [];
  for (const warning of (input.warnings ?? []).slice(0, MAX_WARNINGS)) {
    if (typeof warning !== "string") continue;
    const safe = boundedLabel(warning, "Snapshot warning", 160);
    redactions += safe.redactions;
    if (safe.value) warnings.push(safe.value);
  }
  if (!warnings.length) warnings.push("Snapshot source is normalized and privacy-filtered.");
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: options.mode === "demo" || options.mode === "live" ? options.mode : input.mode,
    generatedAt: sourceGeneratedAt,
    sourceFreshness,
    projects,
    agents,
    attention,
    privacy: { rawContentExposed: false, redactionsApplied: Math.min(redactions, 10 ** 6) },
    warnings: [...new Set(warnings)].slice(0, MAX_WARNINGS),
  };
  if (typeof input.sourceLabel === "string" && input.sourceLabel.trim()) {
    const sourceLabel = boundedLabel(input.sourceLabel, "Live provider", MAX_SOURCE_LABEL_LENGTH);
    redactions += sourceLabel.redactions;
    if (sourceLabel.value) snapshot.sourceLabel = sourceLabel.value;
    snapshot.privacy.redactionsApplied = Math.min(redactions, 10 ** 6);
  }
  try {
    assertPrivacySafe(snapshot);
  } catch (error) {
    throw new SnapshotContractError(error?.message ?? "Snapshot privacy assertion failed", "PRIVACY_BOUNDARY");
  }
  return snapshot;
}

export function emptyLiveSnapshot(nowMs = Date.now(), warnings = []) {
  const generatedAt = new Date(Math.max(0, Number.isFinite(nowMs) ? nowMs : Date.now())).toISOString();
  const normalizedWarnings = warnings
    .filter((warning) => typeof warning === "string")
    .map((warning) => safeWarning(warning))
    .filter(Boolean);
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: "live",
    generatedAt,
    sourceFreshness: "unknown",
    projects: [],
    agents: [],
    attention: [],
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: [...new Set(["Live snapshot unavailable. No browser-visible records were returned.", ...normalizedWarnings])].slice(0, MAX_WARNINGS),
  };
  try {
    assertPrivacySafe(snapshot);
  } catch {
    snapshot.warnings = ["Live snapshot privacy boundary rejected the payload."];
  }
  return snapshot;
}

export function snapshotContractLimits() {
  return {
    maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
    maxProjects: MAX_PROJECTS,
    maxAgents: MAX_AGENTS,
    maxEventsPerAgent: MAX_EVENTS_PER_AGENT,
    maxWarnings: MAX_WARNINGS,
    maxEventLimit: MAX_EVENT_LIMIT,
  };
}
