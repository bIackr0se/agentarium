import { WorldIcon } from "./WorldIcon";
import { useLayoutEffect, useRef } from "react";
import type { AgentEvent, AgentSnapshot, AgentState, EvidenceStrength, WorldSnapshot } from "../lib/contracts";
import { displayAgentDescriptor, displayAgentName } from "../lib/hierarchy";
import { projectAgentAtCutoff } from "../lib/missions";
import { humanizeState } from "./Toolbar";

export interface InspectorProps {
  agent: AgentSnapshot;
  mode: WorldSnapshot["mode"];
  replayCutoff: number;
  onClose: () => void;
  /** Optional explicit opener. When absent, the active element is captured on mount. */
  opener?: HTMLElement | null;
}

const stateDescriptions: Record<AgentState, string> = {
  thinking: "The agent is reasoning, but no external action is currently recorded.",
  reading: "The agent is inspecting project context or an input source.",
  editing: "A file change is currently being recorded for this task.",
  running: "A command or tool is running with an observable lifecycle.",
  delegating: "This task has handed work to another agent.",
  waiting: "The agent is waiting for another task or external result.",
  "needs-you": "A human decision or approval is required before this can continue.",
  verifying: "The agent is checking its work against a verification boundary.",
  failed: "The latest agent run ended in failure. Earlier failed steps remain in the event trail without overriding a later completion.",
  complete: "The task has a recorded completion event.",
  interrupted: "The last agent run stopped before completion. The source does not claim whether this was cancellation, shutdown, or another interruption.",
  idle: "No active turn is recorded for this task.",
  stale: "The observer has not received fresh evidence within its freshness window.",
  unknown: "The available evidence does not support a more specific state.",
};

const evidenceLabels: Record<EvidenceStrength, string> = {
  observed: "Observed",
  derived: "Derived",
  unknown: "Evidence unavailable",
};

function eventTime(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatTokens(tokens?: number): string {
  if (!Number.isFinite(tokens)) return "Not reported";
  if ((tokens ?? 0) >= 1_000_000) return `${((tokens ?? 0) / 1_000_000).toFixed(1)}M`;
  if ((tokens ?? 0) >= 1_000) return `${Math.round((tokens ?? 0) / 1_000)}k`;
  return `${tokens}`;
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs < 1_000) return "instant";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") {
    try {
      dialog.close();
      return;
    } catch {
      // A partially supported dialog implementation can expose close() but
      // still reject it when showModal() was unavailable.
    }
  }
  dialog.removeAttribute("open");
}

function EventRow({ event }: { event: AgentEvent }) {
  return (
    <li className={`inspector-event inspector-event--${event.state}`}>
      <span className="inspector-event__marker" aria-hidden="true"><span /></span>
      <div className="inspector-event__content">
        <div className="inspector-event__topline">
          <strong>{event.label}</strong>
          <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
        </div>
        <div className="inspector-event__meta">
          <span>{event.kind}</span>
          {event.status ? <span>{event.status}</span> : null}
          {event.durationMs ? <span>{formatDuration(event.durationMs)}</span> : null}
          <span className={`evidence-badge evidence-badge--${event.evidence}`}>{evidenceLabels[event.evidence]}</span>
        </div>
      </div>
    </li>
  );
}

