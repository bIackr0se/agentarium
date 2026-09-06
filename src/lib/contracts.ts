export type AgentState =
  | "thinking"
  | "reading"
  | "editing"
  | "running"
  | "delegating"
  | "waiting"
  | "needs-you"
  | "verifying"
  | "failed"
  | "complete"
  | "interrupted"
  | "idle"
  | "stale"
  | "unknown";

export type EvidenceStrength = "observed" | "derived" | "unknown";

export type EventKind =
  | "turn"
  | "command"
  | "file"
  | "tool"
  | "collaboration"
  | "message"
  | "approval"
  | "verification"
  | "system";

export interface AgentEvent {
  id: string;
  agentId: string;
  timestamp: string;
  kind: EventKind;
  label: string;
  state: AgentState;
  /** Bounded provider provenance such as local-db, langgraph, or demo. */
  source: string;
  evidence: EvidenceStrength;
  durationMs?: number;
  status?: "inProgress" | "completed" | "failed" | "interrupted" | "declined";
}

export interface AgentSnapshot {
  id: string;
  /** Human-facing agent nickname when the configured source provides one. */
  nickname?: string;
  /** Bounded role label such as explorer or reviewer. */
  role?: string;
  /** Privacy-safe basename-derived assignment label, never a raw path. */
  assignment?: string;
  title: string;
  projectId: string;
  projectName: string;
  state: AgentState;
  evidence: EvidenceStrength;
  lastSeen: string;
  ageMs: number;
  currentAction: string;
  model?: string;
  reasoningEffort?: string;
  tokenUsage?: number;
  branch?: string;
  /** Optional parent execution unit for task/crew hierarchy. */
  parentAgentId?: string;
  childCount: number;
  attentionReason?: string;
  events: AgentEvent[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  color: string;
  agentIds: string[];
  activeCount: number;
  attentionCount: number;
}

export interface WorldSnapshot {
  schemaVersion: 1;
  mode: "live" | "demo";
  generatedAt: string;
  sourceFreshness: string;
  /** Optional provider label such as LangGraph, CrewAI, or Local adapter. */
  sourceLabel?: string;
  projects: ProjectSnapshot[];
  agents: AgentSnapshot[];
  attention: string[];
  privacy: {
    rawContentExposed: false;
    redactionsApplied: number;
  };
  warnings: string[];
}
