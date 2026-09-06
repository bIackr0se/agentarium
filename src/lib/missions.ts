import type {
  AgentEvent,
  AgentSnapshot,
  AgentState,
  EvidenceStrength,
  WorldSnapshot,
} from "./contracts";
import { buildWorldHierarchy } from "./hierarchy";
import type { HierarchyAgent, RootTaskNode } from "./hierarchy";

/**
 * Mission state is deliberately a little more expressive than the provider
 * state.  It describes the state of a root task as a whole, while retaining
 * the exceptional states that should never be presented as progress.
 */
export const MISSION_PHASE_ORDER = [
  "planning",
  "working",
  "verification",
  "waiting-for-you",
  "waiting-on-agent",
  "complete",
  "failed",
  "interrupted",
  "idle",
  "stale",
  "unknown",
] as const;

export type MissionPhase = (typeof MISSION_PHASE_ORDER)[number];

/** The five-step trail shared by the board and map. */
export const MISSION_PHASE_TRAIL = [
  "planning",
  "working",
  "verification",
  "waiting-for-you",
  "complete",
] as const satisfies readonly MissionPhase[];

export const MISSION_PHASE_LABELS: Readonly<Record<MissionPhase, string>> = Object.freeze({
  planning: "Planning",
  working: "Working",
  verification: "Verification",
  "waiting-for-you": "Waiting for you",
  "waiting-on-agent": "Waiting on agent",
  complete: "Complete",
  failed: "Failed",
  interrupted: "Interrupted",
  idle: "No active run",
  stale: "Stale",
  unknown: "Unknown",
});

export type MissionTrailStatus = "complete" | "current" | "upcoming" | "blocked";

export interface MissionTrailStep {
  phase: (typeof MISSION_PHASE_TRAIL)[number];
  label: string;
  status: MissionTrailStatus;
}

export type MissionFreshness = "fresh" | "aging" | "stale" | "unknown";

export interface MissionEvidence {
  /** Evidence supporting the latest known mission state. */
  strength: EvidenceStrength;
  latestEvent: AgentEvent | null;
  latestEventAt: string | null;
  boundedEventCount: number;
  freshness: MissionFreshness;
}

export interface MissionAgent {
  id: string;
  displayName: string;
  role?: string;
  /** State resolved at the replay cutoff, not necessarily the live field. */
  state: AgentState;
  effectiveState: AgentState;
  evidence: EvidenceStrength;
  isRoot: boolean;
  needsAttention: boolean;
  attentionReason?: string;
  latestEvent: AgentEvent | null;
  boundedEventCount: number;
  lastActivityAt: string | null;
}

export interface HumanDecision {
  kind: "approval" | "input";
  reason: string;
  agentId: string;
  agentName: string;
  evidence: EvidenceStrength;
  event: AgentEvent | null;
}

export interface MissionEvolution {
  /** True only when the root task has an observed completion boundary. */
  verified: boolean;
  districtLit: boolean;
  rootHomeLit: boolean;
  bridgeOpen: boolean;
}

export interface Mission {
  /** A project-scoped key, stable even when root IDs collide across projects. */
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  displayName: string;
  phase: MissionPhase;
  phaseLabel: string;
  /** Index into MISSION_PHASE_TRAIL. Exceptional states use -1. */
  phaseIndex: number;
  /** Canonical stages actually evidenced at or before the replay cutoff. */
  observedPhases: MissionPhase[];
  phaseTrail: MissionTrailStep[];
  agents: MissionAgent[];
  agentCount: number;
  activeCount: number;
  waitingCount: number;
  needsYouCount: number;
  failedCount: number;
  interruptedCount: number;
  completedAgentCount: number;
  attentionCount: number;
  evidence: MissionEvidence;
  decision: HumanDecision | null;
  requiresHumanDecision: boolean;
  evolution: MissionEvolution;
  rootAgentId?: string;
  rootCompletionAt: string | null;
  lastActivityAt: string | null;
}

export interface MissionProject {
  id: string;
  displayName: string;
  missionCount: number;
  agentCount: number;
  attentionCount: number;
  completeCount: number;
  missions: Mission[];
}

