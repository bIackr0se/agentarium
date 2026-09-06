import { WorldIcon } from "./WorldIcon";
import type { AgentSnapshot, WorldSnapshot } from "../lib/contracts";
import { buildWorldHierarchy, displayAgentDescriptor, displayAgentName } from "../lib/hierarchy";
import { humanizeState } from "./Toolbar";

export interface AttentionRailProps {
  snapshot: WorldSnapshot;
  agents: AgentSnapshot[];
  selectedId: string | null;
  attentionOnly: boolean;
  onSelect: (agentId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  onAttentionChange: (value: boolean) => void;
}

function isAttentionAgent(agent: AgentSnapshot, snapshot: WorldSnapshot): boolean {
  return snapshot.attention.includes(agent.id);
}

function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function attentionReason(agent: AgentSnapshot): string {
  if (agent.attentionReason) return agent.attentionReason;
  if (agent.state === "waiting") return "Waiting on another agent or external result";
  if (agent.state === "needs-you") return "Approval or input is requested";
  if (agent.state === "failed") return "The latest run failed";
  return "This task is blocked";
}

export function AttentionRail({
  snapshot,
  agents,
  selectedId,
  attentionOnly,
  onSelect,
  onOpenAgent,
  onAttentionChange,
}: AttentionRailProps) {
  const attentionAgents = agents.filter((agent) => isAttentionAgent(agent, snapshot));
  const isDemo = snapshot.mode === "demo";
  const hierarchy = buildWorldHierarchy(snapshot);
  const hierarchyAgentById = new Map(hierarchy.agents.map((item) => [item.agent.id, item]));
  const taskByKey = new Map(hierarchy.tasks.map((task) => [`${task.projectId}:${task.id}`, task]));

  return (
    <section
      className={`attention-tray${isDemo ? " attention-tray--demo" : ""}`}
      aria-label={isDemo ? "Demo task queue" : "Current task queue"}
      data-queue-kind={isDemo ? "sample" : "current"}
    >
      <div className="attention-tray__heading">
        <div>
          <p className="eyebrow">TASK QUEUE</p>
          <h2>Waiting on something</h2>
          <p className="attention-tray__subline">
            {isDemo ? "Sample waits and review decisions" : "Current waits, failed root runs, and human decisions"}
          </p>
        </div>
        <div className="attention-tray__actions">
          <span className="rail-count" aria-label={`${attentionAgents.length} queued tasks`}>
            {attentionAgents.length}
          </span>
          <button
            type="button"
            className={`attention-filter${attentionOnly ? " is-active" : ""}`}
            aria-pressed={attentionOnly}
            onClick={() => onAttentionChange(!attentionOnly)}
          >
            <span className="attention-filter__icon" aria-hidden="true">✦</span>
            <span>{attentionOnly ? "Showing queue only" : "Focus queue"}</span>
            <span aria-hidden="true" className="attention-filter__arrow">→</span>
          </button>
        </div>
      </div>

      <div className="attention-list" role="list">
        {attentionAgents.length > 0 ? (
          attentionAgents.map((agent) => {
            const selected = agent.id === selectedId;
            const hierarchyAgent = hierarchyAgentById.get(agent.id);
            const task = hierarchyAgent
              ? taskByKey.get(`${agent.projectId}:${hierarchyAgent.rootTaskId}`)
              : undefined;
            const taskName = task?.displayName ?? "Task context unavailable";
            const descriptor = displayAgentDescriptor(agent);
            return (
              <div key={agent.id} role="listitem">
                <button
                  type="button"
                  className={`attention-item${selected ? " is-selected" : ""}${isDemo ? " attention-item--sample" : ""}`}
                  data-queue-item={isDemo ? "sample" : "current"}
                  onClick={() => (onOpenAgent ?? onSelect)(agent.id)}
                  aria-current={selected ? "true" : undefined}
                  aria-label={`Open task for ${displayAgentName(agent)}`}
                  aria-description={`Task: ${taskName}. ${descriptor || "Role not reported"}. State: ${humanizeState(agent.state)}.`}
                >
                  <span className={`state-orb state-orb--${agent.state}`} aria-hidden="true">
                    <span />
                  </span>
                  <span className="attention-item__body">
                    <span className="attention-item__title" data-queue-agent-id={agent.id}>{displayAgentName(agent)}</span>
                    <span className="attention-item__project">
                      {[descriptor, agent.projectName].filter(Boolean).join(" · ")}
                    </span>
                    <span className="attention-item__project attention-item__task" data-queue-task-id={task?.id ?? hierarchyAgent?.rootTaskId}>
                      Task: {taskName}
                    </span>
                    <span className="attention-item__reason">{attentionReason(agent)}</span>
                  </span>
                  <span className="attention-item__meta">
                    <span className={`state-label state-label--${agent.state}`}>{humanizeState(agent.state)}</span>
                    <span>{formatAge(agent.ageMs)}</span>
                    <span className="attention-item__open">Open task <WorldIcon name="arrow" /></span>
                  </span>
                </button>
              </div>
            );
          })
        ) : (
          <div className="empty-rail">
            <span className="empty-rail__glyph"><WorldIcon name="check" /></span>
            <strong>Task queue clear</strong>
            <span>{isDemo ? "No queued sample scenarios in this view." : "No live waits or blockers in this view."}</span>
          </div>
        )}
      </div>

      <div className="attention-tray__footer">
        <div className="legend-row">
          <span className="legend-key"><span className="legend-dot legend-dot--observed" />Observed</span>
          <span className="legend-key"><span className="legend-dot legend-dot--derived" />Derived</span>
          <span className="legend-key"><span className="legend-dot legend-dot--unknown" />Evidence unavailable</span>
        </div>
        <p>{isDemo ? "Only current sample waits and decisions appear here." : "Historical interruptions and stale health signals stay off this live queue."}</p>
      </div>
    </section>
  );
}
