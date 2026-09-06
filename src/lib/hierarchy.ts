import type {
  AgentSnapshot,
  AgentState,
  ProjectSnapshot,
  WorldSnapshot,
} from "./contracts";

/**
 * The map has three stable levels.  A task is the root of a thread-spawn
 * tree, not an individual child thread.  Keeping the level in the target
 * makes the back/breadcrumb behaviour independent of the visual renderer.
 */
export type NavigationTarget =
  | { level: "overview" }
  | { level: "project"; projectId: string }
  | { level: "task"; projectId: string; taskId: string };

export interface HierarchyAgent {
  agent: AgentSnapshot;
  displayName: string;
  rootTaskId: string;
  needsAttention: boolean;
}

export interface RootTaskNode {
  id: string;
  projectId: string;
  displayName: string;
  /** The root record is not always in a bounded live snapshot. */
  rootAgentId?: string;
  agents: HierarchyAgent[];
  agentIds: string[];
  activeCount: number;
  waitingCount: number;
  needsYouCount: number;
  attentionCount: number;
  outcomeCount: number;
  stateCounts: Partial<Record<AgentState, number>>;
}

/** Public names used by renderers that treat the hierarchy as a view model. */
export type HierarchyTask = RootTaskNode;

export interface ProjectNode {
  project: ProjectSnapshot;
  displayName: string;
  tasks: RootTaskNode[];
  agents: HierarchyAgent[];
  activeCount: number;
  waitingCount: number;
  needsYouCount: number;
  attentionCount: number;
  outcomeCount: number;
}

export type HierarchyProject = ProjectNode;

export interface WorldHierarchy {
  projects: ProjectNode[];
  /** Flattened convenience index, in project/task/agent display order. */
  tasks: RootTaskNode[];
  agents: HierarchyAgent[];
}

/** States backed by evidence that work is progressing right now. */
export const WORKING_STATES = new Set<AgentState>([
  "thinking",
  "reading",
  "editing",
  "running",
  "delegating",
  "verifying",
]);

/** Live queue states: blocked on another result or on the user. */
export const WAITING_STATES = new Set<AgentState>(["waiting"]);

/** Queue states that indicate a problem or explicit human gate. */
export const ALERT_STATES = new Set<AgentState>(["needs-you", "failed"]);

const FALLBACK_COLORS = ["#57d7d2", "#8b7bd9", "#f3a66b", "#e86f8d", "#5c9dde", "#66bd84"];

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableColor(id: string): string {
  return FALLBACK_COLORS[stableHash(id) % FALLBACK_COLORS.length];
}

function opaqueDisambiguator(value: string, length = 4): string {
  return stableHash(value).toString(36).padStart(length, "0").slice(-Math.max(1, length));
}

/** Return a bounded opaque identifier suitable for a visible fallback label. */
export function shortOpaqueId(value: unknown, length = 8): string {
  if (typeof value !== "string") return "unknown";
  const compact = value.trim().replace(/\s+/g, "");
  return compact ? compact.slice(-Math.max(1, length)) : "unknown";
}

/**
 * Collapse arbitrary whitespace and guarantee a visible label.  This is a
 * display helper, not a privacy boundary: browser-facing values must already
 * have passed the server allowlist/redaction layer.
 */
export function normalizeDisplayName(value: unknown, fallback = "Unnamed task"): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const safeFallback = typeof fallback === "string" ? fallback.replace(/\s+/g, " ").trim() : "";
  return normalized || safeFallback || "Unnamed task";
}

