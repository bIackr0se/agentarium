import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createDemoSnapshot } from "../App";
import { buildWorldHierarchy, projectTarget, taskTarget } from "../lib/hierarchy";
import type { AgentSnapshot, WorldSnapshot } from "../lib/contracts";
import { buildMissionWorld } from "../lib/missions";
import { Archipelago, worldHour, worldTimePhase } from "./Archipelago";

function fixture(): WorldSnapshot {
  return createDemoSnapshot(new Date("2026-08-29T12:00:00.000Z"));
}

function groupedFixture(): WorldSnapshot {
  const snapshot = fixture();
  const root = snapshot.agents.find((agent) => agent.id === "release-verifier") as AgentSnapshot;
  const child = snapshot.agents.find((agent) => agent.id === "release-probe") as AgentSnapshot;
  return {
    ...snapshot,
    attention: snapshot.attention.filter((agentId) => agentId !== child.id),
    agents: snapshot.agents.map((agent) => agent.id === child.id
      ? { ...agent, title: "?", nickname: "Vela", role: "validator", state: "failed", parentAgentId: root.id }
      : agent.id === root.id
        ? { ...agent, nickname: "Ada", role: "lead" }
        : agent),
  };
}

function fourAgentFixture(): WorldSnapshot {
  const snapshot = groupedFixture();
  const crew = snapshot.agents
    .filter((agent) => agent.projectId === "release-readiness")
    .slice(0, 4);
  const root = crew.find((agent) => agent.id === "release-verifier") ?? crew[0];
  const states: AgentSnapshot["state"][] = ["verifying", "running", "waiting", "idle"];
  const agents = crew.map((agent, index) => ({
    ...agent,
    state: states[index] ?? "idle",
    parentAgentId: agent.id === root.id ? undefined : root.id,
  }));
  return {
    ...snapshot,
    projects: snapshot.projects
      .filter((project) => project.id === "release-readiness")
      .map((project) => ({ ...project, agentIds: agents.map((agent) => agent.id) })),
    agents,
    attention: [],
  };
}

function sevenAgentFixture(): WorldSnapshot {
  const snapshot = fourAgentFixture();
  const root = snapshot.agents.find((agent) => agent.id === "release-verifier")!;
  const extras: AgentSnapshot[] = ["observer", "scribe", "scout"].map((role, index) => ({
    ...root,
    id: `release-extra-${role}`,
    title: `Release ${role}`,
    role,
    state: "running",
    parentAgentId: root.id,
    childCount: 0,
    currentAction: `Running ${role} check`,
    ageMs: (index + 3) * 60_000,
    lastSeen: root.lastSeen,
    events: [],
  }));
  const agents = [...snapshot.agents, ...extras];
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => project.id === root.projectId
      ? { ...project, agentIds: agents.filter((agent) => agent.projectId === project.id).map((agent) => agent.id) }
      : project),
    agents,
  };
}

function expandedCrewFixture(agentCount: 5 | 6 | 7): WorldSnapshot {
  const snapshot = sevenAgentFixture();
  const agents = snapshot.agents.slice(0, agentCount);
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      agentIds: agents.filter((agent) => agent.projectId === project.id).map((agent) => agent.id),
    })),
    agents,
  };
}

function LensHarness({ snapshot, navigation, selectedId }: { snapshot: WorldSnapshot; navigation: ReturnType<typeof taskTarget>; selectedId?: string }) {
  const [lensOn, setLensOn] = useState(false);
  return (
    <Archipelago
      snapshot={snapshot}
      selectedId={selectedId}
      replayCutoff={Date.parse(snapshot.generatedAt)}
      navigation={navigation}
      onNavigate={() => undefined}
      onSelect={() => undefined}
      evidenceLensOn={lensOn}
      onEvidenceLensChange={setLensOn}
    />
  );
}

function SelectionHarness({ snapshot, navigation }: { snapshot: WorldSnapshot; navigation: ReturnType<typeof taskTarget> }) {
  const [selectedId, setSelectedId] = useState<string>();
  return (
    <Archipelago
      snapshot={snapshot}
      selectedId={selectedId}
      replayCutoff={Date.parse(snapshot.generatedAt)}
      navigation={navigation}
      onNavigate={() => undefined}
      onSelect={setSelectedId}
    />
  );
}

function openViewOptions() {
  const details = document.querySelector(".world-commandbar__options") as HTMLDetailsElement | null;
  const summary = details?.querySelector("summary");
  if (!summary) throw new Error("View options disclosure is missing its summary");
  fireEvent.click(summary);
}

