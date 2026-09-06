import type { AgentEvent, AgentSnapshot, EvidenceStrength } from "./contracts";

/** The small, privacy-safe proof model rendered by the Evidence lens. */
export interface CurrentStateEvidence {
  strength: EvidenceStrength;
  latestEvent: AgentEvent | null;
  boundedEventCount: number;
}

function eventTime(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareLatest(left: AgentEvent, right: AgentEvent): number {
  const leftTime = eventTime(left.timestamp) ?? Number.NEGATIVE_INFINITY;
  const rightTime = eventTime(right.timestamp) ?? Number.NEGATIVE_INFINITY;
  return rightTime - leftTime
    || right.id.localeCompare(left.id)
    || right.kind.localeCompare(left.kind)
    || right.label.localeCompare(left.label);
}

function safeEvent(event: AgentEvent): AgentEvent {
  const bounded: AgentEvent = {
    id: event.id,
    agentId: event.agentId,
    timestamp: event.timestamp,
    kind: event.kind,
    label: event.label,
    state: event.state,
    source: event.source,
    evidence: event.evidence,
  };
  if (event.durationMs !== undefined) bounded.durationMs = event.durationMs;
  if (event.status !== undefined) bounded.status = event.status;
  return bounded;
}

/**
 * Select only evidence visible at the replay cutoff. Future events are never
 * eligible, and equal timestamps use stable event metadata as a tie-breaker.
 */
export function selectLatestBoundedEvent(agent: AgentSnapshot, replayCutoff: number): AgentEvent | null {
  const cutoff = Number.isFinite(replayCutoff) ? replayCutoff : Number.POSITIVE_INFINITY;
  const latest = agent.events
    .filter((event) => {
      const timestamp = eventTime(event.timestamp);
      return timestamp !== null && timestamp <= cutoff;
    })
    .sort(compareLatest)[0] ?? null;
  return latest ? safeEvent(latest) : null;
}

/**
 * Resolve the evidence supporting an agent's state at a replay position.
 * Agent-level metadata is deliberately not promoted when no bounded event is
 * available, so an unobserved state remains Unknown rather than overstated.
 */
export function evidenceForCurrentState(agent: AgentSnapshot, replayCutoff: number): CurrentStateEvidence {
  const cutoff = Number.isFinite(replayCutoff) ? replayCutoff : Number.POSITIVE_INFINITY;
  const boundedEvents = agent.events.filter((event) => {
    const timestamp = eventTime(event.timestamp);
    return timestamp !== null && timestamp <= cutoff;
  });
  const latest = [...boundedEvents].sort(compareLatest)[0] ?? null;
  return {
    strength: latest?.evidence ?? "unknown",
    latestEvent: latest ? safeEvent(latest) : null,
    boundedEventCount: boundedEvents.length,
  };
}
