import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { createDemoSnapshot } from "./App";
import type { ReactNode } from "react";
import type { AgentEvent, WorldSnapshot } from "./lib/contracts";
import { buildWorldHierarchy } from "./lib/hierarchy";
import { normalizeClientSnapshot } from "./lib/snapshot-contract";
import type { NavigationTarget } from "./lib/hierarchy";
import type { WorldEmptyState } from "./components/Archipelago";

vi.mock("./components/Archipelago", () => ({
  Archipelago: ({ snapshot, selectedId, onSelect, navigation, onNavigate, emptyState, visibleAgentIds, utilityControls }: { snapshot: WorldSnapshot; selectedId: string | null; onSelect: (id: string) => void; navigation: NavigationTarget; onNavigate: (target: NavigationTarget) => void; emptyState?: WorldEmptyState; visibleAgentIds?: readonly string[]; utilityControls?: ReactNode }) => {
    const hierarchy = buildWorldHierarchy(snapshot);
    const renderedIds = new Set(visibleAgentIds ?? snapshot.agents.map((agent) => agent.id));
    if (emptyState) {
      return (
        <div>
          <div className="world-commandbar__actions">{utilityControls}</div>
          <section role="region" aria-label={emptyState.title} data-empty-world={emptyState.kind}>
            <strong>{emptyState.title}</strong>
            <p>{emptyState.description}</p>
            {emptyState.detail ? <p>{emptyState.detail}</p> : null}
            {emptyState.connectionOptions?.map((option) => (
              <div key={option.label}>
                <strong>{option.label}</strong>
                <span>{option.description}</span>
                <code>{option.command}</code>
                {option.validationCommand ? <code>{option.validationCommand}</code> : null}
              </div>
            ))}
            {emptyState.connectionNote ? <p>{emptyState.connectionNote}</p> : null}
            {emptyState.primaryAction ? <button type="button" aria-label={emptyState.primaryAction.ariaLabel ?? emptyState.primaryAction.label} onClick={emptyState.primaryAction.onClick}>{emptyState.primaryAction.label}</button> : null}
            {emptyState.secondaryAction ? <button type="button" aria-label={emptyState.secondaryAction.ariaLabel ?? emptyState.secondaryAction.label} onClick={emptyState.secondaryAction.onClick}>{emptyState.secondaryAction.label}</button> : null}
          </section>
        </div>
      );
    }
    return (
    <div data-testid="archipelago-mock" data-zoom-level={navigation.level} data-project-id={navigation.level === "overview" ? "" : navigation.projectId} data-task-id={navigation.level === "task" ? navigation.taskId : ""}>
      <div className="world-commandbar__actions">{utilityControls}</div>
      <button type="button" onClick={() => onNavigate({ level: "task", projectId: "release-readiness", taskId: "release-verifier" })}>
        Navigate to test task
      </button>
      <button type="button" onClick={() => onNavigate({ level: "project", projectId: "release-readiness" })}>
        Navigate to test project
      </button>
      {snapshot.agents.filter((agent) => renderedIds.has(agent.id)).map((agent) => (
        <button
          key={agent.id}
          type="button"
          aria-label={`Inspect ${agent.title}`}
          aria-pressed={selectedId === agent.id}
          data-agent-state={agent.state}
          data-current-action={agent.currentAction}
          onClick={() => onSelect(agent.id)}
        >
          {agent.title}
        </button>
      ))}
      <div data-testid="task-index">
        {hierarchy.tasks.map((task) => <span key={task.id} data-testid={`task-${task.id}`}>{task.displayName}</span>)}
      </div>
    </div>
    );
  },
}));

function fixture(): WorldSnapshot {
  return createDemoSnapshot(new Date("2026-08-29T12:00:00.000Z"));
}

function epochSnapshot(): WorldSnapshot {
  const epoch = new Date(0).toISOString();
  const later = new Date(1_000).toISOString();
  return {
    schemaVersion: 1,
    mode: "demo",
    generatedAt: later,
    sourceFreshness: later,
    sourceLabel: "Demo fixture",
    projects: [{
      id: "epoch-project",
      name: "Epoch Project",
      color: "#7ee7d1",
      agentIds: ["epoch-agent"],
      activeCount: 1,
      attentionCount: 0,
    }],
    agents: [{
      id: "epoch-agent",
      title: "Epoch worker",
      projectId: "epoch-project",
      projectName: "Epoch Project",
      state: "running",
      evidence: "observed",
      lastSeen: later,
      ageMs: 0,
      currentAction: "Working from the epoch boundary",
      childCount: 0,
      events: [
        {
          id: "epoch-event",
          agentId: "epoch-agent",
          timestamp: epoch,
          kind: "verification",
          label: "Epoch evidence",
          state: "running",
          source: "test",
          evidence: "observed",
        },
        {
          id: "later-event",
          agentId: "epoch-agent",
          timestamp: later,
          kind: "verification",
          label: "Later evidence",
          state: "running",
          source: "test",
          evidence: "observed",
        },
      ],
    }],
    attention: [],
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: [],
  };
}

function namedAgentFixture(): WorldSnapshot {
  const world = fixture();
  return {
    ...world,
    agents: world.agents.map((agent) => agent.id === "product-interface-review" ? {
      ...agent,
      title: "Untitled task · deadbeef",
      nickname: "Ada",
      role: "cartographer",
      assignment: "Fresh public scan",
    } : agent),
  };
}

