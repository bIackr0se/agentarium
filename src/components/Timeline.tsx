import type { AgentEvent, AgentSnapshot, EvidenceStrength } from "../lib/contracts";
import { displayAgentName } from "../lib/hierarchy";

export interface TimelineProps {
  agents: AgentSnapshot[];
  replayCutoff: number;
  replayBounds: { min: number; max: number };
  onReplayCutoff: (value: number) => void;
  onResetReplay: () => void;
}

interface TimelineEvent extends AgentEvent {
  agentTitle: string;
  projectName: string;
}

const evidenceLabels: Record<EvidenceStrength, string> = {
  observed: "Observed",
  derived: "Derived",
  unknown: "Evidence unavailable",
};

function eventTime(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "time unknown";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || durationMs < 1_000) return null;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  return `${Math.floor(durationMs / 60_000)}m`;
}

function evidenceClass(evidence: EvidenceStrength): string {
  return `evidence-badge evidence-badge--${evidence}`;
}

export function Timeline({ agents, replayCutoff, replayBounds, onReplayCutoff, onResetReplay }: TimelineProps) {
  const events: TimelineEvent[] = agents
    .flatMap((agent) =>
      agent.events.map((event) => ({
        ...event,
        agentTitle: displayAgentName(agent),
        projectName: agent.projectName,
      })),
    )
    .sort((a, b) => (eventTime(a.timestamp) ?? Number.POSITIVE_INFINITY) - (eventTime(b.timestamp) ?? Number.POSITIVE_INFINITY));

  const min = replayBounds.min;
  const max = replayBounds.max;
  // Keep the global replay window even when search or queue filters leave only
  // an agent whose first event is later. Clamping to that subset's local
  // minimum would silently move the user forward and expose future evidence.
  const requestedCutoff = Number.isFinite(replayCutoff) ? replayCutoff : max;
  const boundedCutoff = Math.min(max, Math.max(min, requestedCutoff));
  const hasRange = max > min;
  const replaying = hasRange && boundedCutoff < max;
  const shownEvents = events.filter((event) => {
    const timestamp = eventTime(event.timestamp);
    return timestamp !== null && timestamp <= boundedCutoff;
  }).slice(-7).reverse();

  return (
    <section className="timeline-panel" aria-label="Evidence timeline">
      <div className="timeline-header">
        <div>
          <p className="eyebrow">EVIDENCE STREAM</p>
          <h2>Replay the work</h2>
        </div>
        <div className="timeline-header__status">
          <span className="timeline-date">{formatDate(new Date(boundedCutoff).toISOString())}</span>
          {replaying ? (
            <button type="button" className="timeline-live-button" onClick={onResetReplay}>
              Return to live
            </button>
          ) : (
            <span className="timeline-live"><span className="live-dot" />Live</span>
          )}
        </div>
      </div>

      <div className="replay-control">
        <span className="replay-control__edge">{formatTime(new Date(min).toISOString())}</span>
        <label className="replay-range">
          <span className="sr-only">Replay timeline</span>
          <input
            data-testid="timeline-slider"
            type="range"
            min={min}
            max={max}
            step={1_000}
            value={boundedCutoff}
            onChange={(event) => onReplayCutoff(Number(event.target.value))}
            aria-label="Replay timeline"
            aria-valuetext={replaying ? `Showing events through ${formatTime(new Date(boundedCutoff).toISOString())}` : "Showing live events"}
            disabled={!hasRange}
          />
          <span className="replay-range__track" aria-hidden="true">
            {events.slice(-12).map((event) => {
              const timestamp = eventTime(event.timestamp);
              if (timestamp === null) return null;
              const left = max === min ? 100 : ((timestamp - min) / (max - min)) * 100;
              return <span key={event.id} className={`timeline-tick timeline-tick--${event.evidence}`} style={{ left: `${left}%` }} />;
            })}
          </span>
        </label>
        <span className="replay-control__edge">{formatTime(new Date(max).toISOString())}</span>
      </div>

      <div className="timeline-list" role="log" aria-live="polite" aria-label="Recent evidence events">
        {shownEvents.length > 0 ? (
          shownEvents.map((event) => {
            const duration = formatDuration(event.durationMs);
            return (
              <article key={event.id} className={`timeline-event timeline-event--${event.state}`}>
                <div className="timeline-event__when">
                  <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
                  {duration ? <span aria-label={`Duration ${duration}`}>{duration}</span> : null}
                </div>
                <div className="timeline-event__body">
                  <strong className="timeline-event__label">{event.label}</strong>
                  <span className="timeline-event__context" aria-label={`${event.agentTitle} in ${event.projectName}`}>
                    <span className="timeline-event__agent">{event.agentTitle}</span>
                    <span className="timeline-event__separator" aria-hidden="true">·</span>
                    <span className="timeline-event__project">{event.projectName}</span>
                  </span>
                </div>
                <span className={evidenceClass(event.evidence)}>{evidenceLabels[event.evidence]}</span>
              </article>
            );
          })
        ) : (
          <p className="timeline-empty">No evidence events in this view.</p>
        )}
      </div>
      <p className="timeline-note">Replay is a view of recorded evidence. It never sends commands to the connected source.</p>
    </section>
  );
}
