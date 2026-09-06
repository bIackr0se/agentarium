import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "./contracts";
import { evidenceForCurrentState, selectLatestBoundedEvent } from "./evidence";

function agent(events: AgentSnapshot["events"]): AgentSnapshot {
  return {
    id: "agent-1",
    title: "Evidence worker",
    projectId: "project-1",
    projectName: "Evidence project",
    state: "running",
    evidence: "observed",
    lastSeen: "2026-08-29T12:00:00.000Z",
    ageMs: 0,
    currentAction: "Working",
    childCount: 0,
    events,
  };
}

function event(id: string, timestamp: string, evidence: AgentSnapshot["evidence"], label = id) {
  return {
    id,
    agentId: "agent-1",
    timestamp,
    kind: "turn" as const,
    label,
    state: "running" as const,
    source: "fixture",
    evidence,
  };
}

describe("Evidence lens resolution", () => {
  it("selects the latest observed event at the cutoff", () => {
    const worker = agent([
      event("older", "2026-08-29T11:00:00.000Z", "observed"),
      event("newer", "2026-08-29T11:05:00.000Z", "observed"),
    ]);
    const result = evidenceForCurrentState(worker, Date.parse("2026-08-29T11:05:00.000Z"));
    expect(result.strength).toBe("observed");
    expect(result.latestEvent?.id).toBe("newer");
    expect(result.boundedEventCount).toBe(2);
  });

  it("keeps derived evidence derived and handles null events honestly", () => {
    const worker = agent([event("derived", "2026-08-29T11:05:00.000Z", "derived")]);
    expect(evidenceForCurrentState(worker, Date.parse("2026-08-29T11:06:00.000Z")).strength).toBe("derived");
    expect(evidenceForCurrentState(agent([]), Date.parse("2026-08-29T11:06:00.000Z"))).toEqual({
      strength: "unknown",
      latestEvent: null,
      boundedEventCount: 0,
    });
  });

  it("includes the exact boundary but excludes future and invalid timestamps", () => {
    const worker = agent([
      event("future", "2026-08-29T12:01:00.000Z", "observed"),
      event("boundary", "2026-08-29T12:00:00.000Z", "observed"),
      event("invalid", "not-a-time", "observed"),
    ]);
    const result = evidenceForCurrentState(worker, Date.parse("2026-08-29T12:00:00.000Z"));
    expect(result.latestEvent?.id).toBe("boundary");
    expect(result.boundedEventCount).toBe(1);
    expect(selectLatestBoundedEvent(worker, Date.parse("2026-08-29T11:59:59.999Z"))).toBeNull();
  });

  it("is deterministic for out-of-order and equal-time events", () => {
    const worker = agent([
      event("zulu", "2026-08-29T11:05:00.000Z", "derived"),
      event("alpha", "2026-08-29T11:05:00.000Z", "observed"),
      event("older", "2026-08-29T10:05:00.000Z", "observed"),
    ]);
    expect(selectLatestBoundedEvent(worker, Date.parse("2026-08-29T11:06:00.000Z"))?.id).toBe("zulu");
  });

  it("returns only bounded event fields, never payload-like additions", () => {
    const unsafe = { ...event("safe", "2026-08-29T11:05:00.000Z", "observed"), payload: "private message", command: "cat .env" };
    const result = selectLatestBoundedEvent(agent([unsafe]), Date.parse("2026-08-29T11:06:00.000Z"));
    expect(result?.label).toBe("safe");
    expect(JSON.stringify(result)).not.toContain("private message");
    expect(JSON.stringify(result)).not.toContain("cat .env");
  });
});
