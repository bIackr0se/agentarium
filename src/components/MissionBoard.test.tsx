import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  MISSION_PHASE_LABELS,
  MISSION_PHASE_TRAIL,
  type Mission,
  type MissionWorld,
} from "../lib/missions";
import { MissionBoard } from "./MissionBoard";

const WINDOW_START = "2026-08-30T00:00:00.000Z";
const WINDOW_END = "2026-08-31T00:00:00.000Z";

function trail(phase: Mission["phase"]): Mission["phaseTrail"] {
  const current = MISSION_PHASE_TRAIL.indexOf(phase as (typeof MISSION_PHASE_TRAIL)[number]);
  return MISSION_PHASE_TRAIL.map((step, index) => ({
    phase: step,
    label: MISSION_PHASE_LABELS[step],
    status: current < 0 ? "blocked" : index < current ? "complete" : index === current ? "current" : "upcoming",
  }));
}

function mission(overrides: Partial<Mission> = {}): Mission {
  const phase = overrides.phase ?? "working";
  return {
    id: "project-release::task-release",
    projectId: "project-release",
    projectName: "Release Readiness",
    taskId: "task-release",
    displayName: "Verify release candidate",
    phase,
    phaseLabel: MISSION_PHASE_LABELS[phase],
    phaseIndex: MISSION_PHASE_TRAIL.indexOf(phase as (typeof MISSION_PHASE_TRAIL)[number]),
    observedPhases: phase === "working" ? ["planning", "working"] : phase === "complete" ? ["planning", "working", "verification", "complete"] : [],
    phaseTrail: trail(phase),
    agents: [],
    agentCount: 4,
    activeCount: 2,
    waitingCount: 1,
    needsYouCount: 0,
    failedCount: 0,
    interruptedCount: 0,
    completedAgentCount: 0,
    attentionCount: 0,
    evidence: {
      strength: "observed",
      latestEvent: {
        id: "event-release",
        agentId: "agent-release",
        timestamp: "2026-08-30T12:00:00.000Z",
        kind: "verification",
        label: "Verification suite running",
        state: "verifying",
        source: "demo",
        evidence: "observed",
      },
      latestEventAt: "2026-08-30T12:00:00.000Z",
      boundedEventCount: 1,
      freshness: "fresh",
    },
    decision: null,
    requiresHumanDecision: false,
    evolution: { verified: false, districtLit: false, rootHomeLit: false, bridgeOpen: false },
    rootCompletionAt: null,
    lastActivityAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

function world(overrides: Partial<MissionWorld> = {}): MissionWorld {
  const review = mission({
    id: "project-product::task-design",
    taskId: "task-design",
    projectId: "project-product",
    projectName: "Product Update",
    displayName: "Approve interface direction",
    phase: "waiting-for-you",
    phaseLabel: "Waiting for you",
    phaseIndex: 3,
    phaseTrail: trail("waiting-for-you"),
    agentCount: 2,
    activeCount: 0,
    waitingCount: 0,
    needsYouCount: 1,
    evidence: {
      strength: "derived",
      latestEvent: {
        id: "event-interface",
        agentId: "agent-interface",
        timestamp: "2026-08-30T11:00:00.000Z",
        kind: "approval",
        label: "Interface decision requested",
        state: "needs-you",
        source: "demo",
        evidence: "derived",
        status: "inProgress",
      },
      latestEventAt: "2026-08-30T11:00:00.000Z",
      boundedEventCount: 1,
      freshness: "aging",
    },
    decision: {
      kind: "approval",
      reason: "Choose an interface direction to continue",
      agentId: "agent-interface",
      agentName: "Agent Interface",
      evidence: "derived",
      event: null,
    },
    requiresHumanDecision: true,
  });
  const complete = mission({
    id: "project-research::task-field-note",
    taskId: "task-field-note",
    projectId: "project-research",
    projectName: "Field Research",
    displayName: "Publish field note",
    phase: "complete",
    phaseLabel: "Complete",
    phaseIndex: 4,
    phaseTrail: trail("complete"),
    agentCount: 3,
    activeCount: 0,
    waitingCount: 0,
    completedAgentCount: 3,
    evolution: { verified: true, districtLit: true, rootHomeLit: true, bridgeOpen: true },
  });
  return {
    replayCutoff: Date.parse("2026-08-30T12:00:00.000Z"),
    replayCutoffIso: "2026-08-30T12:00:00.000Z",
    sourceMode: "live",
    projects: [],
    missions: [mission(), review, complete],
    missionCount: 3,
    agentCount: 9,
    attentionCount: 1,
    dailySummary: {
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      timeZone: "Europe/Berlin",
      asOf: "2026-08-30T12:00:00.000Z",
      coverage: "bounded-snapshot",
      completions: 3,
      interventionSignals: 1,
      recoveries: 2,
      regressions: 0,
    },
    ...overrides,
  };
}

function renderBoard(input = world()) {
  const onNavigate = vi.fn();
  const onOpenAgent = vi.fn();
  const view = render(<MissionBoard world={input} onNavigate={onNavigate} onOpenAgent={onOpenAgent} />);
  return { ...view, onNavigate, onOpenAgent };
}

describe("MissionBoard", () => {
  it("renders every mission with project, phase, status, evidence, and the full five-step trail", () => {
    renderBoard();

    expect(screen.getByRole("region", { name: "Mission board" })).toBeInTheDocument();
    expect(screen.getByLabelText("3 missions, 1 needs you")).toHaveTextContent("1 needs you");
    expect(screen.getByText("Verify release candidate")).toBeInTheDocument();
    expect(screen.getByText("Approve interface direction")).toBeInTheDocument();
    expect(screen.getByText("Publish field note")).toBeInTheDocument();
    expect(screen.getByText(/Each mission is one root task and its helper agents\./)).toBeInTheDocument();
    expect(screen.getAllByText("Release Readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Waiting for you").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Complete").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Planning")).toHaveLength(3);
    expect(screen.getAllByText("Verification")).toHaveLength(3);
    expect(screen.getAllByText("Observed")).toHaveLength(2);
    expect(screen.getByText("Derived")).toBeInTheDocument();

    const release = screen.getByText("Verify release candidate").closest("article");
    const review = screen.getByText("Approve interface direction").closest("article");
    const complete = screen.getByText("Publish field note").closest("article");
    expect(release).not.toBeNull();
    expect(review).not.toBeNull();
    expect(complete).not.toBeNull();
    expect(release).toHaveTextContent("4 agents");
    expect(release).toHaveTextContent("2 active · 1 waiting");
    expect(review).toHaveTextContent("2 agents");
    expect(review).toHaveTextContent("1 needs you");
    expect(complete).toHaveTextContent("3 agents");
    expect(complete).toHaveTextContent("3 complete");
  });

  it("shows Your move only for an explicit decision and includes reason plus evidence", () => {
    renderBoard();

    const decision = screen.getByRole("region", { name: "Your move for Approve interface direction" });
    expect(decision).toHaveTextContent("Your move");
    expect(decision).toHaveTextContent("Choose an interface direction to continue");
    expect(decision).toHaveTextContent("Evidence: Derived");
    expect(decision).toHaveTextContent("Interface decision requested");
    expect(screen.getAllByText("Your move")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Your move for Verify release candidate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your move for Publish field note" })).not.toBeInTheDocument();
  });

  it("renders the local daily window and bounded recorded-evidence summary without fake scores", () => {
    renderBoard();

    const summary = screen.getByRole("complementary", { name: "Daily summary" });
    expect(summary).toHaveTextContent("Europe/Berlin");
    expect(summary).toHaveTextContent("completions");
    expect(summary).toHaveTextContent("intervention signals");
    expect(summary).toHaveTextContent("recoveries");
    expect(summary).toHaveTextContent("regressions");
    expect(summary).toHaveTextContent("Based on bounded recorded evidence");
    expect(summary).not.toHaveTextContent(/points|xp|score|streak/i);
    expect(summary.querySelector(".mission-summary__date")).toBeInTheDocument();
    expect(summary.querySelector(".mission-summary__range")).toBeInTheDocument();
    expect(summary).toHaveTextContent("Time zone: Europe/Berlin");
    expect(summary).toHaveAttribute("data-window-start", WINDOW_START);
    expect(summary).toHaveAttribute("data-window-end", WINDOW_END);
    expect(summary.querySelector(`time[datetime="${WINDOW_START}"]`)).toBeInTheDocument();
    expect(summary.querySelector(`time[datetime="${WINDOW_END}"]`)).toBeInTheDocument();
  });

  it("announces the state of each compact phase step", () => {
    renderBoard();

    const phaseTrail = screen.getByRole("list", { name: "Phase trail for Verify release candidate" });
    expect(within(phaseTrail).getByRole("listitem", { name: "Planning: completed" })).toHaveAttribute("data-phase-status", "complete");
    expect(within(phaseTrail).getByRole("listitem", { name: "Working: current phase" })).toHaveAttribute("aria-current", "step");
    expect(within(phaseTrail).getByRole("listitem", { name: "Verification: not reached" })).toHaveAttribute("data-phase-status", "upcoming");
    expect(within(phaseTrail).getByRole("listitem", { name: "Waiting for you: not reached" })).toHaveAttribute("title", "Waiting for you · not reached");
    expect(within(phaseTrail).getByText("Review")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps exactly one explicit action per mission row and navigates semantically", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderBoard();
    const rows = screen.getAllByRole("article");
    expect(rows).toHaveLength(3);
    rows.forEach((row) => expect(within(row).getAllByRole("button")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Open mission Verify release candidate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open mission Publish field note" })).toBeInTheDocument();
    await user.click(within(rows[0]).getByRole("button", { name: "Open mission Verify release candidate" }));
    expect(onNavigate).toHaveBeenCalledWith({ level: "task", projectId: "project-release", taskId: "task-release" });
  });

  it("keeps the human decision action keyboard reachable and opens the requested agent", async () => {
    const user = userEvent.setup();
    const { onOpenAgent } = renderBoard();
    const review = screen.getByRole("button", { name: "Review in map Approve interface direction" });
    review.focus();
    expect(review).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpenAgent).toHaveBeenCalledWith("agent-interface");
  });

  it("does not leak raw identifiers, paths, payloads, or question-mark placeholders", () => {
    const unsafe = mission({
      displayName: "Unnamed task · deadbeef?",
      evidence: { ...mission().evidence, latestEvent: { ...mission().evidence.latestEvent!, label: "payload={token: secret-value}" } },
      decision: {
        kind: "input",
        reason: "Review /Users/example/private/project",
        agentId: "agent-secret",
        agentName: "Agent Secret",
        evidence: "unknown",
        event: null,
      },
      requiresHumanDecision: true,
    });
    const input = world({ missions: [unsafe], missionCount: 1, attentionCount: 1 });
    renderBoard(input);

    const text = screen.getByRole("region", { name: "Mission board" }).textContent ?? "";
    expect(text).not.toContain("?");
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("token");
    expect(text).not.toContain("deadbeef");
  });

  it("marks Demo provenance at the board boundary without contaminating mission names", () => {
    renderBoard(world({ sourceMode: "demo" }));
    const board = screen.getByRole("region", { name: "Mission board · sample" });
    expect(board).toHaveAttribute("data-source-mode", "demo");
    expect(board).toHaveTextContent("Verify release candidate");
    expect(board).not.toHaveTextContent(/fictional projects|no live workspace data/i);
  });

  it("has a useful empty state when no missions are available", () => {
    renderBoard(world({ missions: [], missionCount: 0, attentionCount: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("No missions in this snapshot");
    expect(screen.getByRole("status")).toHaveTextContent("When a root task is recorded");
  });

  it("keeps waiting-on-agent and unknown distinct from Waiting for you and Planning", () => {
    const waiting = mission({
      phase: "waiting-on-agent",
      phaseLabel: "Waiting on agent",
      phaseIndex: -1,
      phaseTrail: trail("waiting-on-agent"),
    });
    const unknown = mission({
      id: "project-unknown::task-unknown",
      taskId: "task-unknown",
      displayName: "Unresolved source task",
      phase: "unknown",
      phaseLabel: "Unknown",
      phaseIndex: -1,
      phaseTrail: trail("unknown"),
    });
    renderBoard(world({ missions: [waiting, unknown], missionCount: 2, attentionCount: 0 }));
    expect(screen.getByText("Waiting on agent")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Your move")).not.toBeInTheDocument();
  });
});