function looksSynthetic(value: string): boolean {
  // The observer uses `Task <opaque id>` when a persisted title is missing or
  // too long.  Treat that shape as metadata, so a role or opaque fallback can
  // provide a useful name instead.
  return /^(?:untitled\s+task|task|thread|agent)(?:\s+|[-_:·#])+(?:id[-_:·#]?)?[a-z0-9]{6,}$/i.test(value);
}

function meaningfulCandidate(value: unknown): string {
  // Keep missing values distinguishable from the public helper's guaranteed
  // fallback.  A generic fallback must not become the name of every record.
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized && /[\p{L}\p{N}]/u.test(normalized) && !looksSynthetic(normalized) ? normalized : "";
}

function meaningfulRole(value: unknown): string {
  const role = meaningfulCandidate(value);
  return /^(?:default|unknown|none|agent)$/i.test(role) ? "" : role;
}

function uniqueDisplayNames<T>(
  items: T[],
  nameFor: (item: T) => string,
  idFor: (item: T) => string,
): Map<T, string> {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const name = nameFor(item);
    const key = name.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const usedCandidates = new Map<string, number>();
  return new Map(items.map((item) => {
    const name = nameFor(item);
    const count = counts.get(name.toLocaleLowerCase()) ?? 0;
    if (count <= 1) return [item, name];

    const candidate = `${name} · ${opaqueDisambiguator(idFor(item), 4)}`;
    const candidateKey = candidate.toLocaleLowerCase();
    const occurrence = usedCandidates.get(candidateKey) ?? 0;
    usedCandidates.set(candidateKey, occurrence + 1);
    return [item, occurrence === 0 ? candidate : `${candidate} · ${occurrence + 1}`];
  }));
}

function agentBaseName(agent: AgentSnapshot): string {
  const nickname = meaningfulCandidate(agent.nickname);
  if (nickname) return /^agent\b/i.test(nickname) ? nickname : `Agent ${nickname}`;
  return meaningfulCandidate(agent.title)
    || meaningfulCandidate(agent.assignment)
    || (meaningfulRole(agent.role) ? `Agent ${meaningfulRole(agent.role)}` : "")
    || `Agent ${shortOpaqueId(agent.id)}`;
}

/** Return the best stable visible name for one agent/task record. */
export function displayAgentName(agent: AgentSnapshot): string {
  return agentBaseName(agent);
}

/** Explain a generated agent identity without promoting its assignment to its name. */
export function displayAgentDescriptor(agent: AgentSnapshot): string {
  const role = meaningfulRole(agent.role);
  const assignment = meaningfulCandidate(agent.assignment);
  const title = meaningfulCandidate(agent.title);
  const displayName = agentBaseName(agent).toLocaleLowerCase();
  const parts = [
    role ? `Role: ${role}` : "",
    assignment && assignment.toLocaleLowerCase() !== displayName ? assignment : "",
    !assignment && title && title.toLocaleLowerCase() !== displayName ? title : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function rootTaskBaseName(rootId: string, rootAgent: AgentSnapshot | undefined): string {
  // A task is named by its root record.  Child-agent nicknames and roles are
  // intentionally not promoted to the task level because they describe the
  // worker, not the user-visible task being tracked.
  const title = meaningfulCandidate(rootAgent?.title);
  if (title) return title;
  const suffix = shortOpaqueId(rootAgent?.id ?? rootId);
  return rootAgent
    ? `Unresolved task · ${suffix}`
    : `Parent task outside snapshot · ${suffix}`;
}

function compareNamed<T extends { displayName: string }>(left: T, right: T, leftId: string, rightId: string): number {
  return left.displayName.localeCompare(right.displayName) || leftId.localeCompare(rightId);
}

function resolveRootId(agent: AgentSnapshot, byId: Map<string, AgentSnapshot>): string {
  let cursor = agent;
  let rootId = agent.id;
  const seen = new Set<string>();

  while (cursor.parentAgentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parentId = cursor.parentAgentId;
    const parent = byId.get(parentId);
    // If the parent fell outside the bounded snapshot, retain its opaque ID so
    // siblings still share one task neighborhood.  A known cross-project
    // parent is not allowed to pull an agent into another project.
    if (parent && parent.projectId !== agent.projectId) break;
    rootId = parentId;
    if (!parent) break;
    cursor = parent;
  }

  return rootId;
}

function projectRecord(project: ProjectSnapshot, members: AgentSnapshot[]): ProjectSnapshot {
  if (members.length === 0) return project;
  // Derive this from the records that actually reached the current snapshot.
  // The observer is bounded, and a stale project.agentIds list must not make a
  // zoom level claim that an omitted agent is present.
  return { ...project, agentIds: members.map((agent) => agent.id) };
}

function makeSyntheticProject(id: string, members: AgentSnapshot[], index: number): ProjectSnapshot {
  const name = normalizeDisplayName(members[0]?.projectName, "Unassigned");
  return {
    id,
    name,
    color: stableColor(id || `unassigned-${index}`),
    agentIds: members.map((agent) => agent.id),
    activeCount: members.filter((agent) => WORKING_STATES.has(agent.state)).length,
    attentionCount: 0,
  };
}

/**
 * Build the semantic hierarchy consumed by every zoom level.  The function is
 * pure and never mutates the snapshot or agent records, which keeps it safe to
 * run on every live SSE update.
 */
export function buildWorldHierarchy(snapshot: WorldSnapshot): WorldHierarchy {
  const byId = new Map<string, AgentSnapshot>();
  snapshot.agents.forEach((agent) => {
    if (!byId.has(agent.id)) byId.set(agent.id, agent);
  });

  const membersByProject = new Map<string, AgentSnapshot[]>();
  snapshot.agents.forEach((agent) => {
    const members = membersByProject.get(agent.projectId) ?? [];
    members.push(agent);
    membersByProject.set(agent.projectId, members);
  });

  const projectRecords = snapshot.projects.map((project) => ({
    project,
    members: membersByProject.get(project.id) ?? [],
  }));
  const knownProjectIds = new Set(snapshot.projects.map((project) => project.id));
  let syntheticIndex = 0;
  membersByProject.forEach((members, projectId) => {
    if (knownProjectIds.has(projectId)) return;
    projectRecords.push({
      project: makeSyntheticProject(projectId, members, syntheticIndex),
      members,
    });
    syntheticIndex += 1;
  });

  const projects = projectRecords.map(({ project: rawProject, members }) => {
    const project = projectRecord(rawProject, members);
    const groups = new Map<string, AgentSnapshot[]>();
    members.forEach((agent) => {
      const rootId = resolveRootId(agent, byId);
      const group = groups.get(rootId) ?? [];
      group.push(agent);
      groups.set(rootId, group);
    });

    const rawTasks = [...groups.entries()].map(([id, taskMembers]) => {
      const rootAgent = taskMembers.find((agent) => agent.id === id);
      const baseName = rootTaskBaseName(id, rootAgent);
      return { id, taskMembers, rootAgent, baseName };
    });
    const taskNames = uniqueDisplayNames(rawTasks, (task) => task.baseName, (task) => task.id);

    const tasks = rawTasks.map((rawTask): RootTaskNode => {
      const rawAgents = rawTask.taskMembers.map((agent) => ({
        agent,
        baseName: agentBaseName(agent),
      }));
      const agentNames = uniqueDisplayNames(rawAgents, (item) => item.baseName, (item) => item.agent.id);
      const agents = rawAgents.map((item): HierarchyAgent => ({
        agent: item.agent,
        displayName: agentNames.get(item) ?? item.baseName,
        rootTaskId: rawTask.id,
        needsAttention: snapshot.attention.includes(item.agent.id),
      }));
      agents.sort((left, right) => compareNamed(left, right, left.agent.id, right.agent.id));

      const stateCounts: Partial<Record<AgentState, number>> = {};
      agents.forEach(({ agent }) => {
        stateCounts[agent.state] = (stateCounts[agent.state] ?? 0) + 1;
      });
      const activeCount = agents.filter(({ agent }) => WORKING_STATES.has(agent.state)).length;
      const waitingCount = agents.filter(({ agent }) => WAITING_STATES.has(agent.state)).length;
      const attentionCount = agents.filter(({ agent }) => snapshot.attention.includes(agent.id)).length;
      const needsYouCount = agents.filter(({ agent }) => agent.state === "needs-you").length;
      const outcomeCount = agents.filter(({ agent }) => agent.state === "failed" || agent.state === "interrupted").length;
      return {
        id: rawTask.id,
        projectId: project.id,
        displayName: taskNames.get(rawTask) ?? rawTask.baseName,
        rootAgentId: rawTask.rootAgent ? rawTask.rootAgent.id : undefined,
        agents,
        agentIds: agents.map(({ agent }) => agent.id),
        activeCount,
        waitingCount,
        needsYouCount,
        attentionCount,
        outcomeCount,
        stateCounts,
      };
    });
    tasks.sort((left, right) => compareNamed(left, right, left.id, right.id));

    const agents = tasks.flatMap((task) => task.agents);
    const activeCount = agents.filter(({ agent }) => WORKING_STATES.has(agent.state)).length;
    const waitingCount = agents.filter(({ agent }) => WAITING_STATES.has(agent.state)).length;
    const attentionCount = agents.filter(({ agent }) => snapshot.attention.includes(agent.id)).length;
    const needsYouCount = agents.filter(({ agent }) => agent.state === "needs-you").length;
    const outcomeCount = agents.filter(({ agent }) => agent.state === "failed" || agent.state === "interrupted").length;
    return {
      project,
      displayName: normalizeDisplayName(project.name, `Project ${shortOpaqueId(project.id)}`),
      tasks,
      agents,
      activeCount,
      waitingCount,
      needsYouCount,
      attentionCount,
      outcomeCount,
    };
  });

  const projectNames = uniqueDisplayNames(projects, (project) => project.displayName, (project) => project.project.id);
  projects.forEach((project) => {
    project.displayName = projectNames.get(project) ?? project.displayName;
  });

  const tasks = projects.flatMap((project) => project.tasks);
  const agents = projects.flatMap((project) => project.agents);
  return { projects, tasks, agents };
}

/** Short alias for callers that do not need the longer semantic name. */
export const buildHierarchy = buildWorldHierarchy;

export function projectTarget(projectId: string): NavigationTarget {
  return { level: "project", projectId };
}

export function taskTarget(projectId: string, taskId: string): NavigationTarget {
  return { level: "task", projectId, taskId };
}

export function parentNavigation(target: NavigationTarget | null | undefined): NavigationTarget {
  if (!target || target.level === "overview") return { level: "overview" };
  if (target.level === "project") return { level: "overview" };
  return projectTarget(target.projectId);
}

export function normalizeNavigation(
  hierarchy: WorldHierarchy,
  target: NavigationTarget | null | undefined,
): NavigationTarget {
  if (!target || target.level === "overview") return { level: "overview" };
  const project = hierarchy.projects.find((candidate) => candidate.project.id === target.projectId);
  if (!project) return { level: "overview" };
  if (target.level === "project") return projectTarget(project.project.id);
  return project.tasks.some((task) => task.id === target.taskId)
    ? taskTarget(project.project.id, target.taskId)
    : projectTarget(project.project.id);
}

export function projectForNavigation(
  hierarchy: WorldHierarchy,
  target: NavigationTarget | null | undefined,
): ProjectNode | null {
  if (!target || target.level === "overview") return null;
  return hierarchy.projects.find((project) => project.project.id === target.projectId) ?? null;
}

export function taskForNavigation(
  hierarchy: WorldHierarchy,
  target: NavigationTarget | null | undefined,
): RootTaskNode | null {
  if (!target || target.level !== "task") return null;
  return hierarchy.projects.find((project) => project.project.id === target.projectId)?.tasks.find((task) => task.id === target.taskId) ?? null;
}
