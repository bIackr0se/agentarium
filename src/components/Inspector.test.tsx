import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "../lib/contracts";
import { Inspector } from "./Inspector";

function agentFixture(): AgentSnapshot {
  return {
    id: "agent-inspector-test",
    nickname: "Ada",
    role: "reviewer",
    title: "Review release candidate",
    projectId: "project-test",
    projectName: "Release Readiness",
    state: "verifying",
    evidence: "observed",
    lastSeen: "2026-08-30T12:00:00.000Z",
    ageMs: 0,
    currentAction: "Checking the release candidate",
    childCount: 0,
    events: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Inspector modal", () => {
  it("does not label inferred activity as observed", () => {
    const agent = { ...agentFixture(), evidence: "derived" as const };
    render(<Inspector agent={agent} mode="live" replayCutoff={Date.parse(agent.lastSeen)} onClose={() => undefined} />);
    expect(screen.getByText("LATEST INFERRED ACTIVITY")).toBeInTheDocument();
    expect(screen.queryByText("LATEST OBSERVED ACTIVITY")).not.toBeInTheDocument();
  });

  it("uses a native modal dialog and restores focus after Escape", () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Open inspector";
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();

    render(<Inspector agent={agentFixture()} mode="demo" replayCutoff={Date.parse("2026-08-30T12:00:00.000Z")} onClose={onClose} />);

    const dialog = screen.getByTestId("inspector");
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Close agent inspector" })).toHaveFocus();

    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveAttribute("open");

    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("reports one close when the browser dispatches a delayed close event", () => {
    const onClose = vi.fn();
    render(<Inspector agent={agentFixture()} mode="demo" replayCutoff={Date.parse("2026-08-30T12:00:00.000Z")} onClose={onClose} />);

    const dialog = screen.getByTestId("inspector");
    fireEvent.click(screen.getByRole("button", { name: "Close agent inspector" }));
    fireEvent(dialog, new Event("close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders epoch-zero evidence at the replay boundary", () => {
    const epoch = new Date(0).toISOString();
    const later = new Date(1_000).toISOString();
    const agent = {
      ...agentFixture(),
      lastSeen: epoch,
      events: [
        {
          id: "epoch-inspector-event",
          agentId: "agent-inspector-test",
          timestamp: epoch,
          kind: "verification" as const,
          label: "Epoch inspector evidence",
          state: "verifying" as const,
          source: "test",
          evidence: "observed" as const,
        },
        {
          id: "later-inspector-event",
          agentId: "agent-inspector-test",
          timestamp: later,
          kind: "verification" as const,
          label: "Later inspector evidence",
          state: "verifying" as const,
          source: "test",
          evidence: "observed" as const,
        },
      ],
    };

    render(<Inspector agent={agent} mode="demo" replayCutoff={0} onClose={vi.fn()} />);

    expect(screen.getByText("Epoch inspector evidence")).toBeInTheDocument();
    expect(screen.queryByText("Later inspector evidence")).not.toBeInTheDocument();
    expect(screen.getByText("Last evidence").parentElement).not.toHaveTextContent("Unavailable at this replay point");
  });
});
