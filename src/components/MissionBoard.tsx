import { taskTarget, type NavigationTarget } from "../lib/hierarchy";
import {
  MISSION_PHASE_LABELS,
  MISSION_PHASE_TRAIL,
  type Mission,
  type MissionTrailStep,
  type MissionWorld,
} from "../lib/missions";

export interface MissionBoardProps {
  /** The complete mission projection, never the filtered agent subset. */
  world: MissionWorld;
  onNavigate: (target: NavigationTarget) => void;
  onOpenAgent: (agentId: string) => void;
}

const EVIDENCE_LABELS = {
  observed: "Observed",
  derived: "Derived",
  unknown: "Evidence unavailable",
} as const;

const FRESHNESS_LABELS = {
  fresh: "Fresh",
  aging: "Aging",
  stale: "Stale",
  unknown: "Freshness unavailable",
} as const;

function safeText(value: unknown, fallback: string): string {
  let text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  text = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:~[\\/]|\/(?:Users|home|private|var|tmp)\/[^\s]+|[A-Za-z]:[\\/][^\s]+|file:\/\/[^\s]+)/gi, "[redacted]")
    .replace(/\b(?:token|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\?/g, "…")
    .trim();
  if (/^(?:untitled\s+task|unnamed\s+task|task|thread|agent)\s*[·#:_-]?\s*[a-z0-9]{6,}(?:…)?$/i.test(text)) return fallback;
  return text || fallback;
}

function safeMissionName(mission: Mission): string {
  return safeText(mission.displayName, "Unnamed task");
}

function safeProjectName(mission: Mission): string {
  return safeText(mission.projectName, "Unnamed project");
}

function evidenceLabel(strength: Mission["evidence"]["strength"]): string {
  return EVIDENCE_LABELS[strength] ?? "Evidence unavailable";
}

function freshnessLabel(freshness: Mission["evidence"]["freshness"]): string {
  return FRESHNESS_LABELS[freshness] ?? "Freshness unavailable";
}

function formatStatusSummary(mission: Mission): string {
  const parts = [
    mission.activeCount > 0 ? `${mission.activeCount} active` : "",
    mission.waitingCount > 0 ? `${mission.waitingCount} waiting` : "",
    mission.needsYouCount > 0 ? `${mission.needsYouCount} needs you` : "",
    mission.completedAgentCount > 0 ? `${mission.completedAgentCount} complete` : "",
    mission.failedCount > 0 ? `${mission.failedCount} failed` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No active agents";
}

function needsYouCountLabel(value: number): string {
  return `${value} ${value === 1 ? "needs" : "need"} you`;
}

interface WindowParts {
  startDate: string;
  endDate: string;
  sameDate: boolean;
  startTime: string;
  endTime: string;
  range: string;
  valid: boolean;
}

function formatWindowParts(summary: MissionWorld["dailySummary"]): WindowParts {
  const start = Date.parse(summary.windowStart);
  const end = Date.parse(summary.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return {
      startDate: "Local day",
      endDate: "Local day",
      sameDate: true,
      startTime: "Window unavailable",
      endTime: "",
      range: "Window unavailable",
      valid: false,
    };
  }
  try {
    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeZone: summary.timeZone,
    });
    const timeFormatter = new Intl.DateTimeFormat(undefined, {
      timeStyle: "short",
      timeZone: summary.timeZone,
    });
    const startDate = new Date(start);
    const endDate = new Date(end);
    const startDay = dateFormatter.format(startDate);
    const endDay = dateFormatter.format(endDate);
    const startTime = timeFormatter.format(startDate);
    const endTime = timeFormatter.format(endDate);
    return {
      startDate: startDay,
      endDate: endDay,
      sameDate: startDay === endDay,
      startTime,
      endTime,
      range: `${startTime} to ${endTime}`,
      valid: true,
    };
  } catch {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const startDay = startDate.toLocaleDateString(undefined, { dateStyle: "medium" });
    const endDay = endDate.toLocaleDateString(undefined, { dateStyle: "medium" });
    const startTime = startDate.toLocaleTimeString(undefined, { timeStyle: "short" });
    const endTime = endDate.toLocaleTimeString(undefined, { timeStyle: "short" });
    return {
      startDate: startDay,
      endDate: endDay,
      sameDate: startDay === endDay,
      startTime,
      endTime,
      range: `${startTime} to ${endTime}`,
      valid: true,
    };
  }
}

const COMPACT_PHASE_LABELS: Record<MissionTrailStep["phase"], string> = {
  planning: "Plan",
  working: "Work",
  verification: "Verify",
  "waiting-for-you": "Review",
  complete: "Done",
};

function phaseStepLabel(step: MissionTrailStep): string {
  return safeText(step.label, MISSION_PHASE_LABELS[step.phase]);
}

function phaseStatusLabel(status: MissionTrailStep["status"]): string {
  switch (status) {
    case "complete":
      return "completed";
    case "current":
      return "current phase";
    case "upcoming":
      return "not reached";
    case "blocked":
      return "not observed";
  }
}

function PhaseTrail({ mission }: { mission: Mission }) {
  return (
    <ol className="mission-phase-trail" aria-label={`Phase trail for ${safeMissionName(mission)}`}>
      {mission.phaseTrail.map((step) => {
        const label = phaseStepLabel(step);
        const status = phaseStatusLabel(step.status);
        return (
          <li
            key={step.phase}
            className={`mission-phase mission-phase--${step.phase} is-${step.status}`}
            aria-label={`${label}: ${status}`}
            aria-current={step.status === "current" ? "step" : undefined}
            data-phase-status={step.status}
            title={`${label} · ${status}`}
          >
            <span className="mission-phase__marker" aria-hidden="true">
              {step.status === "complete" ? "✓" : MISSION_PHASE_TRAIL.indexOf(step.phase) + 1}
            </span>
            <span className="mission-phase__label">{label}</span>
            <span className="mission-phase__short-label" aria-hidden="true">{COMPACT_PHASE_LABELS[step.phase]}</span>
            <span className="sr-only">{status}</span>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceLine({ mission }: { mission: Mission }) {
  const strength = mission.evidence.strength;
  const latestLabel = mission.evidence.latestEvent?.label
    ? safeText(mission.evidence.latestEvent.label, "Recorded activity")
    : "No event label";
  return (
    <div className={`mission-evidence mission-evidence--${strength}`}>
      <span className="mission-evidence__dot" aria-hidden="true" />
      <span>{evidenceLabel(strength)}</span>
      <span aria-hidden="true">·</span>
      <span>{freshnessLabel(mission.evidence.freshness)}</span>
      <span className="mission-evidence__event-separator" aria-hidden="true">·</span>
      <span className="mission-evidence__event">{latestLabel}</span>
    </div>
  );
}

function MissionDecision({ mission, onOpenAgent, onNavigate }: {
  mission: Mission;
  onOpenAgent: (agentId: string) => void;
  onNavigate: (target: NavigationTarget) => void;
}) {
  const decision = mission.decision;
  if (!mission.requiresHumanDecision || !decision) return null;
  const name = safeMissionName(mission);
  const reason = safeText(decision.reason, "A human decision is requested");
  const eventLabel = decision.event?.label ?? mission.evidence.latestEvent?.label;
  const evidence = safeText(eventLabel, `${evidenceLabel(decision.evidence)} signal`);
  const openTask = () => onNavigate(taskTarget(mission.projectId, mission.taskId));
  return (
    <section className="mission-decision" aria-label={`Your move for ${name}`} data-mission-decision="required">
      <div className="mission-decision__marker" aria-hidden="true">!</div>
      <div className="mission-decision__body">
        <strong>Your move</strong>
        <span>{reason}</span>
        <small>Evidence: {evidenceLabel(decision.evidence)} · {evidence}</small>
      </div>
      {decision.agentId ? (
        <button
          type="button"
          className="mission-decision__action"
          aria-label={`Review in map ${name}`}
          onClick={() => onOpenAgent(decision.agentId)}
        >
          Review in map <span aria-hidden="true">→</span>
        </button>
      ) : (
        <button type="button" className="mission-decision__action" aria-label={`Review in map ${name}`} onClick={openTask}>
          Review in map <span aria-hidden="true">→</span>
        </button>
      )}
    </section>
  );
}

function MissionRow({ mission, onNavigate, onOpenAgent }: {
  mission: Mission;
  onNavigate: (target: NavigationTarget) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const name = safeMissionName(mission);
  const project = safeProjectName(mission);
  const phase = mission.phase;
  const phaseLabel = safeText(mission.phaseLabel, MISSION_PHASE_LABELS[phase]);
  const openTask = () => onNavigate(taskTarget(mission.projectId, mission.taskId));
  return (
    <article
      className={`mission-row mission-row--${phase}`}
      data-mission-id={mission.id}
      data-mission-phase={phase}
      data-task-id={mission.taskId}
    >
      <div className="mission-row__topline">
        <span className="mission-row__project">{project}</span>
        <span className={`mission-row__phase mission-row__phase--${phase}`}>{phaseLabel}</span>
      </div>

      <div className="mission-row__heading">
        <h3 className="mission-row__title" data-mission-row={mission.taskId}>
          <span className="mission-row__title-mark" aria-hidden="true" />
          <span>{name}</span>
        </h3>
        {!mission.requiresHumanDecision ? (
          <button type="button" className="mission-row__open" aria-label={`Open mission ${name}`} onClick={openTask}>
            Open mission <span aria-hidden="true">→</span>
          </button>
        ) : null}
      </div>

      <div className="mission-row__meta">
        <span>{mission.agentCount} {mission.agentCount === 1 ? "agent" : "agents"}</span>
        <span aria-hidden="true">·</span>
        <span>{formatStatusSummary(mission)}</span>
        <EvidenceLine mission={mission} />
      </div>

      <PhaseTrail mission={mission} />
      <MissionDecision mission={mission} onOpenAgent={onOpenAgent} onNavigate={onNavigate} />
    </article>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="mission-summary__metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function MissionBoard({ world, onNavigate, onOpenAgent }: MissionBoardProps) {
  const summary = world.dailySummary;
  const windowParts = formatWindowParts(summary);
  const summaryTimeZone = safeText(summary.timeZone, "Local time");
  const missionCount = world.missionCount;
  const attentionCount = world.missions.filter((mission) => mission.requiresHumanDecision).length;
  const isDemo = world.sourceMode === "demo";
  const boardLabel = isDemo ? "Mission board · sample" : "Mission board";
  return (
    <section className="mission-board" aria-label={boardLabel} data-mission-board data-source-mode={isDemo ? "demo" : "live"}>
      <header className="mission-board__header">
        <div>
          <p className="eyebrow">MISSION BOARD</p>
          <h2>See every mission and the next decision</h2>
          <p className="mission-board__lede">
            Each mission is one root task and its helper agents.
            <span className="mission-board__lede-detail"> {missionCount} {missionCount === 1 ? "mission" : "missions"} from recorded task evidence.</span>
            {attentionCount > 0 ? <span> {attentionCount} {attentionCount === 1 ? "needs" : "need"} you.</span> : null}
          </p>
        </div>
        <span className="mission-board__count" aria-label={`${missionCount} missions, ${needsYouCountLabel(attentionCount)}`}>
          <strong>{missionCount}</strong>
          <span>{attentionCount > 0 ? needsYouCountLabel(attentionCount) : "tracked"}</span>
        </span>
      </header>

      <div className="mission-board__layout">
        <div className="mission-board__list" role="list" aria-label="Tracked missions">
          {world.missions.length > 0 ? world.missions.map((mission) => (
            <div role="listitem" key={mission.id}>
              <MissionRow mission={mission} onNavigate={onNavigate} onOpenAgent={onOpenAgent} />
            </div>
          )) : (
            <div className="mission-board__empty" role="status">
              <strong>No missions in this snapshot</strong>
              <span>When a root task is recorded, its evidence will appear here.</span>
            </div>
          )}
        </div>

        <aside
          className="mission-summary"
          aria-label="Daily summary"
          data-daily-summary
          data-window-start={summary.windowStart}
          data-window-end={summary.windowEnd}
          data-time-zone={summaryTimeZone}
        >
          <div className="mission-summary__heading">
            <div>
              <p className="section-label">DAILY SUMMARY</p>
              <h3
                className="mission-summary__window"
                aria-label={`Window ${windowParts.sameDate ? windowParts.startDate : `${windowParts.startDate} to ${windowParts.endDate}`}, ${windowParts.range}, time zone ${summaryTimeZone}`}
              >
                <span className="mission-summary__date">
                  {windowParts.valid ? <time dateTime={summary.windowStart}>{windowParts.startDate}</time> : windowParts.startDate}
                  {!windowParts.sameDate ? <> to <time dateTime={summary.windowEnd}>{windowParts.endDate}</time></> : null}
                </span>
                <span className="mission-summary__range">
                  {windowParts.valid ? (
                    <><time dateTime={summary.windowStart}>{windowParts.startTime}</time> to <time dateTime={summary.windowEnd}>{windowParts.endTime}</time></>
                  ) : windowParts.range}
                </span>
              </h3>
            </div>
            <span className="mission-summary__scope">Time zone: {summaryTimeZone}</span>
          </div>
          <div className="mission-summary__metrics">
            <SummaryMetric label="completions" value={summary.completions} />
            <SummaryMetric label="intervention signals" value={summary.interventionSignals} />
            <SummaryMetric label="recoveries" value={summary.recoveries} />
            <SummaryMetric label="regressions" value={summary.regressions} />
          </div>
          <p className="mission-summary__coverage">
            <span className="mission-summary__coverage-mark" aria-hidden="true">◌</span>
            Based on bounded recorded evidence. Counts may be incomplete when the source retains only a recent event window.
          </p>
        </aside>
      </div>
    </section>
  );
}
