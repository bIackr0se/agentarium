/// <reference types="node" />
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentSnapshot } from "../lib/contracts";
import { Timeline } from "./Timeline";


function agentWithEvents(events: AgentEvent[]): AgentSnapshot {
  const lastSeen = events.at(-1)?.timestamp ?? new Date(0).toISOString();
  return {
    id: "timeline-agent",
    title: "Timeline worker",
    projectId: "timeline-project",
    projectName: "Timeline project",
    state: "running",
    evidence: "observed",
    lastSeen,
    ageMs: 0,
    currentAction: "Working",
    childCount: 0,
    events,
  };
}

function event(id: string, timestamp: string, label: string): AgentEvent {
  return {
    id,
    agentId: "timeline-agent",
    timestamp,
    kind: "verification",
    label,
    state: "running",
    source: "test",
    evidence: "observed",
  };
}

describe("Timeline replay boundary", () => {
  it("keeps a negative-first singleton timestamp live with no replay range", () => {
    const timestamp = new Date(-1_000).toISOString();
    const reset = vi.fn();

    render(
      <Timeline
        agents={[agentWithEvents([event("singleton", timestamp, "Singleton evidence")])]}
        replayCutoff={-1_000}
        replayBounds={{ min: -1_000, max: -1_000 }}
        onReplayCutoff={vi.fn()}
        onResetReplay={reset}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Replay timeline" });
    expect(slider).toHaveAttribute("min", "-1000");
    expect(slider).toHaveAttribute("max", "-1000");
    expect(slider).toBeDisabled();
    expect(screen.getByText("Live", { selector: ".timeline-live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Return to live" })).not.toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
  });

  it("offers replay only inside a normal multi-point range", () => {
    const first = new Date(1_000).toISOString();
    const second = new Date(2_000).toISOString();
    const third = new Date(3_000).toISOString();
    const onReplayCutoff = vi.fn();

    const { rerender } = render(
      <Timeline
        agents={[agentWithEvents([
          event("first", first, "First evidence"),
          event("second", second, "Second evidence"),
          event("third", third, "Third evidence"),
        ])]}
        replayCutoff={2_000}
        replayBounds={{ min: 1_000, max: 3_000 }}
        onReplayCutoff={onReplayCutoff}
        onResetReplay={vi.fn()}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Replay timeline" });
    expect(slider).not.toBeDisabled();
    expect(slider).toHaveAttribute("min", "1000");
    expect(slider).toHaveAttribute("max", "3000");
    expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();
    expect(screen.queryByText("Third evidence")).not.toBeInTheDocument();

    fireEvent.change(slider, { target: { value: "3000" } });
    expect(onReplayCutoff).toHaveBeenCalledWith(3_000);

    rerender(
      <Timeline
        agents={[agentWithEvents([
          event("first", first, "First evidence"),
          event("second", second, "Second evidence"),
          event("third", third, "Third evidence"),
        ])]}
        replayCutoff={3_000}
        replayBounds={{ min: 1_000, max: 3_000 }}
        onReplayCutoff={onReplayCutoff}
        onResetReplay={vi.fn()}
      />,
    );
    expect(screen.getByText("Live", { selector: ".timeline-live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Return to live" })).not.toBeInTheDocument();
    expect(screen.getByText("Third evidence")).toBeInTheDocument();
  });

  it("treats an epoch-zero cutoff as a real replay boundary", () => {
    render(
      <Timeline
        agents={[agentWithEvents([
          event("epoch", new Date(0).toISOString(), "Epoch evidence"),
          event("later", new Date(1_000).toISOString(), "Later evidence"),
        ])]}
        replayCutoff={0}
        replayBounds={{ min: 0, max: 1_000 }}
        onReplayCutoff={vi.fn()}
        onResetReplay={vi.fn()}
      />,
    );

    expect(screen.getByRole("slider", { name: "Replay timeline" })).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();
    expect(screen.getByText("Epoch evidence")).toBeInTheDocument();
    expect(screen.queryByText("Later evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("time unknown", { exact: false })).not.toBeInTheDocument();
  });

  it("keeps event identity and evidence as separate mobile row content", () => {
    const agent = agentWithEvents([{ ...event("identity", new Date(1_000).toISOString(), "A long evidence event label"), durationMs: 60_000 }]);
    agent.title = "A very long worker identity";
    agent.projectName = "A very long project identity";

    render(
      <Timeline
        agents={[agent]}
        replayCutoff={1_000}
        replayBounds={{ min: 1_000, max: 1_000 }}
        onReplayCutoff={vi.fn()}
        onResetReplay={vi.fn()}
      />,
    );

    const row = screen.getByRole("article");
    expect(row.querySelector(".timeline-event__label")).toHaveTextContent("A long evidence event label");
    expect(row.querySelector(".timeline-event__context")).toHaveAttribute(
      "aria-label",
      "A very long worker identity in A very long project identity",
    );
    expect(row.querySelector(".timeline-event__agent")).toHaveTextContent("A very long worker identity");
    expect(row.querySelector(".timeline-event__project")).toHaveTextContent("A very long project identity");
    expect(row.querySelector(".evidence-badge")).toHaveTextContent("Observed");
    expect(screen.getByLabelText("Duration 1m")).toHaveTextContent("1m");
    expect(row.querySelector("time")).not.toHaveTextContent("1m");
  });

});