describe("Agentarium shell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("starts in the selected synthetic Demo world without probing private live state", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App />);
      expect(screen.getByRole("button", { name: "Use Demo source" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByText("Demo / read-only")).toBeInTheDocument();
      expect(screen.getByText("Fictional sample", { exact: true })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Connect" })).toHaveAttribute("aria-expanded", "false");
      expect(screen.getAllByText("Release Readiness").length).toBeGreaterThan(0);
      expect(screen.queryByText("Private Alpha")).not.toBeInTheDocument();
      expect(screen.queryByText("Private Gamma")).not.toBeInTheDocument();
      expect(screen.queryByText("Private Delta")).not.toBeInTheDocument();
      expect(screen.queryByText("Private live task")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens one provider-neutral connection guide from the primary toolbar", async () => {
    const user = userEvent.setup();
    render(<App />);

    const trigger = screen.getByRole("button", { name: "Connect" });
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Connect a local source" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Any harness · JSON" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Any harness · JSONL" })).toBeInTheDocument();
    expect(screen.getByText("npm run agentarium -- --provider codex")).toBeInTheDocument();
    expect(screen.getByText(/never sends prompts, commands, approvals, or payloads/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close connection guide" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Connect a local source" })).not.toBeInTheDocument();
  });

  it("keeps Demo mission-board provenance compact and names every root mission", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Mission board/ }));

    const board = screen.getByRole("region", { name: "Mission board · sample" });
    expect(board).toHaveAttribute("data-source-mode", "demo");
    expect(within(board).queryByText("FICTIONAL SAMPLE")).not.toBeInTheDocument();
    expect(within(board).getByText("Verify release candidate")).toBeInTheDocument();
    expect(within(board).getByText("Draft product update")).toBeInTheDocument();
    expect(within(board).getByText("Coordinate field research")).toBeInTheDocument();
    expect(within(board).getByText("Approve interface direction")).toBeInTheDocument();
    expect(within(board).getByText("Review current sources")).toBeInTheDocument();
    expect(within(board).getAllByRole("article")).toHaveLength(5);
    expect(within(board).getAllByRole("button")).toHaveLength(5);
    expect(screen.queryByRole("region", { name: "Current task queue" })).not.toBeInTheDocument();
  });

  it("keeps the utility dock closed until Missions or Replay is requested", () => {
    render(<App />);

    const dock = document.querySelector(".utility-dock") as HTMLElement;
    expect(dock).toHaveAttribute("data-utility-panel", "closed");
    expect(dock).toHaveAttribute("data-utility-placement", "navigation");
    expect(dock.closest(".primary-navigation")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "World utilities" })).toBeInTheDocument();
    expect(document.querySelector(".utility-dock__panel")).not.toBeInTheDocument();

    const missionLauncher = screen.getByRole("button", { name: /Mission board/ });
    fireEvent.click(missionLauncher);
    expect(dock).toHaveAttribute("data-utility-panel", "missions");
    expect(dock).toHaveAttribute("data-utility-placement", "overlay");
    expect(document.getElementById("mission-board-panel")).toHaveAttribute("role", "region");

    fireEvent.click(screen.getByRole("button", { name: "Close mission board" }));
    expect(dock).toHaveAttribute("data-utility-panel", "closed");
    expect(dock).toHaveAttribute("data-utility-placement", "navigation");
    expect(document.querySelector(".utility-dock__panel")).not.toBeInTheDocument();
    expect(missionLauncher).toHaveFocus();

    const replayLauncher = screen.getByRole("button", { name: "Replay" });
    fireEvent.click(replayLauncher);
    expect(dock).toHaveAttribute("data-utility-panel", "replay");
    expect(dock).toHaveAttribute("data-utility-placement", "overlay");
    expect(document.getElementById("replay-panel")).toHaveAttribute("role", "region");

    fireEvent.click(screen.getByRole("button", { name: "Close replay" }));
    expect(dock).toHaveAttribute("data-utility-panel", "closed");
    expect(dock).toHaveAttribute("data-utility-placement", "navigation");
    expect(replayLauncher).toHaveFocus();
  });

  it("closes an open utility with Escape and restores focus to its launcher", async () => {
    const user = userEvent.setup();
    render(<App />);

    const launcher = screen.getByRole("button", { name: /Mission board/ });
    expect(launcher).toHaveAttribute("aria-controls", "mission-board-panel");
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    await user.click(launcher);
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("mission-board-panel")).toHaveAttribute("role", "region");

    await user.keyboard("{Escape}");

    expect(document.getElementById("mission-board-panel")).not.toBeInTheDocument();
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    expect(launcher).toHaveFocus();
  });

  it("keeps Demo-only mission-board language out of an explicit Live snapshot", () => {
    render(<App initialSnapshot={{ ...fixture(), mode: "live", sourceLabel: "Live snapshot" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Mission board/ }));

    const board = screen.getByRole("region", { name: "Mission board" });
    expect(board).toHaveAttribute("data-source-mode", "live");
    expect(screen.queryByRole("region", { name: "Mission board · sample" })).not.toBeInTheDocument();
    expect(screen.queryByText("FICTIONAL SAMPLE")).not.toBeInTheDocument();
    expect(screen.queryByText("Demo project")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ships a fictional four-agent showcase without promoting a helper outcome into the queue", () => {
    const world = fixture();
    const hierarchy = buildWorldHierarchy(world);
    const showcase = hierarchy.tasks.find((task) => task.id === "release-verifier");

    expect(showcase?.agents).toHaveLength(4);
    expect(showcase?.outcomeCount).toBe(0);
    expect(Number.isFinite(Date.parse(world.sourceFreshness))).toBe(true);
    expect(world.attention).toEqual(["product-interface-review", "field-relay"]);
    expect(world.attention).not.toContain("release-probe");
    expect(world.projects.map(project => project.name)).toEqual([
      "Release Readiness", "Product Update", "Source Review", "Field Research",
    ]);
  });

  it("keeps the demo event shape aligned with the published contract", () => {
    const world = fixture();
    const eventKeys = new Set(["id", "agentId", "timestamp", "kind", "label", "state", "source", "evidence", "durationMs", "status"]);
    expect(world.agents.flatMap((agent) => agent.events).every((event) => Object.keys(event).every((key) => eventKeys.has(key)))).toBe(true);
    expect(JSON.stringify(world)).not.toContain('"detail"');
  });

  it("normalizes embedded snapshots before they reach the inspector", () => {
    const raw = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
    const agents = raw.agents as Array<Record<string, unknown>>;
    const events = agents[0].events as Array<Record<string, unknown>>;
    events[0].detail = "private transcript /Users/example/private";
    events[0].command = "cat /Users/example/private/.env";
    const normalized = normalizeClientSnapshot(raw);

    expect(normalized).not.toBeNull();
    expect("detail" in (normalized?.agents[0].events[0] ?? {})).toBe(false);
    expect("command" in (normalized?.agents[0].events[0] ?? {})).toBe(false);

    render(<App initialSnapshot={raw as unknown as WorldSnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Verify release candidate" }));
    expect(screen.queryByText("private transcript /Users/example/private")).not.toBeInTheDocument();
    expect(screen.queryByText("cat /Users/example/private/.env")).not.toBeInTheDocument();
  });

  it("redacts absolute paths after key delimiters at the browser boundary", () => {
    const world = fixture();
    const unsafe = {
      ...world,
      agents: world.agents.map((agent, index) => index === 0 ? {
        ...agent,
        title: "cwd=/Users/example/private",
        currentAction: "path:/home/example/secret",
        events: agent.events.map((event, eventIndex) => eventIndex === 0
          ? { ...event, label: "source=file:///private/tmp/data" }
          : event),
      } : agent),
    };

    const normalized = normalizeClientSnapshot(unsafe);
    expect(normalized).not.toBeNull();
    const wire = JSON.stringify(normalized);
    expect(wire).not.toContain("/Users/example/private");
    expect(wire).not.toContain("/home/example/secret");
    expect(wire).not.toContain("file:///private/tmp/data");
    expect(wire).toContain("[redacted]");
  });

  it("falls back to the synthetic scene for an invalid embedded snapshot", () => {
    const invalid = { ...fixture(), privacy: { rawContentExposed: true, redactionsApplied: 0 } } as unknown as WorldSnapshot;
    render(<App initialSnapshot={invalid} />);

    expect(screen.getByRole("button", { name: "Use Demo source" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Demo / read-only")).toBeInTheDocument();
    expect(screen.getAllByText("Release Readiness").length).toBeGreaterThan(0);
  });

  it("opens a valid project and task deep link without losing the semantic zoom target", () => {
    window.history.replaceState({}, "", "/?project=release-readiness&task=release-verifier");
    render(<App initialSnapshot={fixture()} />);

    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-project-id", "release-readiness");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-task-id", "release-verifier");
  });

  it("preserves a deep-linked task when a bounded live snapshot omits it", () => {
    window.history.replaceState({}, "", "/?project=release-readiness&task=temporarily-missing");
    render(<App initialSnapshot={fixture()} />);

    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-project-id", "release-readiness");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-task-id", "temporarily-missing");
    expect(window.location.search).toContain("task=temporarily-missing");
  });

  it("pushes semantic navigation and restores it on browser history changes", async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, "pushState");
    render(<App initialSnapshot={fixture()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Verify release candidate" }));
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Navigate to test task" }));
    expect(pushState).toHaveBeenCalled();
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");
    expect(window.location.search).toContain("task=release-verifier");

    await user.click(screen.getByRole("button", { name: "Inspect Verify release candidate" }));
    expect(screen.getByTestId("inspector")).toBeInTheDocument();

    act(() => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "overview"));
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
  });

  it("treats overview, project, and task as distinct navigation locations", () => {
    render(<App initialSnapshot={fixture()} />);

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test project" }));
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "project");

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test task" }));
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test project" }));
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "project");
  });

  it("keeps the document title aligned with the current map location", () => {
    render(<App initialSnapshot={fixture()} />);
    expect(document.title).toBe("Agentarium · Project map");

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test project" }));
    expect(document.title).toBe("Agentarium · Project view");

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test task" }));
    expect(document.title).toBe("Agentarium · Task village");
  });

  it("returns to the overview when the snapshot source changes", () => {
    render(<App initialSnapshot={fixture()} />);

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test task" }));
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");

    fireEvent.click(screen.getByRole("button", { name: "Use Demo source" }));
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "overview");
    expect(window.location.search).not.toContain("project=");
    expect(window.location.search).not.toContain("task=");
  });

  it("closes the inspector when navigating to another map level", () => {
    render(<App initialSnapshot={fixture()} />);

    fireEvent.click(screen.getByRole("button", { name: "Inspect Verify release candidate" }));
    expect(screen.getByTestId("inspector")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Navigate to test project" }));
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
  });

  it("uses nickname and role consistently in search, timeline, and inspector surfaces", () => {
    render(<App initialSnapshot={namedAgentFixture()} />);

    fireEvent.click(screen.getByRole("button", { name: "Inspect Untitled task · deadbeef" }));
    expect(screen.getByRole("dialog", { name: "Inspector for Agent Ada" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent Ada" })).toBeInTheDocument();
    expect(screen.getByText(/Role: cartographer · Fresh public scan · Product Update/)).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search agents, projects, or actions" });
    fireEvent.click(screen.getByRole("button", { name: "Close agent inspector" }));
    fireEvent.change(search, { target: { value: "Ada" } });
    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "cartographer" } });
    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "fresh public scan" } });
    expect(screen.getByLabelText("2 of 12 agents visible")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getAllByLabelText("Agent Ada in Product Update").length).toBeGreaterThan(0);
  });

  it("labels a nickname-only helper with its resolved root task in the mission filter context", () => {
    const world = fixture();
    const bohrWorld: WorldSnapshot = {
      ...world,
      mode: "live",
      sourceLabel: "Live snapshot",
      agents: world.agents.map((agent) => {
        if (agent.id === "release-verifier") {
          return { ...agent, title: "Compare sample apartment listings" };
        }
        if (agent.id === "release-probe") {
          return {
            ...agent,
            title: "Untitled task · b619eca9",
            nickname: "Bohr",
            role: "explorer",
            state: "waiting",
            attentionReason: "Waiting on another agent or external result",
          };
        }
        return { ...agent, state: "complete" };
      }),
      attention: ["release-probe"],
    };

    render(<App initialSnapshot={bohrWorld} />);
    fireEvent.click(screen.getByRole("button", { name: /Mission board/ }));

    const board = screen.getByRole("region", { name: "Mission board" });
    expect(board).toHaveTextContent("Compare sample apartment listings");
    expect(board).not.toHaveTextContent("Agent Bohr");
    expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), { target: { value: "Bohr" } });
    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
  });

  it("opens the evidence inspector directly from an agent", () => {
    render(<App initialSnapshot={fixture()} />);

    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect Verify release candidate" }));

    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open agent details" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Verify release candidate" })).toBeInTheDocument();
    expect(screen.getByText("Read-only view")).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText("Prompts and payloads are never displayed")).toBeInTheDocument();
    expect(screen.getAllByText("Observed").some((node) => node.classList.contains("evidence-badge--observed"))).toBe(true);
  });

  it("filters the world by attention, project, and search", () => {
    render(<App initialSnapshot={fixture()} />);

    fireEvent.click(screen.getByRole("button", { name: "Show agents needing attention" }));
    expect(screen.getByLabelText("2 of 12 agents visible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Approve interface direction" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Draft product update" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all agents" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by project" }), { target: { value: "product-update" } });
    expect(screen.getByLabelText("4 of 12 agents visible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Approve interface direction" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Verify release candidate" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), { target: { value: "editing the product update" } });
    expect(screen.getByRole("button", { name: "Inspect Draft product update" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Approve interface direction" })).not.toBeInTheDocument();
  });

  it("keeps every named mission visible when search matches only one helper", () => {
    render(<App initialSnapshot={fixture()} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), {
      target: { value: "weekly source snapshot" },
    });

    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
    expect(screen.getByTestId("task-source-scout")).toHaveTextContent("Review current sources");
    expect(screen.getByRole("button", { name: "Inspect Archive source snapshot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspect Review current sources" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Mission board/ }));
    const board = screen.getByRole("region", { name: "Mission board · sample" });
    expect(within(board).getAllByRole("article")).toHaveLength(5);
    expect(within(board).getByText("Review current sources")).toBeInTheDocument();
    expect(within(board).getByText("Verify release candidate")).toBeInTheDocument();
  });

  it("keeps the mission model unfiltered and refreshes mission phase and count from Live", async () => {
    const user = userEvent.setup();
    const initial = { ...fixture(), mode: "live" as const, sourceLabel: "Live snapshot" };
    const refreshed: WorldSnapshot = {
      ...initial,
      sourceFreshness: "2026-08-29T12:00:00.000Z",
      projects: initial.projects.filter((project) => project.id !== "source-review"),
      agents: initial.agents
        .filter((agent) => agent.projectId !== "source-review")
        .map((agent) => agent.id === "product-draft"
          ? { ...agent, state: "verifying" as const, currentAction: "Verifying the product update" }
          : agent),
      attention: initial.attention.filter((agentId) => initial.agents.find((agent) => agent.id === agentId)?.projectId !== "source-review"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => refreshed,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App initialSnapshot={initial} />);
      await user.click(screen.getByRole("button", { name: /Mission board/ }));

      let board = screen.getByRole("region", { name: "Mission board" });
      expect(board).toHaveTextContent("5 missions from recorded task evidence");
      expect(within(board).getByText("Review current sources")).toBeInTheDocument();

      await user.clear(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }));
      await user.type(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), "weekly source snapshot");
      expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
      board = screen.getByRole("region", { name: "Mission board" });
      expect(within(board).getAllByRole("article")).toHaveLength(5);
      expect(within(board).getByText("Review current sources")).toBeInTheDocument();

      await user.clear(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }));
      await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));

      await waitFor(() => expect(screen.getByRole("region", { name: "Mission board" })).toHaveTextContent("4 missions from recorded task evidence"));
      board = screen.getByRole("region", { name: "Mission board" });
      expect(within(board).getAllByRole("article")).toHaveLength(4);
      const productMission = within(board).getByText("Draft product update").closest("article");
      expect(productMission).not.toBeNull();
      expect(productMission).toHaveAttribute("data-mission-phase", "verification");
      expect(within(board).queryByText("Review current sources")).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/api/snapshot?mode=live", expect.objectContaining({ headers: { Accept: "application/json" } }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("freezes replay while a Live refresh arrives, then applies the latest snapshot on return", async () => {
    const user = userEvent.setup();
    const initial = { ...fixture(), mode: "live" as const, sourceLabel: "Live snapshot" };
    const refreshed: WorldSnapshot = {
      ...initial,
      sourceFreshness: "2026-08-29T12:01:00.000Z",
      agents: initial.agents.map((agent) => agent.id === "release-verifier"
        ? {
          ...agent,
          title: "Refreshed live task",
          state: "complete" as const,
          currentAction: "Live refresh completed the task",
          lastSeen: "2026-08-29T12:01:00.000Z",
        }
        : agent),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => refreshed,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App initialSnapshot={initial} />);
      await user.click(screen.getByRole("button", { name: "Replay" }));
      const slider = screen.getByRole("slider", { name: "Replay timeline" });
      const replayCutoff = Number((slider as HTMLInputElement).value) - 20 * 60_000;
      fireEvent.change(slider, { target: { value: String(replayCutoff) } });
      expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        "/api/snapshot?mode=live",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      ));

      expect(screen.getByRole("button", { name: "Inspect Verify release candidate" })).toHaveAttribute("data-agent-state", "thinking");
      expect(screen.queryByRole("button", { name: "Inspect Refreshed live task" })).not.toBeInTheDocument();
      expect(slider).toHaveValue(String(replayCutoff));

      await user.click(screen.getByRole("button", { name: "Return to live" }));
      expect(screen.getByText("Live", { selector: ".timeline-live" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Inspect Refreshed live task" })).toHaveAttribute("data-agent-state", "complete");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a live wait as a waiting-on-agent mission without treating old states as human work", () => {
    const world = fixture();
    const waitingId = "field-coordinator";
    const waitingOnly: WorldSnapshot = {
      ...world,
      mode: "live",
      sourceLabel: "Live snapshot",
      agents: world.agents.map((agent) => ({
        ...agent,
        state: agent.id === waitingId ? "waiting" : "complete",
        attentionReason: agent.id === waitingId ? "Waiting on another agent or external result" : undefined,
      })),
      attention: [waitingId],
    };
    render(<App initialSnapshot={waitingOnly} />);
    fireEvent.click(screen.getByRole("button", { name: /Mission board/ }));

    const board = screen.getByRole("region", { name: "Mission board" });
    expect(within(board).getByText("Waiting on agent")).toBeInTheDocument();
    const fieldMission = within(board).getByText("Coordinate field research").closest("article");
    expect(fieldMission).not.toBeNull();
    expect(within(fieldMission as HTMLElement).queryByText("Your move")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show agents needing attention" }));
    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
  });

  it("opens a mission requiring review and restores focus to the persistent Missions launcher", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);
    const missionLauncher = screen.getByRole("button", { name: /Mission board/ });
    await user.click(missionLauncher);

    const board = screen.getByRole("region", { name: "Mission board · sample" });
    const review = within(board).getByText("Approve interface direction").closest("article");
    expect(review).not.toBeNull();
    await user.click(within(review as HTMLElement).getByRole("button", { name: "Review in map Approve interface direction" }));

    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-project-id", "product-update");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-task-id", "product-interface-review");
    expect(screen.getByRole("button", { name: "Inspect Approve interface direction" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog", { name: "Inspector for Approve interface direction" })).toBeInTheDocument();
    expect(document.querySelector(".utility-dock")).toHaveAttribute("data-utility-panel", "closed");
    await user.click(screen.getByRole("button", { name: "Close agent inspector" }));
    expect(missionLauncher).toHaveFocus();
  });

  it("opens the owning task and restores focus when a replay decision agent is not selectable", async () => {
    const user = userEvent.setup();
    const world = fixture();
    const decisionAt = "2026-08-29T11:42:00.000Z";
    const notObservedUntil = "2026-08-29T11:42:01.000Z";
    const historicalDecision: WorldSnapshot = {
      ...world,
      agents: world.agents.map((agent) => agent.id === "product-interface-review"
        ? { ...agent, lastSeen: notObservedUntil, ageMs: 1_000 }
        : agent),
    };

    render(<App initialSnapshot={historicalDecision} />);
    await user.click(screen.getByRole("button", { name: "Replay" }));
    fireEvent.change(screen.getByRole("slider", { name: "Replay timeline" }), { target: { value: String(Date.parse(decisionAt)) } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), { target: { value: "Verify release" } });
    const missionLauncher = screen.getByRole("button", { name: /Mission board/ });
    await user.click(missionLauncher);

    const board = screen.getByRole("region", { name: "Mission board · sample" });
    const review = within(board).getByText("Approve interface direction").closest("article");
    expect(review).not.toBeNull();
    await user.click(within(review as HTMLElement).getByRole("button", { name: "Review in map Approve interface direction" }));

    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-project-id", "product-update");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-task-id", "product-interface-review");
    expect(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Inspect Approve interface direction" })).toHaveAttribute("aria-pressed", "false");
    expect(missionLauncher).toHaveFocus();
  });

  it("clears helper search, project, and queue filters before opening a hidden mission", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);

    await user.type(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), "weekly source snapshot");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by project" }), "source-review");
    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show agents needing attention" }));
    expect(screen.getByRole("region", { name: "No agents match this view" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Mission board/ }));
    const board = screen.getByRole("region", { name: "Mission board · sample" });
    const releaseMission = within(board).getByText("Verify release candidate").closest("article");
    expect(releaseMission).not.toBeNull();

    await user.click(within(releaseMission as HTMLElement).getByRole("button", { name: /Open mission/ }));

    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "task");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-project-id", "release-readiness");
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-task-id", "release-verifier");
    expect(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Filter by project" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Show agents needing attention" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("12 of 12 agents visible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Verify release candidate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mission board/ })).toHaveFocus();
  });

  it("collapses Refine view after each applied filter", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);
    const refine = document.querySelector(".advanced-filters") as HTMLDetailsElement;
    const summary = within(refine).getByText("Refine view").closest("summary") as HTMLElement;

    await user.click(summary);
    expect(refine).toHaveAttribute("open");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by project" }), "source-review");
    expect(refine).not.toHaveAttribute("open");

    await user.click(summary);
    await user.click(screen.getByRole("button", { name: "Show agents needing attention" }));
    expect(refine).not.toHaveAttribute("open");
  });

  it("does not replay a future-only event after filtering to its selected agent", () => {
    const cutoff = Date.parse("2026-08-29T12:00:00.000Z");
    const futureTimestamp = "2026-08-29T13:00:00.000Z";
    const futureEvent: AgentEvent = {
      id: "future-only-event",
      agentId: "release-probe",
      timestamp: futureTimestamp,
      kind: "verification",
      label: "Future-only event",
      state: "verifying",
      source: "demo",
      evidence: "observed",
      status: "inProgress",
    };
    const futureOnly: WorldSnapshot = {
      ...fixture(),
      agents: fixture().agents.map((agent) => agent.id === "release-probe"
        ? {
          ...agent,
          title: "Future-only agent",
          lastSeen: "2026-08-29T11:59:00.000Z",
          ageMs: 60_000,
          state: "idle" as const,
          currentAction: "No current activity before the replay cutoff",
          events: [futureEvent],
        }
        : agent),
    };

    render(<App initialSnapshot={futureOnly} />);
    fireEvent.click(screen.getByRole("button", { name: /Replay/ }));
    const slider = screen.getByRole("slider", { name: "Replay timeline" });
    fireEvent.change(slider, { target: { value: String(cutoff) } });
    expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), {
      target: { value: "Future-only agent" },
    });
    expect(screen.getByLabelText("1 of 12 agents visible")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Future-only agent" }));
    expect(screen.getByRole("button", { name: "Inspect Future-only agent" })).toHaveAttribute("aria-pressed", "true");
    expect(document.getElementById("replay-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Inspector for Future-only agent" })).toBeInTheDocument();
    expect(screen.queryByText("Future-only event")).not.toBeInTheDocument();
  });

  it("clears an agent selection when replay moves before that agent was observed", () => {
    const cutoff = Date.parse("2026-08-29T12:00:00.000Z");
    const futureEvent: AgentEvent = {
      id: "late-agent-start",
      agentId: "release-probe",
      timestamp: "2026-08-29T13:00:00.000Z",
      kind: "turn",
      label: "Late agent started",
      state: "running",
      source: "demo",
      evidence: "observed",
      status: "inProgress",
    };
    const lateAgent: WorldSnapshot = {
      ...fixture(),
      agents: fixture().agents.map((agent) => agent.id === "release-probe"
        ? {
          ...agent,
          title: "Late agent",
          lastSeen: futureEvent.timestamp,
          state: "running" as const,
          currentAction: futureEvent.label,
          events: [futureEvent],
        }
        : agent),
    };

    render(<App initialSnapshot={lateAgent} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Late agent" }));
    expect(screen.getByRole("button", { name: "Inspect Late agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close agent inspector" }));

    fireEvent.click(screen.getByRole("button", { name: /Replay/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Replay timeline" }), { target: { value: String(cutoff) } });

    expect(screen.getByRole("button", { name: "Inspect Late agent" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("button", { name: "Inspect Late agent" })).toHaveAttribute("aria-pressed", "false");
  });

  it("moves the replay cutoff and returns to live", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);
    await user.click(screen.getByRole("button", { name: /Replay/ }));
    const slider = screen.getByRole("slider", { name: "Replay timeline" });
    const originalValue = Number((slider as HTMLInputElement).value);
    fireEvent.change(slider, { target: { value: String(originalValue - 20 * 60_000) } });
    const replayedVerifier = screen.getByRole("button", { name: "Inspect Verify release candidate" });
    expect(replayedVerifier).toHaveAttribute("data-agent-state", "thinking");
    expect(replayedVerifier).toHaveAttribute("data-current-action", "Release check started");
    await user.click(replayedVerifier);
    expect(screen.getByText("Release check started", { selector: ".current-action" })).toBeInTheDocument();
    expect(screen.queryByText("Checking the release candidate", { selector: ".current-action" })).not.toBeInTheDocument();
    expect(document.getElementById("replay-panel")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close agent inspector" }));
    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Return to live" }));
    expect(screen.getByText("Live", { selector: ".timeline-live" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Verify release candidate" })).toHaveAttribute("data-agent-state", "verifying");
  });

  it("labels even a one-millisecond historical cutoff as replay", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);
    await user.click(screen.getByRole("button", { name: /Replay/ }));
    const slider = screen.getByRole("slider", { name: "Replay timeline" });
    const liveBoundary = Number((slider as HTMLInputElement).value);

    fireEvent.change(slider, { target: { value: String(liveBoundary - 1) } });

    expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exit replay" })).toBeInTheDocument();
  });

  it("keeps epoch-zero evidence inside the integrated replay bounds", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={epochSnapshot()} />);

    await user.click(screen.getByRole("button", { name: "Replay" }));
    const slider = screen.getByRole("slider", { name: "Replay timeline" });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "1000");

    fireEvent.change(slider, { target: { value: "0" } });

    expect(screen.getByRole("button", { name: "Return to live" })).toBeInTheDocument();
    expect(screen.getByText("Epoch evidence")).toBeInTheDocument();
    expect(screen.queryByText("Later evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("time unknown", { exact: false })).not.toBeInTheDocument();
  });

  it("supports keyboard agent selection and clearing", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Verify release candidate" }));
    await user.click(screen.getByRole("button", { name: "Close agent inspector" }));
    await user.keyboard("j");
    expect(screen.getByRole("button", { name: "Inspect Draft product update" })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Inspect Draft product update" })).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("/");
    expect(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" })).toHaveFocus();
  });

  it("keeps keyboard navigation from changing the selected agent behind the inspector", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={fixture()} />);

    const selectedAgent = screen.getByRole("button", { name: "Inspect Verify release candidate" });
    await user.click(selectedAgent);
    expect(screen.getByRole("dialog", { name: "Inspector for Verify release candidate" })).toBeInTheDocument();

    await user.keyboard("j");

    expect(selectedAgent).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog", { name: "Inspector for Verify release candidate" })).toBeInTheDocument();
  });

  it("keeps the synthetic world selected while an explicit Live request is pending", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const live = {
      ...fixture(),
      mode: "live" as const,
      agents: fixture().agents.map((agent) => agent.id === "release-verifier"
        ? { ...agent, title: "Private live task" }
        : agent),
    };
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Use live workspace source" }));

      expect(screen.getByRole("button", { name: "Use Demo source" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getAllByText("Verify release candidate").length).toBeGreaterThan(0);
      expect(screen.queryByText("Private live task")).not.toBeInTheDocument();

      resolveFetch?.({
        ok: true,
        json: async () => live,
      } as Response);
      await waitFor(() => expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "true"));
      expect(screen.getByRole("button", { name: "Inspect Private live task" })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back safely when the live observer cannot be reached", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Use live workspace source" }));

      await waitFor(() => expect(screen.getByText("Live source unavailable · safe demo active")).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledWith("/api/snapshot?mode=live", expect.objectContaining({ headers: { Accept: "application/json" } }));
      expect(screen.getByRole("button", { name: "Use Demo source" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByText("Demo / read-only")).toBeInTheDocument();
      expect(screen.queryByText("Private / read-only")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a valid live world visible when a later refresh fails", async () => {
    const live = {
      ...fixture(),
      mode: "live" as const,
      sourceLabel: "Live snapshot",
      agents: fixture().agents.map((agent) => agent.id === "release-verifier"
        ? { ...agent, title: "Persistent live task" }
        : agent),
    };
    const fetchMock = vi.fn().mockRejectedValue(new Error("transient offline"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<App initialSnapshot={live} />);
      fireEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));

      await waitFor(() => expect(screen.getByText("Live source unavailable")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Use Demo source" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: "Inspect Persistent live task" })).toBeInTheDocument();
      expect(screen.queryByText("Live source unavailable · safe demo active")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks a broken live event stream unavailable without replacing the live world", async () => {
    type Listener = (event: Event) => void;
    let stream: { emit: (type: string) => void } | null = null;
    class FakeEventSource {
      private listeners = new Map<string, Set<Listener>>();

      constructor(_url: string) {
        stream = this;
      }

      addEventListener(type: string, listener: Listener) {
        const listeners = this.listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: Listener) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string) {
        this.listeners.get(type)?.forEach((listener) => listener(new Event(type)));
      }

      close() {}
    }
    const live = {
      ...fixture(),
      mode: "live" as const,
      sourceLabel: "Live snapshot",
      agents: fixture().agents.map((agent) => agent.id === "release-verifier"
        ? { ...agent, title: "Stream-backed live task" }
        : agent),
    };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => live } as Response));
    try {
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "Use live workspace source" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Inspect Stream-backed live task" })).toBeInTheDocument());
      await waitFor(() => expect(stream).not.toBeNull());

      act(() => stream?.emit("error"));

      expect(screen.getByText("Live source unavailable")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Inspect Stream-backed live task" })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a fail-closed observer warning without inventing demo data", () => {
    const stopped: WorldSnapshot = {
      ...fixture(),
      mode: "live",
      sourceFreshness: "unknown",
      projects: [],
      agents: [],
      attention: [],
      warnings: ["Live data source stopped because its schema was not recognized."],
    };
    render(<App initialSnapshot={stopped} />);

    expect(screen.getByText("Source stopped safely")).toBeInTheDocument();
    expect(screen.getByText("Live data source stopped because its schema was not recognized.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Live source stopped safely" })).toHaveTextContent("Agentarium stopped before showing untrusted data");
    expect(screen.getByRole("button", { name: "Open demo world" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry live source" })).toBeInTheDocument();
    expect(screen.queryByText("Live source has no agents yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Agentarium is connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Every project, one living world")).not.toBeInTheDocument();
    expect(screen.queryByText("Open a project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mission board/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use live workspace source" })).toHaveAttribute("aria-pressed", "true");
  });

  it("gives an unconfigured Live source one clear recovery path instead of an empty map", async () => {
    const user = userEvent.setup();
    const unconfigured: WorldSnapshot = {
      ...fixture(),
      mode: "live",
      sourceFreshness: "unknown",
      projects: [],
      agents: [],
      attention: [],
      warnings: ["Snapshot source was not configured."],
    };
    render(<App initialSnapshot={unconfigured} />);

    const emptyScene = screen.getByRole("region", { name: "Connect a source" });
    expect(emptyScene).toHaveTextContent("Connect a local source to see your projects, tasks, and agents");
    expect(emptyScene).toHaveTextContent("restart it with one adapter below, return here, then select Live");
    expect(emptyScene).toHaveTextContent("npm run agentarium -- --provider codex");
    expect(emptyScene).toHaveTextContent("npm run agentarium -- --provider json --snapshot /absolute/path/world.json");
    expect(emptyScene).toHaveTextContent("npm run agentarium -- --provider jsonl --snapshot /absolute/path/world.jsonl");
    expect(emptyScene).toHaveTextContent("docs/world-snapshot.schema.json");
    expect(emptyScene).toHaveTextContent("npm run agentarium -- --validate /absolute/path/world.jsonl");
    expect(screen.getByText("Snapshot source was not configured.")).toBeInTheDocument();
    expect(screen.getByText("Live source not connected")).toBeInTheDocument();
    expect(screen.getByText("Prompts and payloads are never displayed")).toBeInTheDocument();
    expect(screen.queryByText("Open a project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mission board/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open demo world" }));
    expect(screen.getByRole("button", { name: "Use Demo source" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Release Readiness").length).toBeGreaterThan(0);
  });

  it("keeps a configured but quiet Live source distinct from setup and failure states", () => {
    const quiet: WorldSnapshot = {
      ...fixture(),
      mode: "live",
      projects: [],
      agents: [],
      attention: [],
      warnings: [],
    };
    render(<App initialSnapshot={quiet} />);

    const emptyScene = screen.getByRole("region", { name: "No active agents yet" });
    expect(emptyScene).toHaveTextContent("The live source is connected and currently reports zero agent records");
    expect(screen.getByText("Live local source")).toBeInTheDocument();
    expect(screen.getByText("Prompts and payloads are never displayed")).toBeInTheDocument();
    expect(screen.queryByText("Live source not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Source stopped safely")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mission board/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });

  it("does not call a starting Live observer ready", () => {
    const starting: WorldSnapshot = {
      ...fixture(),
      mode: "live",
      sourceFreshness: "unknown",
      projects: [],
      agents: [],
      attention: [],
      warnings: ["Codex observer is starting in an isolated worker."],
    };
    render(<App initialSnapshot={starting} />);

    const emptyScene = screen.getByRole("region", { name: "Live source is starting" });
    expect(emptyScene).toHaveAttribute("data-empty-world", "unavailable");
    expect(emptyScene).toHaveTextContent("The configured observer is still starting its isolated worker.");
    expect(emptyScene).toHaveTextContent("Codex observer is starting in an isolated worker.");
    expect(screen.getByText("Connecting to local source")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "No active agents yet" })).not.toBeInTheDocument();
    expect(screen.queryByText("Live local source")).not.toBeInTheDocument();
  });

  it("keeps record-level warnings separate from source failure", () => {
    render(<App initialSnapshot={{ ...fixture(), mode: "live", warnings: ["Some local lifecycle records were malformed and classified conservatively."] }} />);
    expect(screen.getByText("Live local source")).toBeInTheDocument();
    expect(screen.queryByText("Source stopped safely")).not.toBeInTheDocument();
  });

  it("classifies empty Live warnings by meaning instead of array order", () => {
    const cases: Array<{ warnings: string[]; title: string }> = [
      {
        warnings: ["Live snapshot unavailable.", "Snapshot source was not configured."],
        title: "Connect a source",
      },
      {
        warnings: ["Snapshot source was not configured.", "Live snapshot unavailable."],
        title: "Connect a source",
      },
      {
        warnings: ["Snapshot source is normalized and privacy-filtered.", "Live data source stopped because its schema was not recognized."],
        title: "Live source stopped safely",
      },
      {
        warnings: ["Live data source stopped because its schema was not recognized.", "Snapshot source is normalized and privacy-filtered."],
        title: "Live source stopped safely",
      },
      {
        warnings: ["Live snapshot unavailable."],
        title: "Live source unavailable",
      },
      {
        warnings: ["Project evidence is not ready for review."],
        title: "No active agents yet",
      },
    ];

    for (const item of cases) {
      const empty: WorldSnapshot = {
        ...fixture(),
        mode: "live",
        projects: [],
        agents: [],
        attention: [],
        warnings: item.warnings,
      };
      const view = render(<App initialSnapshot={empty} />);
      expect(screen.getByRole("region", { name: item.title })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("turns a zero-result filter into a resettable view while preserving Missions", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" }), "no-such-agent");

    expect(screen.getByRole("region", { name: "No agents match this view" })).toHaveTextContent("Clear the current search and filters");
    expect(screen.queryByText("Every project, one living world")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mission board/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear view" }));
    expect(screen.getByRole("searchbox", { name: "Search agents, projects, or actions" })).toHaveValue("");
    expect(screen.getAllByText("Release Readiness").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Mission board/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
  });

  it("clears a combined project and queue filter while keeping Missions canonical", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Mission board/ }));
    expect(document.getElementById("mission-board-panel")).toHaveAttribute("role", "region");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by project" }), "release-readiness");
    await user.click(screen.getByRole("button", { name: "Show agents needing attention" }));

    expect(screen.getByRole("region", { name: "No agents match this view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mission board/ })).toBeInTheDocument();
    expect(document.getElementById("mission-board-panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear view" }));
    expect(screen.getByRole("combobox", { name: "Filter by project" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Show agents needing attention" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("12 of 12 agents visible")).toBeInTheDocument();
    expect(screen.getByTestId("archipelago-mock")).toHaveAttribute("data-zoom-level", "overview");
    expect(screen.getByRole("button", { name: /Mission board/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
  });
});
