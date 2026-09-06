import { describe, expect, it } from "vitest";

import type { AgentSnapshot, ProjectSnapshot, WorldSnapshot } from "./contracts";
import {
  buildWorldHierarchy,
  displayAgentDescriptor,
  displayAgentName,
  normalizeDisplayName,
  normalizeNavigation,
  parentNavigation,
  projectTarget,
  shortOpaqueId,
  taskTarget,
} from "./hierarchy";

const NOW = "2026-08-29T12:00:00.000Z";

const template: AgentSnapshot = {
  id: "template",
  title: "Template",
  projectId: "alpha",
  projectName: "Alpha",
  state: "idle",
  evidence: "observed",
  lastSeen: NOW,
  ageMs: 0,
  currentAction: "Idle",
  childCount: 0,
  events: [],
};

function agent(overrides: Partial<AgentSnapshot> & Pick<AgentSnapshot, "id">): AgentSnapshot {
  return { ...template, ...overrides };
}

function project(id: string, name: string, members: AgentSnapshot[]): ProjectSnapshot {
  return {
    id,
    name,
    color: id === "alpha" ? "#57d7d2" : "#8b7bd9",
    agentIds: members.filter((member) => member.projectId === id).map((member) => member.id),
    activeCount: members.filter((member) => member.projectId === id && member.state !== "idle").length,
    attentionCount: 0,
  };
}

function snapshot(agents: AgentSnapshot[], projects?: ProjectSnapshot[]): WorldSnapshot {
  return {
    schemaVersion: 1,
    mode: "demo",
    generatedAt: NOW,
    sourceFreshness: NOW,
    projects: projects ?? [project("alpha", "Alpha", agents)],
    agents,
    attention: agents.filter((member) => member.state === "needs-you").map((member) => member.id),
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: [],
  };
}

