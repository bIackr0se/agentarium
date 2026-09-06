import type { AgentEvent, AgentSnapshot, AgentState, EvidenceStrength, EventKind, ProjectSnapshot, WorldSnapshot } from "./contracts";

/**
 * Browser-side projection of the published snapshot contract.
 *
 * The API normally sends an already-normalized snapshot, but App also accepts
 * embedded fixtures and can receive SSE frames from an arbitrary host. Keep a
 * second, dependency-free boundary here so those values cannot smuggle raw
 * event payloads or unbounded labels into the UI.
 */
export const CLIENT_SNAPSHOT_LIMITS = Object.freeze({
  maxSnapshotBytes: 2 * 1024 * 1024,
  maxProjects: 64,
  maxAgents: 240,
  maxEventsPerAgent: 24,
  maxWarnings: 8,
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_COLOR = /^#[0-9A-Fa-f]{6}$/;
const STATES = new Set<AgentState>([
  "thinking", "reading", "editing", "running", "delegating", "waiting", "needs-you", "verifying",
  "failed", "complete", "interrupted", "idle", "stale", "unknown",
]);
const EVIDENCE = new Set<EvidenceStrength>(["observed", "derived", "unknown"]);
const EVENT_KINDS = new Set<EventKind>(["turn", "command", "file", "tool", "collaboration", "message", "approval", "verification", "system"]);
const EVENT_STATUSES = new Set<NonNullable<AgentEvent["status"]>>(["inProgress", "completed", "failed", "interrupted", "declined"]);
const WORKING_STATES = new Set<AgentState>(["thinking", "reading", "editing", "running", "delegating", "verifying"]);
const QUEUE_STATES = new Set<AgentState>(["waiting", "needs-you", "failed"]);
const DEFAULT_COLORS = ["#7ee7d1", "#f4b860", "#a99bff", "#f58ca8", "#79a7ff", "#b6e27a"];

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const IPV6_PATTERN = /(?<![A-Za-z0-9])[0-9A-F:.]{2,45}(?![A-Za-z0-9])/gi;
const PRIVATE_PATTERNS = [
  /\b(?:sk|rk|pk|sess|secret|token|key)-[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:sk|rk|pk|sess|secret|token|key)_[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token|cookie)\s*[:=]\s*["']?[^\s,;"'`}]+/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi,
  /(?:^|[^\p{L}\p{N}.\/\\])(?:~[\\/]|\/(?!\/)|[A-Za-z]:\\)[^\r\n"\s]+(?:[ \t]+(?![A-Za-z_][A-Za-z0-9_.-]*\s*[:=])[^\r\n"\s]+)*/gu,
  /(?:^|[^\p{L}\p{N}.\/\\])file:\/\/[^\r\n"\s]+(?:[ \t]+(?![A-Za-z_][A-Za-z0-9_.-]*\s*[:=])[^\r\n"\s]+)*/giu,
  IPV6_PATTERN,
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
];

function isValidIPv6(value: string): boolean {
  if (!value || (value.match(/::/g) ?? []).length > 1) return false;
  const [leftText, rightText] = value.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText === undefined || rightText === "" ? [] : rightText.split(":");
  const groups = [...left, ...right];
  const last = groups.at(-1);
  let hextetCount = groups.length;
  if (last?.includes(".")) {
    const octets = last.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    hextetCount += 1;
  }
  const hextets = last?.includes(".") ? groups.slice(0, -1) : groups;
  if (hextets.some((group) => !/^[0-9A-F]{1,4}$/i.test(group))) return false;
  return value.includes("::") ? hextetCount < 8 : hextetCount === 8;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function redactText(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  text = text.replace(CONTROL_CHARACTERS, " ");
  for (const pattern of PRIVATE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => {
      if (pattern === IPV6_PATTERN && !isValidIPv6(match)) return match;
      const prefix = match.match(/^[^\p{L}\p{N}.\/\\]/u)?.[0] ?? "";
      return `${prefix}[redacted]`;
    });
  }
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function boundedLabel(value: unknown, fallback: string, maxLength: number): string {
  const text = redactText(value);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return fallback;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function safeId(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (SAFE_ID.test(text) && redactText(text) === text) return text;
  return text ? `id-${stableHash(text)}` : fallback;
}

function safeColor(value: unknown, id: string): string {
  if (typeof value === "string" && SAFE_COLOR.test(value)) return value;
  return DEFAULT_COLORS[Number.parseInt(stableHash(id), 16) % DEFAULT_COLORS.length];
}

function safeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 40) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function safeNowMs(value?: number): number {
  const candidate = Number.isFinite(value) ? Number(value) : Date.now();
  return Math.max(0, Math.min(8_640_000_000_000_000, candidate));
}

function normalizeEvent(input: unknown, agentId: string, fallbackTimestamp: string, index: number): AgentEvent | null {
  const record = asRecord(input);
  if (!record) return null;
  const eventId = safeId(record.id, `event-${stableHash(`${agentId}:${index}`)}`);
  const eventAgentId = safeId(record.agentId ?? record.threadId, agentId);
  const event: AgentEvent = {
    id: eventId,
    agentId: eventAgentId,
    timestamp: safeTimestamp(record.timestamp, fallbackTimestamp),
    kind: typeof record.kind === "string" && EVENT_KINDS.has(record.kind as EventKind) ? record.kind as EventKind : "system",
    label: boundedLabel(record.label, "Activity observed", 120),
    state: typeof record.state === "string" && STATES.has(record.state as AgentState) ? record.state as AgentState : "unknown",
    source: boundedLabel(record.source, "provider", 48),
    evidence: typeof record.evidence === "string" && EVIDENCE.has(record.evidence as EvidenceStrength)
      ? record.evidence as EvidenceStrength
      : "unknown",
  };
  // `detail` and all other provider payload fields are intentionally omitted.
  if (Number.isFinite(Number(record.durationMs))) event.durationMs = safeInteger(record.durationMs, 0, 0, 86_400_000);
  if (typeof record.status === "string" && EVENT_STATUSES.has(record.status as NonNullable<AgentEvent["status"]>)) {
    event.status = record.status as NonNullable<AgentEvent["status"]>;
  }
  return event;
}

function normalizeAgent(input: unknown, index: number, generatedAt: string, projectIds: Map<string, string>): { agent: AgentSnapshot; redactions: number } | null {
  const record = asRecord(input);
  const rawId = typeof record?.id === "string" ? record.id.trim() : "";
  if (!record || !rawId) return null;
  const id = safeId(rawId, `agent-${stableHash(`${rawId}:${index}`)}`);
  const projectRaw = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const projectId = projectIds.get(projectRaw) ?? safeId(projectRaw, "project-unassigned");
  const title = boundedLabel(record.title, `Untitled task · ${id.slice(-8)}`, 96);
  const projectName = boundedLabel(record.projectName, "Unassigned", 96);
  const lastSeen = safeTimestamp(record.lastSeen, generatedAt);
  const agent: AgentSnapshot = {
    id,
    title,
    projectId,
    projectName,
    state: typeof record.state === "string" && STATES.has(record.state as AgentState) ? record.state as AgentState : "unknown",
    evidence: typeof record.evidence === "string" && EVIDENCE.has(record.evidence as EvidenceStrength)
      ? record.evidence as EvidenceStrength
      : "unknown",
    lastSeen,
    ageMs: safeInteger(record.ageMs, Math.max(0, Date.parse(generatedAt) - Date.parse(lastSeen)), 0, 31_536_000_000),
    currentAction: boundedLabel(record.currentAction, "State unavailable", 120),
    childCount: safeInteger(record.childCount, 0, 0, 240),
    events: [],
  };
  let redactions = 0;
  const optionalLabels: Array<[keyof AgentSnapshot, unknown, number]> = [
    ["nickname", record.nickname, 96],
    ["role", record.role, 64],
    ["assignment", record.assignment, 64],
    ["branch", record.branch, 80],
    ["model", record.model, 80],
    ["reasoningEffort", record.reasoningEffort, 16],
    ["attentionReason", record.attentionReason, 120],
  ];
  for (const [key, value, maxLength] of optionalLabels) {
    if (value === undefined || value === null || value === "") continue;
    const label = boundedLabel(value, "", maxLength);
    if (label) agent[key] = label as never;
  }
  const tokenUsage = Number(record.tokenUsage);
  if (Number.isFinite(tokenUsage) && tokenUsage >= 0) agent.tokenUsage = Math.min(Math.trunc(tokenUsage), 10 ** 12);
  const parentValue = record.parentAgentId ?? record.parentThreadId;
  if (typeof parentValue === "string" && parentValue.trim()) agent.parentAgentId = safeId(parentValue, `parent-${stableHash(parentValue)}`);
  const sourceEvents = Array.isArray(record.events) ? record.events : [];
  for (const [eventIndex, eventInput] of sourceEvents.slice(0, CLIENT_SNAPSHOT_LIMITS.maxEventsPerAgent).entries()) {
    const event = normalizeEvent(eventInput, id, lastSeen, eventIndex);
    if (event) agent.events.push(event);
  }
  return { agent, redactions };
}

/**
 * Normalize a browser ingress value to the published WorldSnapshot contract.
 * Returns null for an invalid required shape so callers can select a safe
 * synthetic scene instead of rendering a partially trusted object.
 */
export function normalizeClientSnapshot(value: unknown, options: { mode?: WorldSnapshot["mode"]; nowMs?: number } = {}): WorldSnapshot | null {
  const snapshot = asRecord(value);
  if (!snapshot || snapshot.schemaVersion !== 1 || (snapshot.mode !== "live" && snapshot.mode !== "demo")) return null;
  if (typeof snapshot.generatedAt !== "string" || typeof snapshot.sourceFreshness !== "string") return null;
  if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.agents)) return null;
  if (snapshot.projects.length > CLIENT_SNAPSHOT_LIMITS.maxProjects || snapshot.agents.length > CLIENT_SNAPSHOT_LIMITS.maxAgents) return null;
  if (snapshot.attention !== undefined && !Array.isArray(snapshot.attention)) return null;
  if (snapshot.warnings !== undefined && !Array.isArray(snapshot.warnings)) return null;
  const privacy = asRecord(snapshot.privacy);
  if (!privacy || privacy.rawContentExposed !== false) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || new TextEncoder().encode(serialized).byteLength > CLIENT_SNAPSHOT_LIMITS.maxSnapshotBytes) return null;
  } catch {
    return null;
  }

  const nowMs = safeNowMs(options.nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const generatedAt = safeTimestamp(snapshot.generatedAt, nowIso);
  const sourceFreshness = snapshot.sourceFreshness === "unknown"
    ? "unknown"
    : safeTimestamp(snapshot.sourceFreshness, generatedAt);
  const projectIds = new Map<string, string>();
  const projects: ProjectSnapshot[] = [];
  for (const [index, candidate] of snapshot.projects.entries()) {
    const record = asRecord(candidate);
    const rawId = typeof record?.id === "string" ? record.id.trim() : "";
    if (!record || !rawId) return null;
    const id = safeId(rawId, `project-${stableHash(`${rawId}:${index}`)}`);
    projectIds.set(rawId, id);
    if (projects.some((project) => project.id === id)) continue;
    projects.push({
      id,
      name: boundedLabel(record.name, "Unnamed project", 96),
      color: safeColor(record.color, id),
      agentIds: [],
      activeCount: 0,
      attentionCount: 0,
    });
  }

  const agents: AgentSnapshot[] = [];
  const agentIds = new Set<string>();
  for (const [index, candidate] of snapshot.agents.entries()) {
    const normalized = normalizeAgent(candidate, index, generatedAt, projectIds);
    if (!normalized) return null;
    if (agentIds.has(normalized.agent.id)) continue;
    agentIds.add(normalized.agent.id);
    agents.push(normalized.agent);
    if (!projects.some((project) => project.id === normalized.agent.projectId)) {
      projects.push({
        id: normalized.agent.projectId,
        name: normalized.agent.projectName,
        color: safeColor(undefined, normalized.agent.projectId),
        agentIds: [],
        activeCount: 0,
        attentionCount: 0,
      });
    }
  }
  if (projects.length > CLIENT_SNAPSHOT_LIMITS.maxProjects) return null;

  const rawAttention = Array.isArray(snapshot.attention) ? snapshot.attention : undefined;
  const attentionCandidates = rawAttention
    ? rawAttention.map((candidate) => safeId(candidate, "unknown"))
    : agents.filter((agent) => QUEUE_STATES.has(agent.state) && (agent.state !== "failed" || !agent.parentAgentId)).map((agent) => agent.id);
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

  const warnings = (Array.isArray(snapshot.warnings) ? snapshot.warnings : [])
    .slice(0, CLIENT_SNAPSHOT_LIMITS.maxWarnings)
    .filter((warning): warning is string => typeof warning === "string")
    .map((warning) => boundedLabel(warning, "Snapshot warning", 160));
  if (!warnings.length) warnings.push("Snapshot source is normalized and privacy-filtered.");
  const redactionsApplied = safeInteger(privacy.redactionsApplied, 0, 0, 1_000_000);
  const output: WorldSnapshot = {
    schemaVersion: 1,
    mode: options.mode ?? snapshot.mode,
    generatedAt,
    sourceFreshness,
    projects,
    agents,
    attention,
    privacy: { rawContentExposed: false, redactionsApplied },
    warnings: [...new Set(warnings)].slice(0, CLIENT_SNAPSHOT_LIMITS.maxWarnings),
  };
  if (typeof snapshot.sourceLabel === "string" && snapshot.sourceLabel.trim()) output.sourceLabel = boundedLabel(snapshot.sourceLabel, "Live provider", 48);
  return output;
}
