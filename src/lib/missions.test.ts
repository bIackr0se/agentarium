import { describe, expect, it } from "vitest";

import type { AgentEvent, AgentSnapshot, ProjectSnapshot, WorldSnapshot } from "./contracts";
import {
  agentObservedAtCutoff,
  buildMissionWorld,
  missionForTask,
  MISSION_PHASE_LABELS,
  MISSION_PHASE_TRAIL,
  projectSnapshotAtCutoff,
} from "./missions";

const DAY_START = Date.parse("2026-08-30T00:00:00.000Z");
const CUTOFF = Date.parse("2026-08-30T12:00:00.000Z");
const DAY_END = Date.parse("2026-08-31T00:00:00.000Z");

function event(
  id: string,
  minutes: number,
  state: AgentEvent["state"],
  overrides: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    id,
    agentId: "root",
    timestamp: new Date(DAY_START + minutes * 60_000).toISOString(),
    kind: "turn",
    label: id,
    state,
    source: "fixture",
    evidence: "observed",
    ...overrides,
  };
}

const template: AgentSnapshot = {
  id: "template",
  title: "Template",
  projectId: "alpha",
  projectName: "Alpha",
  state: "idle",
  evidence: "observed",
  lastSeen: new Date(CUTOFF).toISOString(),
  ageMs: 0,
  currentAction: "Idle",
  childCount: 0,
  events: [],
};

function agent(overrides: Partial<AgentSnapshot> & Pick<AgentSnapshot, "id">): AgentSnapshot {
  return { ...template, ...overrides };
}

function project(id: string, name: string): ProjectSnapshot {
  return {
    id,
    name,
    color: "#57d7d2",
    agentIds: [],
    activeCount: 0,
    attentionCount: 0,
  };
}

function snapshot(agents: AgentSnapshot[], projects: ProjectSnapshot[] = [project("alpha", "Alpha")]): WorldSnapshot {
  return {
    schemaVersion: 1,
    mode: "demo",
    generatedAt: new Date(CUTOFF).toISOString(),
    sourceFreshness: new Date(CUTOFF).toISOString(),
    projects,
    agents,
    attention: agents.filter((item) => item.state === "needs-you").map((item) => item.id),
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: [],
  };
}

function dailyOptions() {
  return { dailyWindow: { start: DAY_START, end: DAY_END, timeZone: "UTC" } };
}