export interface DailySummary {
  /** The interval is half-open: [windowStart, windowEnd). */
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  asOf: string;
  coverage: "bounded-snapshot";
  completions: number;
  /** Explicit approval/needs-you signals, not proof that a person acted. */
  interventionSignals: number;
  recoveries: number;
  regressions: number;
}

export interface MissionWorld {
  replayCutoff: number;
  replayCutoffIso: string | null;
  sourceMode: WorldSnapshot["mode"];
  projects: MissionProject[];
  missions: Mission[];
  missionCount: number;
  agentCount: number;
  attentionCount: number;
  dailySummary: DailySummary;
}

export interface MissionDailyWindow {
  start: number | string | Date;
  end: number | string | Date;
  timeZone?: string;
}

export interface MissionBuildOptions {
  /** Defaults to the source's generatedAt day in UTC. */
  timeZone?: string;
  /** Mirrors the observer's 30-minute freshness boundary by default. */
  staleAfterMs?: number;
  dailyWindow?: MissionDailyWindow;
}

interface EffectiveAgent {
  hierarchyAgent: HierarchyAgent;
  agent: AgentSnapshot;
  state: AgentState;
  evidence: EvidenceStrength;
  events: AgentEvent[];
  latestEvent: AgentEvent | null;
  lastActivityMs: number | null;
  metadataBounded: boolean;
  usesMetadata: boolean;
}

interface EffectiveLifecycle {
  state: AgentState;
  evidence: EvidenceStrength;
  events: AgentEvent[];
  latestEvent: AgentEvent | null;
  lastActivityMs: number | null;
  metadataBounded: boolean;
  usesMetadata: boolean;
}

interface MissionBuildRecord {
  mission: Mission;
  task: RootTaskNode;
  effectiveAgents: EffectiveAgent[];
}

interface ResolvedDailyWindow {
  start: number;
  end: number;
  timeZone: string;
}

const WORKING_STATES = new Set<AgentState>(["editing", "reading", "running"]);
const PLANNING_STATES = new Set<AgentState>(["thinking", "delegating"]);
const ACTIVE_STATES = new Set<AgentState>([
  "thinking",
  "reading",
  "editing",
  "running",
  "delegating",
  "verifying",
]);
const TERMINAL_FAILURE_STATES = new Set<AgentState>(["failed", "interrupted"]);