describe("buildWorldHierarchy", () => {
  it("partitions every agent exactly once and preserves project/task membership", () => {
    const agents = [
      agent({ id: "alpha-root", title: "Release train", projectId: "alpha" }),
      agent({ id: "alpha-child-a", title: "Worker A", projectId: "alpha", parentAgentId: "alpha-root" }),
      agent({ id: "alpha-child-b", title: "Worker B", projectId: "alpha", parentAgentId: "alpha-root" }),
      agent({ id: "alpha-solo", title: "Docs sweep", projectId: "alpha" }),
      agent({ id: "beta-root", title: "Checks", projectId: "beta", projectName: "Beta" }),
    ];
    const hierarchy = buildWorldHierarchy(snapshot(agents, [project("alpha", "Alpha", agents), project("beta", "Beta", agents)]));

    expect(hierarchy.projects.map((item) => item.project.id)).toEqual(["alpha", "beta"]);
    expect(hierarchy.projects.find((item) => item.project.id === "alpha")?.tasks).toHaveLength(2);
    const rootTask = hierarchy.projects.find((item) => item.project.id === "alpha")?.tasks.find((item) => item.id === "alpha-root");
    expect(rootTask?.agentIds).toHaveLength(3);
    expect(rootTask?.agentIds).toEqual(expect.arrayContaining(["alpha-child-a", "alpha-child-b", "alpha-root"]));
    expect(hierarchy.agents.map((item) => item.agent.id).sort()).toEqual(agents.map((item) => item.id).sort());
    expect(new Set(hierarchy.agents.map((item) => item.agent.id)).size).toBe(agents.length);
    expect(hierarchy.tasks.flatMap((item) => item.agentIds).sort()).toEqual(agents.map((item) => item.id).sort());
  });

  it("keeps siblings together when the root record is outside the bounded snapshot", () => {
    const agents = [
      agent({ id: "ghost-child-a", title: "Task deadbeef", projectId: "alpha", parentAgentId: "deadbeef-root" }),
      agent({ id: "ghost-child-b", title: "", projectId: "alpha", parentAgentId: "deadbeef-root" }),
    ];
    const hierarchy = buildWorldHierarchy(snapshot(agents));
    const task = hierarchy.projects[0]?.tasks[0];

    expect(hierarchy.projects[0]?.tasks).toHaveLength(1);
    expect(task?.id).toBe("deadbeef-root");
    expect(task?.rootAgentId).toBeUndefined();
    expect(task?.agents).toHaveLength(2);
    expect(task?.displayName).toBe("Parent task outside snapshot · eef-root");
    expect(task?.agents.every((item) => item.displayName.trim().length > 0)).toBe(true);
  });

  it("keeps a generic root distinguishable with a bounded opaque suffix", () => {
    const root = agent({ id: "root-record", title: "Task deadbeef", projectId: "alpha" });
    const child = agent({ id: "child-record", title: "Worker", projectId: "alpha", parentAgentId: root.id });
    const hierarchy = buildWorldHierarchy(snapshot([root, child]));

    expect(hierarchy.projects[0]?.tasks[0]?.displayName).toBe("Unresolved task · t-record");
  });

  it("replaces punctuation-only task and agent labels with stable fallbacks", () => {
    const root = agent({ id: "question-root", title: "???", projectId: "alpha" });
    const child = agent({ id: "question-child", title: "?", projectId: "alpha", parentAgentId: root.id });
    const hierarchy = buildWorldHierarchy(snapshot([root, child]));

    expect(hierarchy.projects[0]?.tasks[0]?.displayName).toBe("Unresolved task · ion-root");
    expect(displayAgentName(child)).toBe("Agent on-child");
  });

  it("keeps a nickname as agent identity and assignment as explicit context", () => {
    const pathAgent = agent({
      id: "dispatch-01",
      title: "Task deadbeef",
      assignment: "Dispatch runner",
      projectId: "alpha",
    });
    const nicknameAgent = agent({
      id: "named-01",
      title: "Title fallback",
      nickname: "  Dispatch lead  ",
      role: "operator",
      assignment: "Dispatch assignment",
      projectId: "alpha",
    });
    const roleAgent = agent({
      id: "role-01",
      title: "Task deadbeef",
      role: "reviewer",
      projectId: "alpha",
    });
    const blankAgent = agent({ id: "blank-01", title: "   ", projectId: "alpha" });

    expect(displayAgentName(pathAgent)).toBe("Dispatch runner");
    expect(displayAgentName(nicknameAgent)).toBe("Agent Dispatch lead");
    expect(displayAgentDescriptor(nicknameAgent)).toBe("Role: operator · Dispatch assignment");
    expect(displayAgentName(roleAgent)).toBe("Agent reviewer");
    expect(displayAgentName(blankAgent)).toBe("Agent blank-01");
    expect(normalizeDisplayName("  A\n B\tC  ", "fallback")).toBe("A B C");
    expect(normalizeDisplayName("   ", "Fallback task")).toBe("Fallback task");
    expect(shortOpaqueId("  abc def  ", 4)).toBe("abcdef".slice(-4));
  });

  it("disambiguates duplicate task and agent names deterministically", () => {
    const agents = [
      agent({ id: "alpha-review-root", title: "Review queue", projectId: "alpha" }),
      agent({ id: "beta-review-root", title: "Review queue", projectId: "alpha" }),
      agent({ id: "alpha-reviewer", title: "Reviewer", projectId: "alpha", parentAgentId: "alpha-review-root" }),
      agent({ id: "beta-reviewer", title: "Reviewer", projectId: "alpha", parentAgentId: "alpha-review-root" }),
    ];
    const hierarchy = buildWorldHierarchy(snapshot(agents));
    const tasks = hierarchy.projects[0]?.tasks ?? [];
    const reviewTask = tasks.find((item) => item.id === "alpha-review-root");
    const reviewerNames = reviewTask?.agents.map((item) => item.displayName).filter((name) => name.startsWith("Reviewer")) ?? [];

    expect(tasks).toHaveLength(2);
    expect(tasks.every((item) => item.displayName.startsWith("Review queue · "))).toBe(true);
    expect(new Set(tasks.map((item) => item.displayName)).size).toBe(2);
    expect(new Set(reviewerNames).size).toBe(2);
    expect(reviewerNames.every((name) => name.includes(" · "))).toBe(true);
  });

  it("disambiguates duplicate unresolved task labels deterministically", () => {
    const agents = [
      agent({ id: "missing-a", title: "Task deadbeef", projectId: "alpha" }),
      agent({ id: "missing-b", title: "Task cafebabe", projectId: "alpha" }),
    ];
    const hierarchy = buildWorldHierarchy(snapshot(agents));

    const names = hierarchy.projects[0]?.tasks.map((task) => task.displayName) ?? [];
    expect(names).toEqual(["Unresolved task · issing-a", "Unresolved task · issing-b"]);
    expect(new Set(names).size).toBe(2);
  });

  it("separates explicit human gates from failed and waiting attention", () => {
    const agents = [
      agent({ id: "quest-root", title: "Ship the realm", state: "thinking" }),
      agent({ id: "quest-wait", title: "Waiting scout", parentAgentId: "quest-root", state: "waiting" }),
      agent({ id: "quest-gate", title: "Human gate", parentAgentId: "quest-root", state: "needs-you" }),
      agent({ id: "quest-failed", title: "Failed check", parentAgentId: "quest-root", state: "failed" }),
      agent({ id: "quest-complete", title: "Finished check", parentAgentId: "quest-root", state: "complete" }),
    ];
    const world = snapshot(agents);
    world.attention = ["quest-wait", "quest-gate", "quest-failed"];
    const hierarchy = buildWorldHierarchy(world);
    const task = hierarchy.tasks[0];
    const projectNode = hierarchy.projects[0];

    expect(task).toMatchObject({ activeCount: 1, waitingCount: 1, needsYouCount: 1, attentionCount: 3, outcomeCount: 1 });
    expect(projectNode).toMatchObject({ activeCount: 1, waitingCount: 1, needsYouCount: 1, attentionCount: 3, outcomeCount: 1 });
  });
});

describe("navigation helpers", () => {
  it("normalizes invalid project/task targets to the nearest valid ancestor", () => {
    const agents = [agent({ id: "root", title: "Root task", projectId: "alpha" })];
    const hierarchy = buildWorldHierarchy(snapshot(agents));
    const validProject = projectTarget("alpha");
    const validTask = taskTarget("alpha", "root");

    expect(normalizeNavigation(hierarchy, null)).toEqual({ level: "overview" });
    expect(normalizeNavigation(hierarchy, { level: "project", projectId: "missing" })).toEqual({ level: "overview" });
    expect(normalizeNavigation(hierarchy, validProject)).toEqual(validProject);
    expect(normalizeNavigation(hierarchy, { level: "task", projectId: "alpha", taskId: "missing" })).toEqual(validProject);
    expect(normalizeNavigation(hierarchy, validTask)).toEqual(validTask);
    expect(parentNavigation(validTask)).toEqual(validProject);
    expect(parentNavigation(validProject)).toEqual({ level: "overview" });
    expect(parentNavigation({ level: "overview" })).toEqual({ level: "overview" });
  });
});