describe("mission model", () => {
  it("keeps replay selection limited to agents observed by the cutoff", () => {
    const observed = agent({ id: "observed", lastSeen: new Date(CUTOFF).toISOString() });
    const future = agent({ id: "future", lastSeen: new Date(CUTOFF + 1).toISOString() });

    expect(agentObservedAtCutoff(observed, CUTOFF)).toBe(true);
    expect(agentObservedAtCutoff(future, CUTOFF)).toBe(false);
    expect(agentObservedAtCutoff({ ...observed, lastSeen: "invalid" }, CUTOFF)).toBe(false);
  });

  it("creates exactly one project-scoped mission per hierarchy root and preserves duplicate root IDs", () => {
    const agents = [
      agent({ id: "shared-root", title: "Alpha rollout", projectId: "alpha", events: [event("alpha-start", 30, "thinking")] }),
      agent({ id: "shared-child", title: "Alpha helper", projectId: "alpha", parentAgentId: "shared-root", events: [event("alpha-child", 40, "running")], state: "running" }),
      agent({ id: "shared-root", title: "Beta rollout", projectId: "beta", projectName: "Beta", events: [event("beta-start", 30, "thinking")], state: "thinking" }),
    ];
    // A provider should not duplicate IDs, but project scope must remain the
    // model's identity boundary even when a malformed fixture does.
    const world = buildMissionWorld(snapshot(agents, [project("alpha", "Alpha"), project("beta", "Beta")]), CUTOFF, dailyOptions());

    expect(world.missionCount).toBe(2);
    expect(new Set(world.missions.map((mission) => mission.id)).size).toBe(2);
    expect(world.missions.map((mission) => mission.id)).toEqual(["alpha::shared-root", "beta::shared-root"]);
    expect(missionForTask(world, "alpha", "shared-root")?.displayName).toBe("Alpha rollout");
    expect(missionForTask(world, "beta", "shared-root")?.displayName).toBe("Beta rollout");
    expect(missionForTask(world, "missing", "shared-root")).toBeNull();
  });

  it("keeps hierarchy fallbacks and canonical project names in the mission ledger", () => {
    const root = agent({
      id: "generic-root",
      title: "Untitled task · deadbeef",
      projectName: "Stale member label",
      state: "running",
      events: [event("started", 20, "running")],
    });
    const world = buildMissionWorld(snapshot([root], [project("alpha", "Canonical Project")]), CUTOFF, dailyOptions());
    const mission = world.missions[0];
    expect(mission?.displayName).toBe("Unresolved task · ric-root");
    expect(mission?.displayName).not.toMatch(/Untitled task|deadbeef/);
    expect(mission?.projectName).toBe("Canonical Project");
  });

  it("does not promote a child completion, and keeps missing parents unresolved", () => {
    const child = agent({
      id: "orphan-child",
      title: "Child result",
      parentAgentId: "outside-root",
      state: "complete",
      events: [event("child-complete", 60, "complete", { status: "completed", kind: "verification" })],
    });
    const world = buildMissionWorld(snapshot([child]), CUTOFF, dailyOptions());
    const mission = world.missions[0];

    expect(mission.taskId).toBe("outside-root");
    expect(mission.rootAgentId).toBeUndefined();
    expect(mission.phase).not.toBe("complete");
    expect(mission.evolution).toEqual({ verified: false, districtLit: false, rootHomeLit: false, bridgeOpen: false });
    expect(world.dailySummary.completions).toBe(0);
  });

  it("keeps a generic waiting agent separate from an explicit human gate", () => {
    const root = agent({
      id: "gate-root",
      title: "Release mission",
      state: "running",
      events: [event("root-running", 20, "running")],
    });
    const waiting = agent({
      id: "wait-child",
      title: "Dependency worker",
      parentAgentId: root.id,
      state: "waiting",
      events: [event("wait", 25, "waiting", { agentId: "wait-child", kind: "message" })],
      attentionReason: "Waiting on another agent",
    });
    const waitingWorld = buildMissionWorld(snapshot([root, waiting]), CUTOFF, dailyOptions());
    const waitingMission = waitingWorld.missions[0];
    expect(waitingMission.phase).toBe("working");
    expect(waitingMission.decision).toBeNull();
    expect(waitingMission.requiresHumanDecision).toBe(false);

    const gate = agent({
      id: "gate-child",
      title: "Decision worker",
      parentAgentId: root.id,
      state: "needs-you",
      evidence: "observed",
      attentionReason: "Choose the release lane",
      events: [event("approval", 30, "needs-you", { agentId: "gate-child", kind: "approval", status: "inProgress", label: "Release lane approval" })],
    });
    const gateWorld = buildMissionWorld(snapshot([root, gate]), CUTOFF, dailyOptions());
    const gateMission = gateWorld.missions[0];
    expect(gateMission.phase).toBe("waiting-for-you");
    expect(gateMission.decision).toMatchObject({
      kind: "approval",
      reason: "Choose the release lane",
      agentId: "gate-child",
      evidence: "observed",
    });
    expect(gateMission.decision?.event?.label).toBe("Release lane approval");
  });

  it("does not keep a historical approval open after a newer bounded lifecycle state", () => {
    const root = agent({
      id: "resolved-gate",
      title: "Resolved gate mission",
      state: "running",
      events: [
        event("old-approval", 10, "needs-you", { kind: "approval", status: "inProgress" }),
        event("resumed", 20, "running", { status: "inProgress" }),
      ],
      lastSeen: new Date(DAY_START + 30 * 60_000).toISOString(),
    });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];
    expect(mission?.phase).toBe("working");
    expect(mission?.decision).toBeNull();
  });

  it("uses explicit phase precedence and suppresses completion after a later active or gate member", () => {
    const root = agent({
      id: "phase-root",
      title: "Phase mission",
      state: "complete",
      events: [
        event("planning", 10, "thinking"),
        event("verify", 20, "verifying", { kind: "verification" }),
        event("done", 30, "complete", { kind: "verification", status: "completed", label: "Mission verified" }),
      ],
    });
    const child = agent({
      id: "phase-child",
      title: "Active helper",
      parentAgentId: root.id,
      state: "running",
      events: [event("child-running", 40, "running", { agentId: "phase-child" })],
    });
    let world = buildMissionWorld(snapshot([root, child]), CUTOFF, dailyOptions());
    expect(world.missions[0]?.phase).toBe("working");
    expect(world.missions[0]?.evolution.verified).toBe(false);

    const gate = agent({
      id: "phase-gate",
      title: "Approval helper",
      parentAgentId: root.id,
      state: "needs-you",
      attentionReason: "Confirm the verified result",
      events: [event("phase-approval", 50, "needs-you", { agentId: "phase-gate", kind: "approval", status: "inProgress" })],
    });
    world = buildMissionWorld(snapshot([root, gate]), CUTOFF, dailyOptions());
    expect(world.missions[0]?.phase).toBe("waiting-for-you");
    expect(world.missions[0]?.evolution.bridgeOpen).toBe(false);
  });

  it("lights the district only for an observed root completion with no active, gate, or wait members", () => {
    const root = agent({
      id: "complete-root",
      title: "Completed mission",
      state: "complete",
      events: [event("root-complete", 90, "complete", { kind: "verification", status: "completed", label: "Root mission complete" })],
    });
    const child = agent({
      id: "complete-child",
      title: "Finished helper",
      parentAgentId: root.id,
      state: "complete",
      events: [event("child-complete", 80, "complete", { agentId: "complete-child", kind: "verification", status: "completed" })],
    });
    const world = buildMissionWorld(snapshot([root, child]), CUTOFF, dailyOptions());
    const mission = world.missions[0];

    expect(mission.phase).toBe("complete");
    expect(mission.phaseLabel).toBe(MISSION_PHASE_LABELS.complete);
    expect(mission.rootCompletionAt).toBe(new Date(DAY_START + 90 * 60_000).toISOString());
    expect(mission.evolution).toEqual({ verified: true, districtLit: true, rootHomeLit: true, bridgeOpen: true });
    expect(mission.observedPhases).toEqual(["verification", "complete"]);
    expect(mission.phaseTrail.map((step) => step.phase)).toEqual([...MISSION_PHASE_TRAIL]);
    expect(mission.phaseTrail.map((step) => step.status)).toEqual(["upcoming", "upcoming", "complete", "upcoming", "current"]);
    expect(mission.phaseTrail.at(-1)?.status).toBe("current");
  });

  it("lets a root completion supersede older helper activity but not a later failure", () => {
    const root = agent({
      id: "ordered-root",
      title: "Ordered completion",
      state: "complete",
      lastSeen: new Date(DAY_START + 90 * 60_000).toISOString(),
      events: [event("root-complete", 90, "complete", { kind: "verification", status: "completed" })],
    });
    const helper = agent({
      id: "ordered-helper",
      title: "Ordered helper",
      parentAgentId: root.id,
      state: "running",
      lastSeen: new Date(DAY_START + 80 * 60_000).toISOString(),
      events: [event("helper-running", 80, "running", { agentId: "ordered-helper" })],
    });

    let mission = buildMissionWorld(snapshot([root, helper]), CUTOFF, dailyOptions()).missions[0];
    expect(mission?.phase).toBe("complete");
    expect(mission?.evolution.districtLit).toBe(true);

    const laterFailure = agent({
      ...helper,
      state: "failed",
      lastSeen: new Date(DAY_START + 100 * 60_000).toISOString(),
      events: [event("helper-failed", 100, "failed", { agentId: "ordered-helper", status: "failed" })],
    });
    mission = buildMissionWorld(snapshot([root, laterFailure]), CUTOFF, dailyOptions()).missions[0];
    expect(mission?.phase).toBe("failed");
    expect(mission?.evolution.districtLit).toBe(false);
  });

  it("labels a current idle root as no active run instead of unknown", () => {
    const root = agent({
      id: "idle-root",
      title: "Paused mission",
      state: "idle",
      lastSeen: new Date(CUTOFF).toISOString(),
      events: [],
    });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];
    expect(mission?.phase).toBe("idle");
    expect(mission?.phaseLabel).toBe("No active run");
    expect(mission?.evolution.districtLit).toBe(false);
  });

  it("uses evidence from the newest effective lifecycle state", () => {
    const root = agent({
      id: "evidence-root",
      title: "Evidence mission",
      state: "running",
      evidence: "observed",
      lastSeen: new Date(DAY_START + 40 * 60_000).toISOString(),
      events: [event("older-derived", 20, "thinking", { evidence: "derived" })],
    });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];
    expect(mission?.phase).toBe("working");
    expect(mission?.evidence.strength).toBe("observed");
  });

  it("projects map and inspector metadata onto the replay cutoff", () => {
    const completionAt = DAY_START + 60 * 60_000;
    const root = agent({
      id: "replay-root",
      title: "Replay mission",
      state: "complete",
      evidence: "observed",
      lastSeen: new Date(completionAt).toISOString(),
      currentAction: "Future completion action",
      model: "future-model",
      branch: "future/branch",
      tokenUsage: 99,
      events: [
        event("replay-start", 20, "thinking", { label: "Planning recorded" }),
        event("replay-complete", 60, "complete", { kind: "verification", status: "completed", label: "Completion recorded" }),
      ],
    });
    const before = projectSnapshotAtCutoff(snapshot([root]), DAY_START + 30 * 60_000);
    const beforeAgent = before.agents[0];
    expect(beforeAgent).toMatchObject({
      state: "thinking",
      evidence: "observed",
      currentAction: "Planning recorded",
      lastSeen: new Date(DAY_START + 20 * 60_000).toISOString(),
    });
    expect(beforeAgent?.events.map((item) => item.id)).toEqual(["replay-start"]);
    expect(beforeAgent).not.toHaveProperty("model");
    expect(beforeAgent).not.toHaveProperty("branch");
    expect(beforeAgent).not.toHaveProperty("tokenUsage");

    const after = projectSnapshotAtCutoff(snapshot([root]), completionAt);
    expect(after.agents[0]).toMatchObject({ state: "complete", currentAction: "Future completion action" });
    expect(after.agents[0]?.events.map((item) => item.id)).toEqual(["replay-start", "replay-complete"]);
  });

  it("preserves provider attention live and derives it only for historical replay", () => {
    const root = agent({
      id: "attention-root",
      title: "Attention contract mission",
      state: "complete",
      lastSeen: new Date(DAY_START + 60 * 60_000).toISOString(),
      events: [
        event("historical-wait", 20, "waiting", { status: "inProgress" }),
        event("resolved", 60, "complete", { status: "completed" }),
      ],
    });
    const input = { ...snapshot([root]), attention: [] };

    const live = projectSnapshotAtCutoff(input, DAY_START + 60 * 60_000);
    expect(live.attention).toEqual([]);
    expect(live.projects[0]?.attentionCount).toBe(0);

    const replay = projectSnapshotAtCutoff(input, DAY_START + 30 * 60_000);
    expect(replay.attention).toEqual(["attention-root"]);
    expect(replay.projects[0]?.attentionCount).toBe(1);
  });

  it("marks a not-yet-observed replay agent without exposing its future timestamp", () => {
    const futureLastSeen = new Date(CUTOFF + 60_000).toISOString();
    const root = agent({
      id: "future-projection-root",
      title: "Future projection mission",
      state: "running",
      lastSeen: futureLastSeen,
      currentAction: "Future private lifecycle metadata",
      events: [],
    });
    const projected = projectSnapshotAtCutoff(snapshot([root]), CUTOFF).agents[0];

    expect(projected).toMatchObject({
      state: "unknown",
      evidence: "unknown",
      currentAction: "No activity recorded by this point",
      lastSeen: new Date(CUTOFF + 1).toISOString(),
    });
    expect(projected?.lastSeen).not.toBe(futureLastSeen);
  });

  it("excludes future events and state metadata from a replay cutoff, including daily outcomes", () => {
    const root = agent({
      id: "future-root",
      title: "Future mission",
      state: "complete",
      lastSeen: new Date(CUTOFF + 60_000).toISOString(),
      events: [event("future-complete", 13 * 60, "complete", { kind: "verification", status: "completed" })],
    });
    const world = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions());
    const mission = world.missions[0];

    expect(mission.phase).toBe("unknown");
    expect(mission.evolution.verified).toBe(false);
    expect(mission.evidence.latestEvent).toBeNull();
    expect(mission.lastActivityAt).toBeNull();
    expect(world.dailySummary.completions).toBe(0);
  });

  it("uses the bounded replay event reason instead of a later live attention reason", () => {
    const root = agent({
      id: "replay-gate-root",
      title: "Replay gate mission",
      state: "needs-you",
      evidence: "observed",
      lastSeen: new Date(CUTOFF + 60_000).toISOString(),
      attentionReason: "Later live reason that must stay hidden",
      events: [event("bounded-gate", 30, "needs-you", {
        kind: "approval",
        status: "inProgress",
        label: "Bounded approval requested",
      })],
    });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];

    expect(mission?.decision).toMatchObject({
      kind: "approval",
      reason: "Bounded approval requested",
    });
    expect(JSON.stringify(mission)).not.toContain("Later live reason");
  });

  it("counts boundary outcomes once, keeps the interval half-open, and reports bounded coverage", () => {
    const root = agent({
      id: "outcome-root",
      title: "Outcome mission",
      state: "failed",
      events: [
        event("failure", 30, "failed", { status: "failed" }),
        event("recovery", 40, "running", { status: "inProgress" }),
        event("completion", 50, "complete", { kind: "verification", status: "completed" }),
        event("intervention", 60, "needs-you", { kind: "approval", status: "inProgress" }),
        event("regression", 70, "failed", { status: "failed" }),
        event("at-end", 24 * 60, "complete", { kind: "verification", status: "completed" }),
        // Duplicate IDs are deduplicated by mission/event.
        event("completion", 50, "complete", { kind: "verification", status: "completed" }),
      ],
    });
    const world = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions());

    expect(world.dailySummary).toMatchObject({
      completions: 1,
      interventionSignals: 1,
      recoveries: 1,
      regressions: 1,
      coverage: "bounded-snapshot",
      windowStart: new Date(DAY_START).toISOString(),
      windowEnd: new Date(DAY_END).toISOString(),
      timeZone: "UTC",
    });
    expect(world.missions[0]?.phase).toBe("failed");
  });

  it("counts a reduced adapter's explicit needs-you state without treating generic wait as an intervention", () => {
    const root = agent({
      id: "reduced-root",
      title: "Reduced contract mission",
      state: "needs-you",
      events: [
        event("explicit-gate", 10, "needs-you", { state: "needs-you", status: "inProgress" }),
        event("generic-wait", 11, "waiting", { state: "waiting", status: "inProgress" }),
      ],
    });
    const world = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions());
    expect(world.dailySummary.interventionSignals).toBe(1);
    expect(world.missions[0]?.phase).toBe("waiting-for-you");
  });

  it("keeps mission output allowlisted when input events carry payload-like additions", () => {
    const unsafe = {
      ...event("safe-event", 20, "running"),
      payload: "private transcript /Users/example/.env",
      command: "cat /Users/example/.env",
    } as AgentEvent & { payload: string; command: string };
    const root = agent({ id: "safe-root", title: "Safe mission", state: "running", events: [unsafe] });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];
    expect(JSON.stringify(mission)).not.toContain("private transcript");
    expect(JSON.stringify(mission)).not.toContain("cat /Users/example");
    expect(mission?.evidence.latestEvent).toEqual(expect.objectContaining({ id: "safe-event", label: "safe-event" }));
    expect(mission?.evidence.latestEvent).not.toHaveProperty("payload");
  });

  it("redacts direct typed fixture paths and credential-shaped labels at the model boundary", () => {
    const root = agent({
      id: "private-root",
      title: "Review /Users/example/private project",
      projectName: "token=secret-value Private project",
      state: "running",
      events: [event("private-event", 20, "running", { label: "Read /Users/example/.env" })],
    });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];
    expect(JSON.stringify(mission)).not.toContain("/Users/example");
    expect(JSON.stringify(mission)).not.toContain("secret-value");
    expect(mission?.displayName).toContain("[redacted]");
  });

  it("marks no-event future/empty records unknown instead of inventing a phase", () => {
    const root = agent({
      id: "empty-root",
      title: "Empty mission",
      state: "running",
      lastSeen: new Date(CUTOFF + 1).toISOString(),
      events: [],
    });
    const mission = buildMissionWorld(snapshot([root]), CUTOFF, dailyOptions()).missions[0];
    expect(mission?.phase).toBe("unknown");
    expect(mission?.evidence).toMatchObject({ strength: "unknown", latestEvent: null, boundedEventCount: 0, freshness: "unknown" });
    expect(mission?.decision).toBeNull();
  });
});