function finiteTime(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isoTime(value: number | null): string | null {
  return value !== null && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function safeText(value: unknown, fallback = "", maxLength = 160): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    // The normalized ingress already applies these redactions. Keep the
    // derived model safe when a trusted embed supplies a typed fixture
    // directly, without ever searching arbitrary payload text.
    .replace(/(?:~[\\/]|\/(?:Users|home|private|var|tmp)\/[^\s]+|[A-Za-z]:[\\/][^\s]+|file:\/\/[^\s]+)/gi, "[redacted]")
    .replace(/\b(?:token|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return fallback;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function eventTime(event: AgentEvent): number | null {
  return finiteTime(event.timestamp);
}

function compareChronological(left: AgentEvent, right: AgentEvent): number {
  return (eventTime(left) ?? Number.POSITIVE_INFINITY) - (eventTime(right) ?? Number.POSITIVE_INFINITY)
    || left.id.localeCompare(right.id)
    || left.kind.localeCompare(right.kind)
    || left.label.localeCompare(right.label);
}

function compareLatest(left: AgentEvent, right: AgentEvent): number {
  return compareChronological(right, left);
}

/** Copy only fields admitted by the public event contract. */
function safeEvent(event: AgentEvent): AgentEvent {
  const copy: AgentEvent = {
    id: safeText(event.id, "event", 160),
    agentId: safeText(event.agentId, "agent", 160),
    timestamp: isoTime(eventTime(event)) ?? new Date(0).toISOString(),
    kind: event.kind,
    label: safeText(event.label, "Activity observed", 120),
    state: event.state,
    source: safeText(event.source, "provider", 48),
    evidence: event.evidence,
  };
  if (event.durationMs !== undefined && Number.isFinite(event.durationMs)) copy.durationMs = Math.max(0, Math.trunc(event.durationMs));
  if (event.status !== undefined) copy.status = event.status;
  return copy;
}

function boundedEvents(agent: AgentSnapshot, cutoff: number): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of agent.events) {
    const timestamp = eventTime(event);
    if (timestamp === null || timestamp > cutoff) continue;
    const safe = safeEvent(event);
    const current = byId.get(safe.id);
    if (!current || compareLatest(safe, current) < 0) byId.set(safe.id, safe);
  }
  return [...byId.values()].sort(compareChronological);
}

function eventState(event: AgentEvent): AgentState {
  if (event.status === "failed") return "failed";
  if (event.status === "interrupted") return "interrupted";
  if (event.status === "completed" && event.state === "unknown") return "complete";
  return event.state;
}

function metadataTime(agent: AgentSnapshot): number | null {
  return finiteTime(agent.lastSeen);
}

/** Whether an agent has any lifecycle metadata available at this replay edge. */
export function agentObservedAtCutoff(
  agent: AgentSnapshot,
  replayCutoff: number | string | Date,
): boolean {
  const cutoff = finiteTime(replayCutoff);
  const lastSeen = metadataTime(agent);
  return cutoff !== null && lastSeen !== null && lastSeen <= cutoff;
}

function effectiveLifecycle(agent: AgentSnapshot, cutoff: number): EffectiveLifecycle {
  const events = boundedEvents(agent, cutoff);
  const latestEvent = events.at(-1) ?? null;
  const latestEventMs = latestEvent ? eventTime(latestEvent) : null;
  const lastSeenMs = metadataTime(agent);
  const metadataBounded = lastSeenMs !== null && lastSeenMs <= cutoff;
  // The lifecycle timestamp wins when it is newer than the bounded event
  // window. This matters for providers that publish a compact event list.
  const useMetadata = metadataBounded && (latestEventMs === null || lastSeenMs >= latestEventMs);
  const state = useMetadata ? agent.state : latestEvent ? eventState(latestEvent) : metadataBounded ? agent.state : "unknown";
  const evidence = useMetadata ? agent.evidence : latestEvent?.evidence ?? (metadataBounded ? agent.evidence : "unknown");
  const lastActivityMs = Math.max(...[latestEventMs, metadataBounded ? lastSeenMs : null].filter((value): value is number => value !== null), -1);
  return {
    state,
    evidence,
    events,
    latestEvent,
    lastActivityMs: lastActivityMs >= 0 ? lastActivityMs : null,
    metadataBounded,
    usesMetadata: useMetadata,
  };
}

function effectiveAgent(item: HierarchyAgent, cutoff: number): EffectiveAgent {
  return {
    hierarchyAgent: item,
    agent: item.agent,
    ...effectiveLifecycle(item.agent, cutoff),
  };
}

/** Project one agent onto a replay boundary without exposing later lifecycle metadata. */
export function projectAgentAtCutoff(agent: AgentSnapshot, replayCutoff: number | string | Date): AgentSnapshot {
  const cutoff = finiteTime(replayCutoff) ?? 0;
  const lifecycle = effectiveLifecycle(agent, cutoff);
  // Keep not-yet-observed agents visibly unavailable in replay without
  // exposing their real future timestamp. The one-millisecond sentinel is a
  // UI projection marker, not a claim that activity occurred at that time.
  const lastSeen = isoTime(lifecycle.lastActivityMs) ?? new Date(cutoff + 1).toISOString();
  const currentAction = lifecycle.usesMetadata
    ? safeText(agent.currentAction, "Activity recorded", 120)
    : lifecycle.latestEvent
      ? safeText(lifecycle.latestEvent.label, "Activity recorded", 120)
      : "No activity recorded by this point";
  const attentionReason = lifecycle.state === "needs-you"
    ? lifecycle.usesMetadata
      ? safeText(agent.attentionReason)
      : safeText(lifecycle.latestEvent?.label)
    : "";
  const projected: AgentSnapshot = {
    ...agent,
    state: lifecycle.state,
    evidence: lifecycle.evidence,
    lastSeen,
    ageMs: lifecycle.lastActivityMs === null ? 0 : Math.max(0, cutoff - lifecycle.lastActivityMs),
    currentAction,
    events: lifecycle.events,
  };
  if (attentionReason) projected.attentionReason = attentionReason;
  else delete projected.attentionReason;
  if (!lifecycle.metadataBounded) {
    // These are current-run metadata with no historical boundary in the
    // contract. Omitting them is safer than showing future values in replay.
    delete projected.model;
    delete projected.reasoningEffort;
    delete projected.tokenUsage;
    delete projected.branch;
  }
  return projected;
}

/** Project every lifecycle surface onto the same replay boundary. */
export function projectSnapshotAtCutoff(
  snapshot: WorldSnapshot,
  replayCutoff: number | string | Date,
): WorldSnapshot {
  const cutoff = finiteTime(replayCutoff) ?? finiteTime(snapshot.generatedAt) ?? 0;
  const agents = snapshot.agents.map((agent) => projectAgentAtCutoff(agent, cutoff));
  const lifecycleBoundary = Math.max(
    ...snapshot.agents.flatMap((agent) => [
      metadataTime(agent),
      ...agent.events.map((event) => eventTime(event)),
    ]).filter((value): value is number => value !== null),
    -1,
  );
  const availableIds = new Set(agents.map((agent) => agent.id));
  // At the latest lifecycle boundary, the provider's attention list is the
  // canonical Queue contract. During replay it cannot describe historical
  // state, so derive the bounded queue from the projected lifecycle instead.
  const attention = cutoff >= lifecycleBoundary
    ? snapshot.attention.filter((id) => availableIds.has(id))
    : agents
      .filter((agent) => agent.state === "waiting" || agent.state === "needs-you" || (agent.state === "failed" && !agent.parentAgentId))
      .map((agent) => agent.id);
  const attentionIds = new Set(attention);
  const projects = snapshot.projects.map((project) => {
    const members = agents.filter((agent) => agent.projectId === project.id);
    return {
      ...project,
      agentIds: members.map((agent) => agent.id),
      activeCount: members.filter((agent) => ACTIVE_STATES.has(agent.state)).length,
      attentionCount: members.filter((agent) => attentionIds.has(agent.id)).length,
    };
  });
  return { ...snapshot, agents, projects, attention };
}

function completionBoundary(event: AgentEvent): boolean {
  if (event.evidence !== "observed") return false;
  if (event.state === "complete") return true;
  return event.status === "completed" && ["turn", "verification", "system"].includes(event.kind);
}

function approvalSignal(event: AgentEvent): boolean {
  if (event.kind !== "approval") return false;
  if (event.status === "completed" || event.status === "failed" || event.status === "interrupted" || event.status === "declined") return false;
  return event.status === "inProgress" || event.state === "needs-you";
}

function interventionSignal(event: AgentEvent): boolean {
  if (approvalSignal(event)) return true;
  // Reduced provider adapters may preserve the explicit lifecycle state but
  // not the original approval item kind. Count that bounded needs-you signal
  // without interpreting generic waiting or arbitrary labels as a gate.
  return event.state === "needs-you"
    && event.evidence !== "unknown"
    && !["completed", "failed", "interrupted", "declined"].includes(event.status ?? "");
}

function explicitDecision(effective: EffectiveAgent[]): { decision: HumanDecision | null; agent: EffectiveAgent | null } {
  const candidates = effective.flatMap((item) => {
    const latestApproval = [...item.events].reverse().find(approvalSignal);
    const boundedMetadataReason = item.usesMetadata ? safeText(item.agent.attentionReason) : "";
    const stateGate = item.state === "needs-you" && (
      item.evidence !== "unknown"
      || Boolean(boundedMetadataReason)
      || item.latestEvent?.state === "needs-you"
    );
    // A historical approval does not keep a mission asking for the user's
    // attention after a later failure, completion, or recovery event.
    const latestApprovalMs = latestApproval ? eventTime(latestApproval) : null;
    const metadataMs = item.metadataBounded ? metadataTime(item.agent) : null;
    const currentApproval = Boolean(
      latestApproval
      && item.latestEvent?.id === latestApproval.id
      && (metadataMs === null || latestApprovalMs === null || latestApprovalMs >= metadataMs),
    );
    if (!stateGate && !currentApproval) return [];
    const event = currentApproval ? latestApproval : item.latestEvent?.state === "needs-you" ? item.latestEvent : null;
    const reason = boundedMetadataReason
      || safeText(event?.label)
      || "Approval or input is requested";
    return [{ item, event, reason }];
  });
  candidates.sort((left, right) => {
    const leftMs = left.event ? eventTime(left.event) ?? -1 : left.item.lastActivityMs ?? -1;
    const rightMs = right.event ? eventTime(right.event) ?? -1 : right.item.lastActivityMs ?? -1;
    return rightMs - leftMs || left.item.agent.id.localeCompare(right.item.agent.id);
  });
  const winner = candidates[0];
  if (!winner) return { decision: null, agent: null };
  return {
    agent: winner.item,
    decision: {
      kind: winner.event?.kind === "approval" ? "approval" : "input",
      reason: winner.reason,
      agentId: winner.item.agent.id,
      agentName: winner.item.hierarchyAgent.displayName,
      evidence: winner.event?.evidence ?? winner.item.evidence,
      event: winner.event ? safeEvent(winner.event) : null,
    },
  };
}

function phaseIndex(phase: MissionPhase): number {
  return MISSION_PHASE_TRAIL.indexOf(phase as (typeof MISSION_PHASE_TRAIL)[number]);
}

function makeTrail(phase: MissionPhase, observed: ReadonlySet<MissionPhase>): MissionTrailStep[] {
  const currentIndex = phaseIndex(phase);
  const exceptional = currentIndex < 0;
  return MISSION_PHASE_TRAIL.map((trailPhase, index) => ({
    phase: trailPhase,
    label: MISSION_PHASE_LABELS[trailPhase],
    status: exceptional
      ? observed.has(trailPhase) ? "complete" : "blocked"
      : index === currentIndex ? "current" : observed.has(trailPhase) ? "complete" : "upcoming",
  }));
}

function freshness(lastActivityMs: number | null, cutoff: number, staleAfterMs: number): MissionFreshness {
  if (lastActivityMs === null) return "unknown";
  const age = Math.max(0, cutoff - lastActivityMs);
  if (age >= staleAfterMs) return "stale";
  if (age >= Math.min(staleAfterMs / 3, 5 * 60_000)) return "aging";
  return "fresh";
}

function missionId(projectId: string, taskId: string): string {
  return `${projectId}::${taskId}`;
}

function aggregateEvidence(effective: EffectiveAgent[], cutoff: number, staleAfterMs: number): MissionEvidence {
  const latest = effective
    .map((item) => item.latestEvent)
    .filter((event): event is AgentEvent => event !== null)
    .sort(compareLatest)[0] ?? null;
  const lastActivityMs = Math.max(...effective.map((item) => item.lastActivityMs ?? -1), -1);
  const strengthRank: Readonly<Record<EvidenceStrength, number>> = { observed: 2, derived: 1, unknown: 0 };
  const latestEffective = [...effective].sort((left, right) => (
    (right.lastActivityMs ?? -1) - (left.lastActivityMs ?? -1)
    || strengthRank[right.evidence] - strengthRank[left.evidence]
    || left.agent.id.localeCompare(right.agent.id)
  ))[0];
  const strength = latestEffective?.evidence ?? "unknown";
  return {
    strength,
    latestEvent: latest ? safeEvent(latest) : null,
    latestEventAt: latest ? isoTime(eventTime(latest)) : null,
    boundedEventCount: effective.reduce((sum, item) => sum + item.events.length, 0),
    freshness: freshness(lastActivityMs >= 0 ? lastActivityMs : null, cutoff, staleAfterMs),
  };
}

function rootCompletion(task: RootTaskNode, effective: EffectiveAgent[]): { complete: boolean; at: string | null } {
  const root = effective.find((item) => item.agent.id === task.rootAgentId);
  if (!root || root.state !== "complete") return { complete: false, at: null };
  const boundary = root.events.filter(completionBoundary).sort(compareLatest)[0] ?? null;
  if (!boundary) return { complete: false, at: null };
  const boundaryMs = eventTime(boundary);
  const invalidatingStates = new Set<AgentState>([
    ...ACTIVE_STATES,
    "waiting",
    "needs-you",
    "failed",
    "interrupted",
  ]);
  // A root completion supersedes older helper activity. Only a later bounded
  // active, blocked, or failed member state can take the mission out of the
  // completed state. Equal timestamps are part of the same completion edge.
  const blocked = boundaryMs !== null && effective.some((item) => (
    item.agent.id !== root.agent.id
    && invalidatingStates.has(item.state)
    && item.lastActivityMs !== null
    && item.lastActivityMs > boundaryMs
  ));
  return { complete: !blocked, at: isoTime(eventTime(boundary)) };
}

function missionPhase(
  effective: EffectiveAgent[],
  decision: HumanDecision | null,
  rootIsComplete: boolean,
  evidence: MissionEvidence,
): MissionPhase {
  if (rootIsComplete) return "complete";
  if (decision) return "waiting-for-you";
  const hasVerification = effective.some((item) => item.state === "verifying");
  const hasWorking = effective.some((item) => WORKING_STATES.has(item.state));
  const hasPlanning = effective.some((item) => PLANNING_STATES.has(item.state));
  const hasWaiting = effective.some((item) => item.state === "waiting");
  const hasFailure = effective.some((item) => item.state === "failed");
  const hasInterruption = effective.some((item) => item.state === "interrupted");
  const hasIdle = effective.some((item) => item.state === "idle");
  // Active evidence describes recovery in progress. Terminal states take over
  // only when nothing active or waiting is left to explain them.
  if (hasVerification) return "verification";
  if (hasWorking) return "working";
  if (hasFailure && !hasPlanning && !hasWaiting) return "failed";
  if (hasInterruption && !hasPlanning && !hasWaiting) return "interrupted";
  if (hasWaiting) return "waiting-on-agent";
  if (hasPlanning) return "planning";
  if (evidence.freshness === "stale" || effective.some((item) => item.state === "stale")) return "stale";
  if (hasIdle) return "idle";
  return "unknown";
}

function observedPhaseSet(
  effective: EffectiveAgent[],
  decision: HumanDecision | null,
  rootIsComplete: boolean,
): Set<MissionPhase> {
  const observed = new Set<MissionPhase>();
  const record = (state: AgentState) => {
    if (PLANNING_STATES.has(state)) observed.add("planning");
    else if (WORKING_STATES.has(state)) observed.add("working");
    else if (state === "verifying") observed.add("verification");
  };
  effective.forEach((item) => {
    item.events.forEach((event) => {
      record(eventState(event));
      if (event.kind === "verification" && completionBoundary(event)) observed.add("verification");
      if (interventionSignal(event)) observed.add("waiting-for-you");
    });
    // A current state without an event is still bounded by lastSeen and is
    // useful for the live adapter's compact lifecycle projection.
    if (item.metadataBounded) record(item.state);
  });
  if (decision) observed.add("waiting-for-you");
  if (rootIsComplete) observed.add("complete");
  return observed;
}

function missionAgent(item: EffectiveAgent, rootAgentId: string | undefined): MissionAgent {
  const attentionReason = item.usesMetadata && item.state === "needs-you" ? safeText(item.agent.attentionReason) : "";
  return {
    id: item.agent.id,
    displayName: safeText(item.hierarchyAgent.displayName, `Agent ${item.agent.id.slice(-8)}`, 96),
    ...(safeText(item.agent.role, "", 64) ? { role: safeText(item.agent.role, "", 64) } : {}),
    state: item.state,
    effectiveState: item.state,
    evidence: item.evidence,
    isRoot: item.agent.id === rootAgentId,
    needsAttention: item.hierarchyAgent.needsAttention && item.metadataBounded,
    ...(attentionReason ? { attentionReason } : {}),
    latestEvent: item.latestEvent ? safeEvent(item.latestEvent) : null,
    boundedEventCount: item.events.length,
    lastActivityAt: isoTime(item.lastActivityMs),
  };
}

function buildMissionRecord(task: RootTaskNode, projectName: string, cutoff: number, staleAfterMs: number): MissionBuildRecord {
  const effective = task.agents.map((item) => effectiveAgent(item, cutoff));
  const evidence = aggregateEvidence(effective, cutoff, staleAfterMs);
  const completion = rootCompletion(task, effective);
  const { decision: pendingDecision } = explicitDecision(effective);
  // A gate observed before a later verified root completion is resolved. A
  // gate after that boundary prevents completion in rootCompletion above.
  const decision = completion.complete ? null : pendingDecision;
  const phase = missionPhase(effective, decision, completion.complete, evidence);
  const observedSet = observedPhaseSet(effective, decision, completion.complete);
  const observedPhases = MISSION_PHASE_TRAIL.filter((candidate) => observedSet.has(candidate));
  const agents = effective.map((item) => missionAgent(item, task.rootAgentId));
  const lastActivityMs = Math.max(...effective.map((item) => item.lastActivityMs ?? -1), -1);
  const taskName = safeText(task.displayName, `Unresolved task · ${task.id.slice(-8)}`, 120);
  const evolution: MissionEvolution = {
    verified: completion.complete,
    districtLit: completion.complete,
    rootHomeLit: completion.complete,
    bridgeOpen: completion.complete,
  };
  const mission: Mission = {
    id: missionId(task.projectId, task.id),
    projectId: task.projectId,
    projectName: safeText(projectName, "Unassigned project", 96),
    taskId: task.id,
    displayName: taskName,
    phase,
    phaseLabel: MISSION_PHASE_LABELS[phase],
    phaseIndex: phaseIndex(phase),
    observedPhases,
    phaseTrail: makeTrail(phase, observedSet),
    agents,
    agentCount: agents.length,
    activeCount: effective.filter((item) => ACTIVE_STATES.has(item.state)).length,
    waitingCount: effective.filter((item) => item.state === "waiting").length,
    needsYouCount: effective.filter((item) => item.state === "needs-you").length,
    failedCount: effective.filter((item) => item.state === "failed").length,
    interruptedCount: effective.filter((item) => item.state === "interrupted").length,
    completedAgentCount: effective.filter((item) => item.state === "complete").length,
    attentionCount: effective.filter((item) => item.hierarchyAgent.needsAttention && item.metadataBounded).length,
    evidence,
    decision,
    requiresHumanDecision: decision !== null,
    evolution,
    ...(task.rootAgentId ? { rootAgentId: task.rootAgentId } : {}),
    rootCompletionAt: completion.at,
    lastActivityAt: isoTime(lastActivityMs >= 0 ? lastActivityMs : null),
  };
  return { mission, task, effectiveAgents: effective };
}

function utcDayWindow(cutoff: number): ResolvedDailyWindow {
  const day = new Date(cutoff);
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return { start, end: start + 24 * 60 * 60 * 1000, timeZone: "UTC" };
}

function localDayWindow(cutoff: number, requestedTimeZone: string): ResolvedDailyWindow {
  if (requestedTimeZone === "UTC") return utcDayWindow(cutoff);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: requestedTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const partsFor = (instant: number) => Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const local = partsFor(cutoff);
    const approximate = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
    const offsetAt = (instant: number): number => {
      const parts = partsFor(instant);
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      return represented - Math.floor(instant / 1000) * 1000;
    };
    const start = approximate - offsetAt(approximate);
    const nextLocal = new Date(approximate + 24 * 60 * 60 * 1000);
    const nextApproximate = Date.UTC(nextLocal.getUTCFullYear(), nextLocal.getUTCMonth(), nextLocal.getUTCDate());
    const end = nextApproximate - offsetAt(nextApproximate);
    return { start, end: end > start ? end : start + 24 * 60 * 60 * 1000, timeZone: requestedTimeZone };
  } catch {
    return utcDayWindow(cutoff);
  }
}

function resolveDailyWindow(cutoff: number, options: MissionBuildOptions): ResolvedDailyWindow {
  const explicit = options.dailyWindow;
  if (explicit) {
    const start = finiteTime(explicit.start);
    const end = finiteTime(explicit.end);
    if (start !== null && end !== null && end > start) {
      return { start, end, timeZone: explicit.timeZone ?? options.timeZone ?? "UTC" };
    }
  }
  return localDayWindow(cutoff, options.timeZone ?? "UTC");
}

function inDailyWindow(timestamp: number | null, window: ResolvedDailyWindow, cutoff: number): boolean {
  return timestamp !== null && timestamp >= window.start && timestamp < window.end && timestamp <= cutoff;
}

function outcomeState(event: AgentEvent): AgentState {
  return eventState(event);
}

function dailySummary(records: MissionBuildRecord[], cutoff: number, options: MissionBuildOptions): DailySummary {
  const window = resolveDailyWindow(cutoff, options);
  const seen = {
    completions: new Set<string>(),
    interventionSignals: new Set<string>(),
    recoveries: new Set<string>(),
    regressions: new Set<string>(),
  };
  for (const record of records) {
    const missionKey = record.mission.id;
    const root = record.effectiveAgents.find((item) => item.agent.id === record.task.rootAgentId);
    if (root) {
      for (const event of root.events) {
        if (completionBoundary(event) && inDailyWindow(eventTime(event), window, cutoff)) {
          seen.completions.add(`${missionKey}:${event.id}`);
        }
      }
    }
    for (const item of record.effectiveAgents) {
      let previous: AgentState | null = null;
      for (const event of item.events) {
        const state = outcomeState(event);
        if (interventionSignal(event) && inDailyWindow(eventTime(event), window, cutoff)) {
          seen.interventionSignals.add(`${missionKey}:${event.id}`);
        }
        if (previous && TERMINAL_FAILURE_STATES.has(previous) && (ACTIVE_STATES.has(state) || state === "complete") && inDailyWindow(eventTime(event), window, cutoff)) {
          seen.recoveries.add(`${missionKey}:${event.id}`);
        }
        if (previous === "complete" && (TERMINAL_FAILURE_STATES.has(state) || state === "needs-you") && inDailyWindow(eventTime(event), window, cutoff)) {
          seen.regressions.add(`${missionKey}:${event.id}`);
        }
        // Unknown evidence cannot prove a transition, but it should not erase
        // a known predecessor from the bounded sequence.
        if (state !== "unknown") previous = state;
      }
    }
  }
  return {
    windowStart: new Date(window.start).toISOString(),
    windowEnd: new Date(window.end).toISOString(),
    timeZone: window.timeZone,
    asOf: isoTime(cutoff) ?? new Date(0).toISOString(),
    coverage: "bounded-snapshot",
    completions: seen.completions.size,
    interventionSignals: seen.interventionSignals.size,
    recoveries: seen.recoveries.size,
    regressions: seen.regressions.size,
  };
}

/** Build one mission for every root task in the semantic hierarchy. */
export function buildMissionWorld(
  snapshot: WorldSnapshot,
  replayCutoff?: number | string | Date,
  options: MissionBuildOptions = {},
): MissionWorld {
  const generated = finiteTime(snapshot.generatedAt);
  const requestedCutoff = finiteTime(replayCutoff);
  // A normalized snapshot always has generatedAt. Keep malformed embedded
  // fixtures deterministic too, rather than constructing an invalid Date.
  const cutoff = requestedCutoff ?? generated ?? 0;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && (options.staleAfterMs ?? 0) > 0
    ? Number(options.staleAfterMs)
    : 30 * 60_000;
  const hierarchy = buildWorldHierarchy(snapshot);
  const records = hierarchy.projects.flatMap((project) => project.tasks.map((task) => (
    buildMissionRecord(task, project.displayName, cutoff, staleAfterMs)
  )));
  const missions = records.map((record) => record.mission);
  const projects = hierarchy.projects.map((project) => {
    const projectMissions = missions.filter((mission) => mission.projectId === project.project.id);
    return {
      id: project.project.id,
      displayName: safeText(project.displayName, `Project ${project.project.id.slice(-8)}`, 96),
      missionCount: projectMissions.length,
      agentCount: projectMissions.reduce((sum, mission) => sum + mission.agentCount, 0),
      attentionCount: projectMissions.reduce((sum, mission) => sum + mission.attentionCount, 0),
      completeCount: projectMissions.filter((mission) => mission.phase === "complete").length,
      missions: projectMissions,
    } satisfies MissionProject;
  });
  const daily = dailySummary(records, cutoff, options);
  return {
    replayCutoff: cutoff,
    replayCutoffIso: isoTime(cutoff),
    sourceMode: snapshot.mode,
    projects,
    missions,
    missionCount: missions.length,
    agentCount: missions.reduce((sum, mission) => sum + mission.agentCount, 0),
    attentionCount: missions.reduce((sum, mission) => sum + mission.attentionCount, 0),
    dailySummary: daily,
  };
}

/** Resolve a task without relying on a globally unique root ID. */
export function missionForTask(world: MissionWorld, projectId: string, taskId: string): Mission | null {
  return world.missions.find((mission) => mission.projectId === projectId && mission.taskId === taskId) ?? null;
}

export function missionPhaseLabel(phase: MissionPhase): string {
  return MISSION_PHASE_LABELS[phase];
}

export { missionId };