describe("semantic agent world", () => {
  it("keeps secondary controls behind a native View options disclosure", async () => {
    const snapshot = fixture();
    render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const details = document.querySelector(".world-commandbar__options") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    const atlas = details.querySelector<HTMLButtonElement>('[aria-label="Open Atlas"]');
    expect(atlas).toBeInTheDocument();
    expect(atlas?.closest(".world-commandbar__options-body")).toBeInTheDocument();

    openViewOptions();
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Open Atlas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause agent movement" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open cinematic view" })).toBeInTheDocument();
  });

  it("states Demo through the source summary without adding a duplicate disclaimer", () => {
    const snapshot = fixture();
    const project = buildWorldHierarchy(snapshot).projects[0];
    const { container, rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const sourceStatus = container.querySelector(".world-commandbar__source") as HTMLElement;
    expect(sourceStatus).toHaveTextContent("Demo");
    expect(sourceStatus).toHaveAccessibleName(/Source status: Demo, \d+ agents?/i);
    expect(sourceStatus.closest(".world-commandbar__context")).toBeInTheDocument();
    expect(sourceStatus.closest(".world-commandbar__actions")).not.toBeInTheDocument();
    expect(container.querySelector("[data-demo-disclosure]")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample data only", { exact: true })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Project 0[1-4]/i, { exact: false }).length).toBeGreaterThan(0);

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(container.querySelector(".world-commandbar__source")).toHaveTextContent("Demo");
    expect(container.querySelector("[data-demo-disclosure]")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Task 0?1/i, { exact: false }).length).toBeGreaterThan(0);

    const task = project.tasks[0];
    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(container.querySelector(".world-commandbar__source")).toHaveTextContent("Demo");
    expect(container.querySelector("[data-demo-disclosure]")).not.toBeInTheDocument();
    openViewOptions();
    fireEvent.click(screen.getByRole("button", { name: "Open Atlas" }));
    expect(screen.getByText("Sample agents")).toBeInTheDocument();
  });

  it("does not add Demo or sample provenance labels to a Live map", () => {
    const snapshot = { ...fixture(), mode: "live" as const, sourceLabel: "Live snapshot" };
    const project = buildWorldHierarchy(snapshot).projects[0];
    const { rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(screen.queryByRole("note", { name: /Demo sample\. Fictional data/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo project/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo task/i)).not.toBeInTheDocument();

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, project.tasks[0].id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(screen.queryByText("Sample agents")).not.toBeInTheDocument();
  });

  it("shows every project and every root task as named controls in the overview", () => {
    const snapshot = fixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(document.querySelectorAll("[data-project-island][data-project-id]")).toHaveLength(hierarchy.projects.length);
    hierarchy.projects.forEach((project) => {
      expect(screen.getAllByText(project.displayName).length).toBeGreaterThan(0);

    });
    expect(screen.getByText("SUPERVISION MAP")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Project and task hierarchy" })).not.toBeInTheDocument();
    openViewOptions();
    fireEvent.click(screen.getByRole("button", { name: "Open Atlas" }));
    expect(screen.getByRole("navigation", { name: "Project and task hierarchy" })).toBeInTheDocument();
    hierarchy.projects.forEach(project => project.tasks.forEach(task => expect(screen.getAllByText(task.displayName).length).toBeGreaterThan(0)));
  });

  it("keeps project locations stable when replay changes their activity", () => {
    const snapshot = fixture();
    const props = { replayCutoff: Date.parse(snapshot.generatedAt), navigation: { level: "overview" as const }, onNavigate: () => undefined, onSelect: () => undefined };
    const { container, rerender } = render(<Archipelago {...props} snapshot={snapshot} />);
    const locations = () => Array.from(container.querySelectorAll('[data-project-island="true"]')).map(node => [node.getAttribute("data-project-id"), node.className]);
    const live = locations();
    rerender(<Archipelago {...props} snapshot={{ ...snapshot, agents: snapshot.agents.map(agent => ({ ...agent, state: "unknown" })) }} />);
    expect(locations()).toEqual(live);
  });

  it("anchors each overview island identity and action inside one readable plate", () => {
    const snapshot = fixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const realmMap = container.querySelector('.realm-map[data-project-count="4"]') as HTMLElement;
    expect(realmMap).toHaveAttribute("data-project-layout", "sculpted-landscape");
    expect(realmMap.querySelectorAll('[data-project-island="true"]')).toHaveLength(4);
    const islands = Array.from(container.querySelectorAll<HTMLElement>('[data-project-island="true"]'));
    expect(islands).toHaveLength(hierarchy.projects.length);
    islands.forEach((island) => {
      const project = hierarchy.projects.find((candidate) => candidate.project.id === island.dataset.projectId);
      const hitTarget = island.querySelector<HTMLElement>('[data-project-hit-target="true"]');
      const plate = island.querySelector<HTMLElement>('[data-project-info-plate="true"]');
      expect(hitTarget).toBeInTheDocument();
      expect(plate).toBeInTheDocument();
      expect(plate).toContainElement(plate?.querySelector(".project-card__identity") ?? null);
      expect(hitTarget).toHaveAccessibleName(`Open project ${project?.displayName}`);
      expect(island.querySelectorAll("[data-project-agent-state]").length).toBeGreaterThan(0);
      expect(island.querySelectorAll("[data-project-agent-state]").length).toBeLessThanOrEqual(3);
      expect(hitTarget).toBeEnabled();
    });
  });

  it("navigates from project to task without hiding any task cards", async () => {
    const user = userEvent.setup();
    const snapshot = fixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects[0];
    const onNavigate = vi.fn();
    const { rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={onNavigate}
        onSelect={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: `Open project ${project.displayName}` }));
    expect(onNavigate).toHaveBeenLastCalledWith(projectTarget(project.project.id));

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={projectTarget(project.project.id)}
        onNavigate={onNavigate}
        onSelect={() => undefined}
      />,
    );
    const stage = document.querySelector(".world-stage") as HTMLElement;
    expect(within(stage).getByRole("heading", { name: project.displayName })).toBeInTheDocument();
    expect(stage.querySelectorAll(".district-card[data-task-id]")).toHaveLength(project.tasks.length);
    expect(stage.querySelector('.district-card--working .island-route-carrier[data-route-state="commuting"]')).toBeInTheDocument();
    const projectMap = stage.querySelector(`.project-map[data-project-id="${project.project.id}"]`) as HTMLElement;
    expect(projectMap).toHaveAttribute("data-task-layout", project.tasks.length === 1 ? "single-hero" : "multi-grid");
    if (project.tasks.length === 1) {
      expect(projectMap.querySelector('[data-task-info-plate="true"]')).toBeInTheDocument();
      expect(projectMap.querySelector(".district-card__terrain-label--home")).toHaveTextContent("HOME BASE");
      expect(projectMap.querySelector(".district-card__workspot")).toHaveTextContent("WORK");
    }

    const task = project.tasks[0];
    await user.click(within(stage).getByRole("button", { name: `Open task ${task.displayName}` }));
    expect(onNavigate).toHaveBeenLastCalledWith(taskTarget(project.project.id, task.id));
  });

  it("renders a roomy named home and selectable villager for every agent in a root task", () => {
    const snapshot = groupedFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const onSelect = vi.fn();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        selectedId="release-verifier"
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={onSelect}
      />,
    );

    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toBeInTheDocument();
    expect(village).toHaveAttribute("data-agent-count", String(task.agents.length));
    expect(village.querySelectorAll(".agent-lot[data-agent-id]")).toHaveLength(task.agents.length);
    const homes = Array.from(village.querySelectorAll<HTMLImageElement>(".agent-lot__art"));
    expect(homes).toHaveLength(task.agents.length);
    expect(new Set(homes.map((home) => home.getAttribute("viewBox"))).size).toBeGreaterThan(1);
    expect(village.querySelectorAll("[data-agent-nameplate=\"true\"]")).toHaveLength(task.agents.length);
    expect(village.querySelectorAll(".agent-home__label")).toHaveLength(0);
    const contextStrip = container.querySelector('[data-task-context-strip="true"]') as HTMLElement;
    expect(contextStrip).toBeInTheDocument();
    expect(village).not.toContainElement(contextStrip);
    expect(contextStrip.querySelector('[data-selected-agent-card="true"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open agent details" })).not.toBeInTheDocument();
    expect(within(village).getByRole("button", { name: /Agent Ada, Verifying, role lead/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(village).getByRole("button", { name: /Agent Vela, Run failed, role validator/i })).toBeInTheDocument();
    expect(within(village).queryByText("Lead")).not.toBeInTheDocument();
    expect(within(village).queryByText("Helper")).not.toBeInTheDocument();
    expect(village.querySelector('[data-agent-state="failed"]')).toBeInTheDocument();
    expect(within(village).getByText(/working.*4 agents/i)).toBeInTheDocument();
    const child = snapshot.agents.find((agent) => agent.id === "release-probe")!;
    expect(village.querySelector(`[data-agent-id="${child.id}"]`)).not.toHaveClass("is-attention");
    expect(village.textContent).not.toContain("?");
    fireEvent.click(within(village).getByRole("button", { name: "Inspect Agent Ada" }));
    expect(onSelect).toHaveBeenLastCalledWith("release-verifier");
  });

  it("shows exact overview scope counts and a clear first action", () => {
    const snapshot = fixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const onNavigate = vi.fn();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={onNavigate}
        onSelect={() => undefined}
      />,
    );

    const scope = screen.getByLabelText("World scope");
    expect(scope).toHaveAttribute("data-project-count", String(hierarchy.projects.length));
    expect(scope).toHaveAttribute("data-task-count", String(hierarchy.tasks.length));
    expect(scope).toHaveAttribute("data-agent-count", String(hierarchy.agents.length));
    expect(scope).toHaveTextContent(`Projects${hierarchy.projects.length}`);
    expect(scope).toHaveTextContent(`Tasks${hierarchy.tasks.length}`);
    expect(scope).toHaveTextContent(`Agents${hierarchy.agents.length}`);
    expect(container.querySelector(".overview-summary__state")).toHaveTextContent("1 needs you");
    expect(container.querySelector(".overview-summary__state")).not.toHaveTextContent("1 need you");
    expect(container.querySelector(".overview-summary__action")).toHaveTextContent("Needs your review");
    expect(container.querySelector(".overview-summary__action")).toHaveTextContent("Approve interface direction");
    expect(container.querySelector(".overview-summary__action")).toHaveTextContent("Product Update · Waiting for you");
    expect(container.querySelector(".overview-summary__action")).toHaveTextContent("Choose an interface direction to continue");
    expect(container.querySelector(".overview-summary__action")).toHaveTextContent("Observed evidence · aging");
    expect(container.querySelector(".overview-summary__action")).toHaveTextContent("Review task");
    expect(container.querySelector(".overview-summary__action")).toHaveProperty("tagName", "BUTTON");
    fireEvent.click(screen.getByRole("button", { name: "Review task Approve interface direction in map" }));
    expect(onNavigate).toHaveBeenCalledWith(taskTarget("product-update", "product-interface-review"));
  });

  it("uses the world map itself as the overview hero", () => {
    const snapshot = fixture();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const map = container.querySelector(".realm-map--overview") as HTMLElement;
    const title = screen.getByRole("heading", { name: "Your team, in view." });

    expect(map).toContainElement(title);
    expect(map.querySelector('[data-overview-hud="true"]')).toContainElement(title);
    expect(container.querySelector(".world-commandbar__source")).toHaveTextContent("Demo");
    expect(container.querySelector("[data-demo-disclosure]")).not.toBeInTheDocument();
  });

  it("describes active work honestly when no task needs a human decision", () => {
    const snapshot = fixture();
    const noDecisionSnapshot: WorldSnapshot = {
      ...snapshot,
      attention: snapshot.attention.filter((agentId) => agentId !== "product-interface-review"),
      agents: snapshot.agents.map((agent) => agent.id === "product-interface-review"
        ? {
          ...agent,
          state: "running",
          attentionReason: undefined,
          currentAction: "Comparing interface directions",
          events: agent.events.filter((event) => event.kind !== "approval"),
        }
        : agent),
    };

    render(
      <Archipelago
        snapshot={noDecisionSnapshot}
        replayCutoff={Date.parse(noDecisionSnapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "Your team, in view." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open task .* in map/ })).toHaveTextContent("Active now");
    expect(screen.queryByText("No human decision requested")).not.toBeInTheDocument();
  });

  it("keeps the mission phase aligned across the task map, district, and Atlas rail", async () => {
    const user = userEvent.setup();
    const snapshot = fixture();
    const cutoff = Date.parse(snapshot.generatedAt);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const world = buildMissionWorld(snapshot, cutoff);
    const mission = world.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    expect(mission.phase).toBe("verification");
    expect(mission.phaseLabel).toBe("Verification");

    const { container, rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    openViewOptions();
    fireEvent.click(screen.getByRole("button", { name: "Open Atlas" }));
    const overviewTask = Array.from(container.querySelectorAll<HTMLElement>(".world-tree__task")).find(item => item.textContent?.includes(task.displayName));
    expect(overviewTask).toHaveAttribute("data-mission-phase", mission.phase);
    expect(overviewTask).toHaveTextContent(mission.phaseLabel);

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const district = container.querySelector(`.district-card[data-task-id="${task.id}"]`) as HTMLElement;
    expect(district).toHaveAttribute("data-mission-phase", mission.phase);
    expect(district.querySelector(".district-card__signal")).toHaveTextContent(mission.phaseLabel);

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toHaveAttribute("data-mission-phase", mission.phase);
    expect(village.querySelector(".task-village__plaque")).toHaveTextContent(mission.phaseLabel);

    openViewOptions();
    await user.click(screen.getByRole("button", { name: "Open Atlas" }));
    const railTask = Array.from(container.querySelectorAll<HTMLElement>(".world-tree__task"))
      .find((candidate) => candidate.textContent?.includes(task.displayName));
    expect(railTask).toBeDefined();
    expect(railTask).toHaveAttribute("data-mission-phase", mission.phase);
    expect(railTask).toHaveTextContent(mission.phaseLabel);
  });

  it("lights a district and bridge only after an observed root completion", () => {
    const snapshot = fixture();
    const cutoff = Date.parse(snapshot.generatedAt);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "source-review")!;
    const task = project.tasks.find((candidate) => candidate.id === "source-scout")!;
    const world = buildMissionWorld(snapshot, cutoff);
    const mission = world.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    expect(mission.phase).toBe("complete");
    expect(mission.evolution).toEqual({ verified: true, districtLit: true, rootHomeLit: true, bridgeOpen: true });

    const { container, rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const completedProject = container.querySelector(`[data-project-island][data-project-id="${project.project.id}"]`) as HTMLElement;
    expect(completedProject).toHaveAttribute("data-world-evolution", "verified-complete");
    expect(completedProject).toHaveTextContent("Complete");
    const unrelatedProject = container.querySelector('[data-project-island][data-project-id="release-readiness"]') as HTMLElement;
    expect(unrelatedProject).toHaveAttribute("data-world-evolution", "unchanged");

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const district = container.querySelector(`.district-card[data-task-id="${task.id}"]`) as HTMLElement;
    expect(district).toHaveAttribute("data-mission-phase", "complete");
    expect(district).toHaveAttribute("data-world-evolution", "verified-complete");
    expect(district).toHaveTextContent("Completion verified");
    expect(district.querySelector(".district-card__completion-bridge")).toBeInTheDocument();
    expect(district.querySelector('[data-world-growth="verified-completion"]')).toBeInTheDocument();

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toHaveAttribute("data-mission-phase", "complete");
    expect(village).toHaveAttribute("data-world-evolution", "verified-complete");
    expect(village).toHaveTextContent("Completion verified");
    expect(village.querySelector('[data-world-growth="verified-completion"]')).toBeInTheDocument();
  });

  it("does not light a mission when only a child agent completes", () => {
    const snapshot = fixture();
    const cutoff = Date.parse(snapshot.generatedAt);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const world = buildMissionWorld(snapshot, cutoff);
    const mission = world.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    expect(mission.phase).toBe("verification");
    expect(mission.evolution.verified).toBe(false);

    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const district = container.querySelector(`.district-card[data-task-id="${task.id}"]`) as HTMLElement;
    expect(district).toHaveAttribute("data-mission-phase", "verification");
    expect(district).toHaveAttribute("data-world-evolution", "unchanged");
    expect(district).not.toHaveTextContent("Completion verified");
    expect(district.querySelector(".district-card__completion-bridge")).toBeInTheDocument();
    expect(district.querySelector('[data-world-growth="verified-completion"]')).not.toBeInTheDocument();
  });

  it("keeps a replayed district dark until its root completion enters the cutoff", () => {
    const snapshot = fixture();
    const generatedAt = Date.parse(snapshot.generatedAt);
    const beforeCompletion = generatedAt - 10 * 60_000;
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "source-review")!;
    const task = project.tasks.find((candidate) => candidate.id === "source-scout")!;
    const before = buildMissionWorld(snapshot, beforeCompletion);
    const after = buildMissionWorld(snapshot, generatedAt);
    const beforeMission = before.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    const afterMission = after.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    expect(beforeMission.phase).toBe("verification");
    expect(beforeMission.evolution.verified).toBe(false);
    expect(afterMission.phase).toBe("complete");
    expect(afterMission.evolution.verified).toBe(true);

    const { container, rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={beforeCompletion}
        missionWorld={before}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    let village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toHaveAttribute("data-mission-phase", "verification");
    expect(village).toHaveAttribute("data-world-evolution", "unchanged");
    expect(village).not.toHaveTextContent("Completion verified");
    expect(village.querySelector('[data-agent-state="complete"]')).not.toBeInTheDocument();
    expect(village).not.toHaveTextContent("Zzz");
    expect(village.querySelector('[data-world-growth="verified-completion"]')).not.toBeInTheDocument();

    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={generatedAt}
        missionWorld={after}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toHaveAttribute("data-mission-phase", "complete");
    expect(village).toHaveAttribute("data-world-evolution", "verified-complete");
    expect(village).toHaveTextContent("Completion verified");
    expect(village.querySelector('[data-agent-state="complete"]')).toBeInTheDocument();
    expect(village).toHaveTextContent("Zzz");
    expect(village.querySelector('[data-world-growth="verified-completion"]')).toBeInTheDocument();
  });

  it("distinguishes waiting on an agent from a human decision", () => {
    const snapshot = fixture();
    const cutoff = Date.parse(snapshot.generatedAt);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "field-research")!;
    const task = project.tasks.find((candidate) => candidate.id === "field-coordinator")!;
    const world = buildMissionWorld(snapshot, cutoff);
    const mission = world.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    expect(mission.phase).toBe("waiting-on-agent");
    expect(mission.phaseLabel).toBe("Waiting on agent");
    expect(mission.decision).toBeNull();

    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const district = container.querySelector(`.district-card[data-task-id="${task.id}"]`) as HTMLElement;
    expect(district).toHaveAttribute("data-mission-phase", "waiting-on-agent");
    expect(district.querySelector(".district-card__signal")).toHaveTextContent("Waiting on agent");
    expect(district).not.toHaveTextContent("Waiting for you");
  });

  it("labels an explicit approval gate as waiting for you", () => {
    const snapshot = fixture();
    const cutoff = Date.parse(snapshot.generatedAt);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "product-update")!;
    const task = project.tasks.find((candidate) => candidate.id === "product-interface-review")!;
    const world = buildMissionWorld(snapshot, cutoff);
    const mission = world.missions.find((candidate) => candidate.projectId === project.project.id && candidate.taskId === task.id)!;
    expect(mission.phase).toBe("waiting-for-you");
    expect(mission.phaseLabel).toBe("Waiting for you");
    expect(mission.decision).toMatchObject({ kind: "approval", reason: "Choose an interface direction to continue" });

    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={cutoff}
        missionWorld={world}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const district = container.querySelector(`.district-card[data-task-id="${task.id}"]`) as HTMLElement;
    expect(district).toHaveAttribute("data-mission-phase", "waiting-for-you");
    expect(district.querySelector(".district-card__signal")).toHaveTextContent("Waiting for you");
  });

  it("renders a zero-agent source as an in-world state without stranded map controls", async () => {
    const user = userEvent.setup();
    const snapshot: WorldSnapshot = {
      ...fixture(),
      mode: "live",
      sourceLabel: "Live snapshot",
      projects: [],
      agents: [],
      attention: [],
      warnings: ["Snapshot source was not configured."],
    };
    const openDemo = vi.fn();
    const retry = vi.fn();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        emptyState={{
          kind: "unconfigured",
          eyebrow: "LIVE SOURCE SETUP",
          title: "Connect a source",
          description: "Connect a local source to see your projects, tasks, and agents.",
          detail: "Choose a provider when starting the local server, then select Live.",
          sourceSummary: "Source not configured",
          connectionOptions: [
            {
              label: "Codex",
              description: "Use the built-in local adapter.",
              command: "AGENTARIUM_PROVIDER=codex npm run dev",
            },
            {
              label: "JSONL bridge",
              description: "Connect any harness that emits WorldSnapshot JSONL.",
              command: "AGENTARIUM_PROVIDER=jsonl \\\nAGENTARIUM_SNAPSHOT_PATH=/path/to/world.jsonl \\\nnpm run dev",
            },
          ],
          connectionNote: "Contract: docs/world-snapshot.schema.json",
          primaryAction: { label: "Open demo world", onClick: openDemo },
          secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: retry },
        }}
      />,
    );

    expect(container.querySelector(".archipelago")).toHaveAttribute("data-empty-state", "unconfigured");
    const setup = screen.getByRole("region", { name: "Connect a source" });
    expect(setup).toHaveTextContent("AGENTARIUM_PROVIDER=codex npm run dev");
    expect(setup).toHaveTextContent("AGENTARIUM_PROVIDER=jsonl");
    expect(setup).toHaveTextContent("AGENTARIUM_SNAPSHOT_PATH=/path/to/world.jsonl");
    expect(setup).toHaveTextContent("docs/world-snapshot.schema.json");
    expect(container.querySelector(".empty-world-scene")).toBeInTheDocument();
    expect(container.querySelector(".world-empty")).not.toBeInTheDocument();
    expect(screen.queryByText("Every project, one living world")).not.toBeInTheDocument();
    expect(screen.queryByText("Open a project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on Evidence lens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Atlas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause agent movement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open cinematic view" })).not.toBeInTheDocument();
    expect(screen.getByText("Source not configured")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open demo world" }));
    await user.click(screen.getByRole("button", { name: "Retry live source" }));
    expect(openDemo).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders a healthy quiet source without inventing projects or work", () => {
    const snapshot: WorldSnapshot = {
      ...fixture(),
      mode: "live",
      sourceLabel: "Live snapshot",
      projects: [],
      agents: [],
      attention: [],
      warnings: [],
    };
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        emptyState={{
          kind: "empty",
          eyebrow: "LIVE SOURCE READY",
          title: "No active agents yet",
          description: "The live source is connected and currently reports zero agent records.",
          sourceSummary: "Connected · 0 agents",
          primaryAction: { label: "Open demo world", onClick: () => undefined },
          secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: () => undefined },
        }}
      />,
    );

    expect(container.querySelector(".archipelago")).toHaveAttribute("data-empty-state", "empty");
    expect(container.querySelector('[data-empty-world="empty"]')).toBeInTheDocument();
    expect(container.querySelector(".realm-map--overview")).not.toBeInTheDocument();
    expect(container.querySelector(".overview-summary__action")).not.toBeInTheDocument();
    expect(container.querySelector("[data-project-island][data-project-id]")).not.toBeInTheDocument();
    expect(screen.getByText("Connected · 0 agents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open demo world" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry live source" })).toBeInTheDocument();
  });

  it("retains canonical breadcrumb names when filters hide the current mission", () => {
    const fullSnapshot = fixture();
    const filteredSnapshot: WorldSnapshot = {
      ...fullSnapshot,
      projects: [],
      agents: [],
      attention: [],
    };
    const missionWorld = buildMissionWorld(fullSnapshot, Date.parse(fullSnapshot.generatedAt));

    const { container } = render(
      <Archipelago
        snapshot={filteredSnapshot}
        replayCutoff={Date.parse(fullSnapshot.generatedAt)}
        missionWorld={missionWorld}
        navigation={taskTarget("source-review", "source-scout")}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        emptyState={{
          kind: "filtered",
          eyebrow: "VIEW FILTERED TO ZERO",
          title: "No agents match this view",
          description: "Clear the current search and filters.",
        }}
      />,
    );

    const location = screen.getByLabelText("World location");
    expect(location).toHaveTextContent("Source Review");
    expect(location).toHaveTextContent("Review current sources");
    expect(location).not.toHaveTextContent("Project e-review");
  });

  it("keeps retained root context out of the filtered task map and counts only visible agents", () => {
    const fullSnapshot = groupedFixture();
    const contextAgents = fullSnapshot.agents.filter((agent) => ["release-verifier", "release-probe"].includes(agent.id));
    const contextSnapshot: WorldSnapshot = {
      ...fullSnapshot,
      projects: fullSnapshot.projects
        .filter((project) => project.id === "release-readiness")
        .map((project) => ({ ...project, agentIds: contextAgents.map((agent) => agent.id) })),
      agents: contextAgents,
      attention: [],
    };
    const missionWorld = buildMissionWorld(fullSnapshot, Date.parse(fullSnapshot.generatedAt));
    const hierarchy = buildWorldHierarchy(contextSnapshot);
    const project = hierarchy.projects[0]!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;

    const { container } = render(
      <Archipelago
        snapshot={contextSnapshot}
        replayCutoff={Date.parse(fullSnapshot.generatedAt)}
        missionWorld={missionWorld}
        visibleAgentIds={["release-probe"]}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toHaveAttribute("data-agent-count", "1");
    expect(village.querySelectorAll("[data-agent-id]")).toHaveLength(1);
    expect(village.querySelector('[data-agent-id="release-probe"]')).toBeInTheDocument();
    expect(village.querySelector('[data-agent-id="release-verifier"]')).not.toBeInTheDocument();
    expect(village.querySelector("#task-title")).toHaveTextContent("Verify release candidate");
    expect(village).toHaveTextContent("1 agent");
  });

  it("explains when a canonical mission is hidden by the current filter and offers a truthful overview action", () => {
    const fullSnapshot = groupedFixture();
    const contextAgents = fullSnapshot.agents.filter((agent) => ["release-verifier", "release-probe"].includes(agent.id));
    const contextSnapshot: WorldSnapshot = {
      ...fullSnapshot,
      projects: fullSnapshot.projects
        .filter((project) => project.id === "release-readiness")
        .map((project) => ({ ...project, agentIds: contextAgents.map((agent) => agent.id) })),
      agents: contextAgents,
      attention: [],
    };
    const missionWorld = buildMissionWorld(fullSnapshot, Date.parse(fullSnapshot.generatedAt));
    const onNavigate = vi.fn();

    const { container } = render(
      <Archipelago
        snapshot={contextSnapshot}
        replayCutoff={Date.parse(fullSnapshot.generatedAt)}
        missionWorld={missionWorld}
        visibleAgentIds={[]}
        navigation={taskTarget("release-readiness", "release-verifier")}
        onNavigate={onNavigate}
        onSelect={() => undefined}
      />,
    );

    expect(screen.getByText("LOCATION HIDDEN BY FILTER")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This task is hidden by the current filter" })).toBeInTheDocument();
    expect(container.querySelector("[data-filtered-location=\"true\"]")).toHaveTextContent("Verify release candidate");
    expect(screen.queryByText(/not in the latest source update/i)).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Return to project map" });
    fireEvent.click(action);
    expect(onNavigate).toHaveBeenCalledWith({ level: "overview" });
  });

  it("keeps a four-agent task balanced with one exact home-to-work route per agent", () => {
    const snapshot = fourAgentFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    const grid = village.querySelector(".agent-lot-grid") as HTMLElement;
    expect(village).toHaveAttribute("data-agent-count", "4");
    expect(village).toHaveAttribute("data-agent-layout", "four-grid");
    expect(village).toHaveAttribute("data-route-mode", "assigned");
    expect(container.querySelector(".task-village-legend")).toHaveTextContent("Moving between home and work: active");
    expect(grid).toHaveAttribute("data-agent-layout", "four-grid");
    expect(village.querySelector('[data-route-kind="shared"]')).not.toBeInTheDocument();
    expect(village.querySelector('[data-hub-kind="work"]')).not.toBeInTheDocument();
    expect(village).toHaveAttribute("data-motion-route", "assigned");
    expect(village.querySelectorAll('.agent-lot[data-route-state="commuting"]')).toHaveLength(2);
    expect(village.querySelectorAll('.agent-lot[data-route-state="work"]')).toHaveLength(1);
    expect(village.querySelectorAll('.agent-lot[data-route-state="home"]')).toHaveLength(1);
    village.querySelectorAll<HTMLElement>(".agent-lot").forEach((lot) => {
      const homeAnchor = lot.querySelector('[data-route-anchor="home"]');
      const workAnchor = lot.querySelector('[data-route-anchor="work"]');
      expect(homeAnchor).toBeInTheDocument();
      expect(workAnchor).toBeInTheDocument();
      expect(homeAnchor?.closest(".agent-home")).toBeInTheDocument();
      expect(workAnchor?.closest(".agent-workspot")).toBeInTheDocument();
      expect(lot.querySelector(".agent-lot__path")).toBeInTheDocument();
      expect(lot.querySelector(".agent-workspot")).toHaveTextContent("WORK");
    });
    const indexes = Array.from(village.querySelectorAll<HTMLElement>(".agent-lot[data-agent-index]"))
      .map((lot) => lot.dataset.agentIndex);
    expect(indexes).toEqual(["0", "1", "2", "3"]);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it.each([
    [5, "five-grid"],
    [6, "six-grid"],
  ] as const)("keeps a %i-agent task in a balanced assigned-route grid", (agentCount, expectedLayout) => {
    const snapshot = expandedCrewFixture(agentCount);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    const grid = village.querySelector(".agent-lot-grid") as HTMLElement;
    expect(village).toHaveAttribute("data-agent-count", String(agentCount));
    expect(village).toHaveAttribute("data-agent-layout", expectedLayout);
    expect(village).toHaveAttribute("data-route-mode", "assigned");
    expect(grid).toHaveAttribute("data-agent-layout", expectedLayout);
    expect(grid.querySelectorAll(".agent-lot")).toHaveLength(agentCount);
    expect(village.querySelector('[data-route-kind="shared"]')).not.toBeInTheDocument();
    expect(village.querySelector('[data-hub-kind="work"]')).not.toBeInTheDocument();
    expect(village.querySelectorAll('[data-route-anchor="home"]')).toHaveLength(agentCount);
    expect(village.querySelectorAll('[data-route-anchor="work"]')).toHaveLength(agentCount);
    const indexes = Array.from(grid.querySelectorAll<HTMLElement>(".agent-lot[data-agent-index]"))
      .map((lot) => lot.dataset.agentIndex);
    expect(indexes).toEqual(Array.from({ length: agentCount }, (_, index) => String(index)));
    expect(new Set(indexes).size).toBe(agentCount);
  });

  it("keeps adaptive crews on the same explicit assigned-route contract", () => {
    const snapshot = expandedCrewFixture(7);
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    expect(village).toHaveAttribute("data-agent-count", "7");
    expect(village).toHaveAttribute("data-agent-layout", "adaptive");
    expect(village).toHaveAttribute("data-route-mode", "assigned");
    expect(village.querySelector('[data-route-kind="shared"]')).not.toBeInTheDocument();
    expect(village.querySelector('[data-hub-kind="work"]')).not.toBeInTheDocument();
    expect(village.querySelectorAll('[data-route-anchor="home"]')).toHaveLength(7);
    expect(village.querySelectorAll('[data-route-anchor="work"]')).toHaveLength(7);
    expect(within(container.querySelector(".task-village-legend")!).getByText("Moving between home and work: active")).toBeInTheDocument();
  });

  it("does not describe a failed agent as a human decision", () => {
    const snapshot = groupedFixture();
    const releaseAgents = snapshot.agents.filter((agent) => agent.projectId === "release-readiness");
    const releaseOnly: WorldSnapshot = {
      ...snapshot,
      projects: snapshot.projects
        .filter((project) => project.id === "release-readiness")
        .map((project) => ({ ...project, agentIds: releaseAgents.map((agent) => agent.id) })),
      agents: releaseAgents,
      attention: ["release-probe"],
    };
    const project = buildWorldHierarchy(releaseOnly).projects[0]!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const { container } = render(
      <Archipelago
        snapshot={releaseOnly}
        replayCutoff={Date.parse(releaseOnly.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const plaque = container.querySelector(".task-village__plaque") as HTMLElement;
    expect(plaque).toHaveTextContent("past stop");
    expect(plaque).not.toHaveTextContent(/needs? you/i);
  });

  it("focuses bounded evidence and dims unrelated villagers when the lens is on", async () => {
    const user = userEvent.setup();
    const snapshot = fourAgentFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const { container } = render(<LensHarness snapshot={snapshot} navigation={taskTarget(project.project.id, task.id)} selectedId="release-scout" />);

    await user.click(screen.getByRole("button", { name: "Turn on Evidence lens" }));
    const world = container.querySelector(".archipelago") as HTMLElement;
    const village = container.querySelector(`.task-village[data-task-id="${task.id}"]`) as HTMLElement;
    const contextStrip = container.querySelector("[data-task-context-strip=\"true\"]") as HTMLElement;
    expect(world).toHaveAttribute("data-evidence-lens", "on");
    expect(screen.getByRole("button", { name: "Turn off Evidence lens" })).toHaveAttribute("aria-pressed", "true");
    expect(contextStrip).toBeInTheDocument();
    expect(contextStrip.querySelector('[data-evidence-proof="true"]')).toHaveTextContent("Evidence for current state");
    expect(contextStrip.querySelector('[data-evidence-proof="true"]')).toHaveTextContent("Checklist scan started");
    expect(contextStrip.querySelector('[data-evidence-proof="true"]')).toHaveTextContent("1 bounded event");
    expect(contextStrip.querySelector('[data-evidence-proof="true"]')).toHaveTextContent("Payloads withheld");
    expect(village.querySelector('[data-evidence-proof="true"]')).not.toBeInTheDocument();
    expect(village.querySelector('[data-evidence-focus="selected"]')).toBeInTheDocument();
    expect(village.querySelector('[data-evidence-focus="path"]')).toBeInTheDocument();
    expect(village.querySelectorAll('[data-evidence-focus="dimmed"]')).toHaveLength(2);
    expect(village.textContent).not.toContain("private message");
  });

  it("gives the lens an honest prompt when no agent is selected", async () => {
    const user = userEvent.setup();
    const snapshot = fourAgentFixture();
    const project = buildWorldHierarchy(snapshot).projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const { container } = render(<LensHarness snapshot={snapshot} navigation={taskTarget(project.project.id, task.id)} />);
    await user.click(screen.getByRole("button", { name: "Turn on Evidence lens" }));
    expect(screen.getByText("Select an agent to inspect its evidence.")).toBeInTheDocument();
    expect(container.querySelector("[data-evidence-prompt]"))
      .toHaveTextContent("Evidence for current state");
    expect(container.querySelectorAll('[data-evidence-focus="dimmed"]')).toHaveLength(0);
  });

  it("keeps every task agent reachable from a keyboard-friendly rail roster", async () => {
    const user = userEvent.setup();
    const snapshot = groupedFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const onSelect = vi.fn();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        selectedId="release-verifier"
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={onSelect}
      />,
    );

    openViewOptions();
    await user.click(screen.getByRole("button", { name: "Open Atlas" }));
    const roster = screen.getByRole("group", { name: `Sample agents in ${task.displayName}` });
    const agentButtons = within(roster).getAllByRole("button");
    expect(roster).toHaveAttribute("data-agent-count", String(task.agents.length));
    expect(agentButtons).toHaveLength(task.agents.length);
    expect(within(roster).getByRole("button", { name: /Select sample agent Agent Ada, Lead agent, Verifying/i })).toHaveAttribute("aria-pressed", "true");
    expect(within(roster).getByRole("button", { name: /Select sample agent Agent Vela, Helper agent, Run failed/i })).toBeInTheDocument();
    expect(roster).not.toHaveTextContent("Codex");
    await user.click(within(roster).getByRole("button", { name: /Select sample agent Agent Vela/i }));
    expect(onSelect).toHaveBeenLastCalledWith("release-probe");
  });

  it("keeps keyboard focus in the Atlas after selecting an agent", async () => {
    const user = userEvent.setup();
    const snapshot = groupedFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    render(<SelectionHarness snapshot={snapshot} navigation={taskTarget(project.project.id, task.id)} />);

    openViewOptions();
    await user.click(screen.getByRole("button", { name: "Open Atlas" }));
    const roster = screen.getByRole("group", { name: `Sample agents in ${task.displayName}` });
    const rosterAgent = within(roster).getByRole("button", { name: /Select sample agent Agent Vela/i });
    await user.click(rosterAgent);

    expect(rosterAgent).toHaveFocus();
    expect(rosterAgent).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps not-yet-observed replay agents disabled in both the map and Atlas", async () => {
    const user = userEvent.setup();
    const snapshot = groupedFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    const onSelect = vi.fn();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt) - 24 * 60 * 60_000}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={onSelect}
      />,
    );

    const mapAgents = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-villager"));
    expect(mapAgents.length).toBeGreaterThan(0);
    mapAgents.forEach((button) => expect(button).toBeDisabled());

    openViewOptions();
    await user.click(screen.getByRole("button", { name: "Open Atlas" }));
    const roster = screen.getByRole("group", { name: `Sample agents in ${task.displayName}` });
    const rosterAgents = within(roster).getAllByRole("button");
    rosterAgents.forEach((button) => expect(button).toBeDisabled());
    await user.click(rosterAgents[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not steal focus when motion is paused or resumed", async () => {
    const user = userEvent.setup();
    const snapshot = groupedFixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === "release-readiness")!;
    const task = project.tasks.find((candidate) => candidate.id === "release-verifier")!;
    render(
      <Archipelago
        snapshot={snapshot}
        selectedId="release-verifier"
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    openViewOptions();
    await user.click(screen.getByRole("button", { name: "Pause agent movement" }));
    expect(screen.getByRole("button", { name: "Resume agent movement" })).toHaveFocus();
  });

  it("preserves scene controls during source updates and replaces the scene only when navigating", () => {
    const snapshot = fixture();
    const props = { snapshot, replayCutoff: Date.parse(snapshot.generatedAt), onNavigate: vi.fn(), onSelect: vi.fn() };
    const { container, rerender } = render(<Archipelago {...props} navigation={{ level: "overview" }} />);
    const overview = container.querySelector(".world-stage");
    const next = { ...snapshot, generatedAt: new Date(Date.parse(snapshot.generatedAt) + 1000).toISOString() };
    rerender(<Archipelago {...props} snapshot={next} navigation={{ level: "overview" }} />);
    expect(container.querySelector(".world-stage")).toBe(overview);
    rerender(<Archipelago {...props} navigation={projectTarget("release-readiness")} />);
    const project = container.querySelector(".world-stage");
    expect(project).not.toBe(overview);
    rerender(<Archipelago {...props} navigation={taskTarget("release-readiness", "release-verifier")} />);
    const task = container.querySelector(".world-stage");
    expect(task).not.toBe(project);
    const inspect = screen.getByRole("button", { name: "Inspect Verify release candidate" });
    inspect.focus();
    rerender(<Archipelago {...props} snapshot={next} navigation={taskTarget("release-readiness", "release-verifier")} />);
    expect(container.querySelector(".world-stage")).toBe(task);
    expect(inspect).toHaveFocus();
  });

  it("keeps Evidence lens unavailable outside a task and functional in task view", async () => {
    const snapshot = fixture();
    const hierarchy = buildWorldHierarchy(snapshot);
    const project = hierarchy.projects[0]!;
    const task = project.tasks[0]!;
    const onEvidenceLensChange = vi.fn();
    const { container, rerender } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        evidenceLensOn
        onEvidenceLensChange={onEvidenceLensChange}
      />,
    );

    expect(screen.queryByRole("button", { name: "Turn on Evidence lens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off Evidence lens" })).not.toBeInTheDocument();
    expect(container.querySelector(".archipelago")).toHaveAttribute("data-evidence-lens", "off");
    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={projectTarget(project.project.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        evidenceLensOn
        onEvidenceLensChange={onEvidenceLensChange}
      />,
    );
    expect(screen.queryByRole("button", { name: "Turn on Evidence lens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off Evidence lens" })).not.toBeInTheDocument();
    expect(container.querySelector(".archipelago")).toHaveAttribute("data-evidence-lens", "off");
    rerender(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        evidenceLensOn
        onEvidenceLensChange={onEvidenceLensChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Turn off Evidence lens" })).toBeInTheDocument();
    expect(container.querySelector(".archipelago")).toHaveAttribute("data-evidence-lens", "on");
    expect(onEvidenceLensChange).toHaveBeenCalledWith(false);
  });

  it("names unavailable evidence explicitly without a question mark placeholder", () => {
    const snapshot = fixture();
    const unknown = snapshot.agents.find((agent) => agent.id === "source-archive")!;
    const agents = snapshot.agents.map((agent) => agent.id === unknown.id ? { ...agent, state: "unknown" as const } : agent);
    const next = { ...snapshot, agents };
    const hierarchy = buildWorldHierarchy(next);
    const project = hierarchy.projects.find((candidate) => candidate.project.id === unknown.projectId)!;
    const task = project.tasks.find((candidate) => candidate.agentIds.includes(unknown.id))!;
    const { container } = render(
      <Archipelago
        snapshot={next}
        replayCutoff={Date.parse(next.generatedAt)}
        navigation={taskTarget(project.project.id, task.id)}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const lot = container.querySelector(`.task-village [data-agent-id="${unknown.id}"]`) as HTMLElement;
    expect(within(lot).getByRole("button", { name: /Evidence unavailable/ })).toBeInTheDocument();
    expect(lot).not.toHaveTextContent("?");
  });

  it("starts villagers moving and offers an explicit pause control", async () => {
    const user = userEvent.setup();
    const snapshot = fixture();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const world = container.querySelector(".archipelago") as HTMLElement;
    expect(world).toHaveAttribute("data-motion", "on");
    openViewOptions();
    await user.click(screen.getByRole("button", { name: "Pause agent movement" }));
    expect(world).toHaveAttribute("data-motion", "off");
    expect(screen.getByRole("button", { name: "Resume agent movement" })).toHaveAttribute("aria-pressed", "false");
  });

  it("starts paused when the system requests reduced motion and can be resumed explicitly", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const snapshot = fixture();

    try {
      const { container } = render(
        <Archipelago
          snapshot={snapshot}
          replayCutoff={Date.parse(snapshot.generatedAt)}
          navigation={{ level: "overview" }}
          onNavigate={() => undefined}
          onSelect={() => undefined}
        />,
      );

      const world = container.querySelector(".archipelago") as HTMLElement;
      expect(world).toHaveAttribute("data-motion", "off");
      openViewOptions();
      expect(screen.getByRole("button", { name: "Resume agent movement" })).toHaveAttribute("aria-pressed", "false");
      await user.click(screen.getByRole("button", { name: "Resume agent movement" }));
      expect(world).toHaveAttribute("data-motion", "on");
      expect(screen.getByRole("button", { name: "Pause agent movement" })).toHaveAttribute("aria-pressed", "true");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps every task named in cinematic view and exposes deterministic world time", async () => {
    const user = userEvent.setup();
    const snapshot = fixture();
    const { container } = render(
      <Archipelago
        snapshot={snapshot}
        replayCutoff={Date.parse(snapshot.generatedAt)}
        navigation={{ level: "overview" }}
        onNavigate={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const world = container.querySelector(".archipelago") as HTMLElement;
    expect(world).toHaveAttribute("data-time", worldTimePhase(worldHour()));
    openViewOptions();
    expect(screen.getByRole("button", { name: "Open cinematic view" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Open cinematic view" }));
    expect(world).toHaveClass("is-cinematic");
    expect(world).toHaveAttribute("data-time", expect.stringMatching(/^(dawn|day|dusk|night)$/));
    expect(screen.getByRole("button", { name: "Exit cinematic view" })).toHaveAttribute("aria-pressed", "true");
    expect(world.querySelectorAll("[data-project-island][data-project-id]")).toHaveLength(buildWorldHierarchy(snapshot).projects.length);
  });

  it("clamps the optional hour override to the supported local-day range", () => {
    expect(worldHour("?hour=0")).toBe(0);
    expect(worldHour("?hour=23")).toBe(23);
    expect(worldHour("?hour=24")).not.toBe(24);
    expect(worldTimePhase(4)).toBe("night");
    expect(worldTimePhase(5)).toBe("dawn");
    expect(worldTimePhase(12)).toBe("day");
    expect(worldTimePhase(18)).toBe("dusk");
    expect(worldTimePhase(21)).toBe("night");
  });
});