export function Inspector({ agent: currentAgent, mode, replayCutoff, onClose, opener }: InspectorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (!openerRef.current) {
      const candidate = opener ?? document.activeElement;
      if (candidate instanceof HTMLElement && !dialog.contains(candidate)) {
        openerRef.current = candidate;
      }
    }

    const restoreFocus = () => {
      const target = openerRef.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
    const requestClose = (event?: Event) => {
      event?.preventDefault();
      if (dialog.open) closeDialog(dialog);
      restoreFocus();
      onCloseRef.current();
    };
    const handleCancel = (event: Event) => requestClose(event);

    dialog.addEventListener("cancel", handleCancel);

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        try {
          dialog.showModal();
        } catch {
          // Keep the contract usable in embedded/webview runtimes that expose
          // HTMLDialogElement but do not implement the modal methods.
          dialog.setAttribute("open", "");
        }
      } else {
        dialog.setAttribute("open", "");
      }
    }

    const initialFocus = dialog.querySelector<HTMLElement>("[data-inspector-initial-focus]")
      ?? dialog.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    initialFocus?.focus({ preventScroll: true });

    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      // React development remounts can deliver a native close event after the
      // next effect has attached. App state is therefore closed only through
      // the explicit button or cancel paths above, never from cleanup.
      if (dialog.open) closeDialog(dialog);
      restoreFocus();
    };
  }, [opener]);

  const requestClose = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) closeDialog(dialog);
    const target = openerRef.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
    onCloseRef.current();
  };

  const agent = projectAgentAtCutoff(currentAgent, replayCutoff);
  const displayName = displayAgentName(agent);
  const descriptor = displayAgentDescriptor(agent);
  const visibleEvents = agent.events
    .filter((event) => {
      const timestamp = eventTime(event.timestamp);
      return timestamp !== null && timestamp <= replayCutoff;
    })
    .sort((a, b) => (eventTime(b.timestamp) ?? Number.NEGATIVE_INFINITY) - (eventTime(a.timestamp) ?? Number.NEGATIVE_INFINITY));
  const lastSeenAt = eventTime(agent.lastSeen);
  const lastSeenLabel = lastSeenAt !== null && lastSeenAt <= replayCutoff
    ? formatTimestamp(agent.lastSeen)
    : "Unavailable at this replay point";

  return (
    <dialog ref={dialogRef} className="inspector" aria-modal="true" aria-label={`Inspector for ${displayName}`} data-testid="inspector">
      <div className="inspector__header">
        <div>
          <p className="eyebrow">AGENT INSPECTOR</p>
          <span className="inspector__id">{agent.id}</span>
        </div>
        <button type="button" className="icon-button inspector-close" onClick={requestClose} aria-label="Close agent inspector" data-inspector-initial-focus>
          <WorldIcon name="close" />
        </button>
      </div>

      <div className="inspector__identity">
        <span className={`state-orb state-orb--${agent.state}`} aria-hidden="true"><span /></span>
        <div>
          <h2>{displayName}</h2>
          <p>{[descriptor, agent.projectName].filter(Boolean).join(" · ")}</p>
        </div>
      </div>

      <div className="inspector-state-row">
        <span className={`state-label state-label--${agent.state}`}>{humanizeState(agent.state)}</span>
        {agent.state === "unknown" && agent.evidence === "unknown" ? null : (
          <span className={`evidence-badge evidence-badge--${agent.evidence}`}>
            <span className="evidence-badge__dot" aria-hidden="true" />
            {evidenceLabels[agent.evidence]}
          </span>
        )}
      </div>

      <div className="readonly-callout">
        <span className="readonly-callout__icon" aria-hidden="true">⌁</span>
        <div>
          <strong>Read-only view</strong>
          <span>This view shows bounded evidence only. It cannot send prompts or commands.</span>
        </div>
      </div>

      <section className="inspector-section inspector-section--action">
        <p className="section-label">{agent.evidence === "observed" ? "LATEST OBSERVED ACTIVITY" : agent.evidence === "derived" ? "LATEST INFERRED ACTIVITY" : "LATEST AVAILABLE ACTIVITY"}</p>
        <p className="current-action">{agent.currentAction}</p>
        <p className="state-explanation">{stateDescriptions[agent.state]}</p>
        {agent.attentionReason ? <p className="attention-reason"><span>Attention</span>{agent.attentionReason}</p> : null}
      </section>

      <details className="inspector-disclosure">
        <summary>
          <span className="section-label">TRACE CONTEXT</span>
          <span>6 fields</span>
        </summary>
        <dl className="trace-grid">
          <div><dt>Last evidence</dt><dd>{lastSeenLabel}</dd></div>
          <div><dt>Model</dt><dd>{agent.model ?? "Not reported"}</dd></div>
          <div><dt>Reasoning</dt><dd>{agent.reasoningEffort ?? "Not reported"}</dd></div>
          <div><dt>Tokens</dt><dd>{formatTokens(agent.tokenUsage)}</dd></div>
          <div><dt>Branch</dt><dd>{agent.branch ?? "Not reported"}</dd></div>
          <div><dt>Children</dt><dd>{agent.childCount}</dd></div>
        </dl>
      </details>

      <details className="inspector-disclosure inspector-disclosure--events">
        <summary>
          <span className="section-label">EVENT TRAIL</span>
          <span>{visibleEvents.length} recorded</span>
        </summary>
        {visibleEvents.length > 0 ? (
          <ol className="inspector-events">
            {visibleEvents.map((event) => <EventRow key={event.id} event={event} />)}
          </ol>
        ) : (
          <p className="events-empty">No events exist at this replay position.</p>
        )}
      </details>

      <p className="inspector-footnote">Evidence is redacted at the data boundary. Message bodies and tool payloads are never rendered here.</p>
    </dialog>
  );
}
