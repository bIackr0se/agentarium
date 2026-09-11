import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  buildWorldHierarchy,
  displayAgentDescriptor,
  parentNavigation,
  projectForNavigation,
  projectTarget,
  shortOpaqueId,
  taskForNavigation,
  taskTarget,
  WAITING_STATES,
  WORKING_STATES,
} from "../lib/hierarchy";
import type {
  HierarchyAgent,
  HierarchyProject,
  HierarchyTask,
  NavigationTarget,
  WorldHierarchy,
} from "../lib/hierarchy";
import type { AgentState, WorldSnapshot } from "../lib/contracts";
import { evidenceForCurrentState } from "../lib/evidence";
import { islandRoute, routeStyle } from "../lib/island-routes";
import { SourceSetup } from "./SourceSetup";
import { agentObservedAtCutoff, buildMissionWorld, missionForTask, projectSnapshotAtCutoff } from "../lib/missions";
import type { Mission, MissionWorld } from "../lib/missions";
import { IslandArt, Robot } from "./WorldArt";
import { WorldIcon, type WorldIconName } from "./WorldIcon";

export interface ArchipelagoProps {
  snapshot: WorldSnapshot;
  selectedId?: string;
  onSelect: (id: string) => void;
  replayCutoff: number;
  navigation: NavigationTarget;
  onNavigate: (target: NavigationTarget) => void;
  evidenceLensOn?: boolean;
  onEvidenceLensChange?: (value: boolean) => void;
  onClearSelection?: () => void;
  onOpenInspector?: () => void;
  emptyState?: WorldEmptyState;
  /** Full-snapshot mission projection. Filters may trim the rendered map. */
  missionWorld?: MissionWorld;
  /** IDs that actually matched the active view. Retained parent records are context only. */
  visibleAgentIds?: readonly string[];
  /** Compact launch controls owned by the shell but placed with the world controls. */
  utilityControls?: ReactNode;
}

export type WorldEmptyStateKind = "unconfigured" | "stopped" | "unavailable" | "empty" | "filtered" | "snapshot";

export interface WorldEmptyAction {
  label: string;
  ariaLabel?: string;
  onClick: () => void;
}

export interface WorldConnectionOption {
  id?: "codex" | "json" | "jsonl";
  label: string;
  description: string;
  command: string;
  validationCommand?: string;
}

export interface WorldEmptyState {
  kind: WorldEmptyStateKind;
  eyebrow: string;
  title: string;
  description: string;
  detail?: string;
  sourceSummary?: string;
  connectionOptions?: readonly WorldConnectionOption[];
  connectionNote?: string;
  primaryAction?: WorldEmptyAction;
  secondaryAction?: WorldEmptyAction;
}

type AccentStyle = CSSProperties & {
  "--accent"?: string;
  "--seed"?: string;
  "--district-index"?: number;
  "--agent-index"?: number;
};

export type WorldTimePhase = "dawn" | "day" | "dusk" | "night";

/** Resolve the world clock without mutating the URL or depending on a harness. */
export function worldHour(search = typeof window === "undefined" ? "" : window.location.search): number {
  const raw = new URLSearchParams(search).get("hour");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : new Date().getHours();
}

export function worldTimePhase(hour: number): WorldTimePhase {
  const bounded = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.trunc(hour))) : 12;
  if (bounded >= 5 && bounded < 8) return "dawn";
  if (bounded >= 8 && bounded < 17) return "day";
  if (bounded >= 17 && bounded < 21) return "dusk";
  return "night";
}

const STATE_META: Record<AgentState, { label: string; glyph: WorldIconName; prop: "book" | "tools" | "mail" | "well" }> = {
  thinking: { label: "Thinking", glyph: "dots", prop: "book" },
  reading: { label: "Reading", glyph: "book", prop: "book" },
  editing: { label: "Editing", glyph: "edit", prop: "tools" },
  running: { label: "Running", glyph: "play", prop: "tools" },
  delegating: { label: "Delegating", glyph: "open", prop: "mail" },
  waiting: { label: "Waiting", glyph: "pause", prop: "well" },
  "needs-you": { label: "Needs you", glyph: "alert", prop: "mail" },
  verifying: { label: "Verifying", glyph: "check", prop: "book" },
  failed: { label: "Run failed", glyph: "close", prop: "tools" },
  complete: { label: "Complete", glyph: "check", prop: "mail" },
  interrupted: { label: "Last run stopped", glyph: "pause", prop: "mail" },
  idle: { label: "Idle", glyph: "dots", prop: "well" },
  stale: { label: "Stale", glyph: "clock", prop: "mail" },
  unknown: { label: "Evidence unavailable", glyph: "dots", prop: "well" },
};

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function plural(value: number, singular: string, multiple = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : multiple}`;
}

function needsYouSummary(value: number): string {
  return `${value} ${value === 1 ? "needs" : "need"} you`;
}

function recomputeTaskView(task: HierarchyTask, agents: HierarchyAgent[]): HierarchyTask {
  const stateCounts: Partial<Record<AgentState, number>> = {};
  agents.forEach(({ agent }) => {
    stateCounts[agent.state] = (stateCounts[agent.state] ?? 0) + 1;
  });
  return {
    ...task,
    agents,
    agentIds: agents.map(({ agent }) => agent.id),
    activeCount: agents.filter(({ agent }) => WORKING_STATES.has(agent.state)).length,
    waitingCount: agents.filter(({ agent }) => WAITING_STATES.has(agent.state)).length,
    needsYouCount: agents.filter(({ agent }) => agent.state === "needs-you").length,
    attentionCount: agents.filter(({ needsAttention }) => needsAttention).length,
    outcomeCount: agents.filter(({ agent }) => agent.state === "failed" || agent.state === "interrupted").length,
    stateCounts,
  };
}

/**
 * Project the already-resolved hierarchy onto the active filter.  The source
 * hierarchy may include retained parents so a child can inherit its canonical
 * task name, but those records must not inflate the rendered map or roster.
 */
function filterRenderedHierarchy(hierarchy: WorldHierarchy, visibleAgentIds: readonly string[]): WorldHierarchy {
  const visibleIds = new Set(visibleAgentIds);
  const projects = hierarchy.projects.flatMap((project): HierarchyProject[] => {
    const tasks = project.tasks
      .map((task) => {
        const agents = task.agents.filter((item) => visibleIds.has(item.agent.id));
        return agents.length > 0 ? recomputeTaskView(task, agents) : null;
      })
      .filter((task): task is HierarchyTask => Boolean(task));
    if (tasks.length === 0) return [];

    const agents = tasks.flatMap((task) => task.agents);
    return [{
      ...project,
      project: { ...project.project, agentIds: agents.map(({ agent }) => agent.id) },
      tasks,
      agents,
      activeCount: agents.filter(({ agent }) => WORKING_STATES.has(agent.state)).length,
      waitingCount: agents.filter(({ agent }) => WAITING_STATES.has(agent.state)).length,
      needsYouCount: agents.filter(({ agent }) => agent.state === "needs-you").length,
      attentionCount: agents.filter(({ needsAttention }) => needsAttention).length,
      outcomeCount: agents.filter(({ agent }) => agent.state === "failed" || agent.state === "interrupted").length,
    }];
  });
  return {
    projects,
    tasks: projects.flatMap((project) => project.tasks),
    agents: projects.flatMap((project) => project.agents),
  };
}

function stateSummary(task: HierarchyTask): string {
  if (task.needsYouCount > 0) return plural(task.needsYouCount, "agent needs you", "agents need you");
  if (task.waitingCount > 0) return plural(task.waitingCount, "agent waiting", "agents waiting");
  if (task.activeCount > 0) {
    const active = plural(task.activeCount, "agent working", "agents working");
    return task.outcomeCount > 0 ? `${active}; ${plural(task.outcomeCount, "earlier stopped attempt")}` : active;
  }
  if (task.outcomeCount > 0) return `${plural(task.outcomeCount, "stopped attempt")} recorded`;
  return "All agents are quiet";
}

function stateSummaryShort(task: HierarchyTask): string {
  if (task.needsYouCount > 0) return `${task.needsYouCount} need${task.needsYouCount === 1 ? "s" : ""} you`;
  if (task.waitingCount > 0) return `${task.waitingCount} waiting`;
  if (task.activeCount > 0) return task.outcomeCount > 0 ? `${task.activeCount} working · ${task.outcomeCount} past stop${task.outcomeCount === 1 ? "" : "s"}` : `${task.activeCount} working`;
  if (task.outcomeCount > 0) return `${task.outcomeCount} past stop${task.outcomeCount === 1 ? "" : "s"}`;
  return "quiet";
}

function sourceLabel(snapshot: WorldSnapshot): string {
  if (snapshot.mode === "demo") return "Demo";
  const candidate = (snapshot as WorldSnapshot & { sourceLabel?: unknown }).sourceLabel;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return "Live snapshot";
}

function projectLayoutIntent(projectCount: number): string {
  if (projectCount <= 1) return "single";
  if (projectCount === 2) return "pair";
  if (projectCount === 3) return "trio";
  if (projectCount === 4) return "sculpted-landscape";
  if (projectCount === 5) return "three-two";
  if (projectCount === 6) return "three-three";
  return "dense";
}

function missionPhase(mission: Mission | null | undefined): string {
  return mission?.phase ?? "unknown";
}

function missionPhaseLabel(mission: Mission | null | undefined): string {
  return mission?.phaseLabel ?? "Evidence unavailable";
}

function missionEvolution(mission: Mission | null | undefined): "verified-complete" | "unchanged" {
  return mission?.evolution.verified ? "verified-complete" : "unchanged";
}

function CountStrip({ active, waiting, needsYou, total }: {
  active: number;
  waiting?: number;
  needsYou: number;
  total: number;
}) {
  return (
    <dl className="count-strip" aria-label="Status summary">
      <div><dt>Agents</dt><dd>{total}</dd></div>
      <div><dt>Working</dt><dd>{active}</dd></div>
      <div className={waiting ? "has-waiting" : undefined}><dt>Waiting</dt><dd>{waiting ?? 0}</dd></div>
      <div className={needsYou ? "has-attention" : undefined}><dt>Needs you</dt><dd>{needsYou}</dd></div>
    </dl>
  );
}

function ScopeStrip({ projects, tasks, agents }: { projects: number; tasks: number; agents: number }) {
  return (
    <dl
      className="scope-strip"
      aria-label="World scope"
      data-overview-scope="true"
      data-project-count={projects}
      data-task-count={tasks}
      data-agent-count={agents}
    >
      <div><dt>Projects</dt><dd>{projects}</dd></div>
      <div><dt>Tasks</dt><dd>{tasks}</dd></div>
      <div><dt>Agents</dt><dd>{agents}</dd></div>
    </dl>
  );
}

function VerifiedSettlementGrowth({ scale }: { seed: number; scale: "project" | "district" | "village" }) {
  return (
    <span
      className={`settlement-growth settlement-growth--${scale}`}
      data-world-growth="verified-completion"
      aria-hidden="true"
    >
      <span className="settlement-growth__label">VERIFIED</span>
    </span>
  );
}

function TaskButton({ project, task, mission, mode, onNavigate }: {
  project: HierarchyProject;
  task: HierarchyTask;
  mission?: Mission | null;
  mode: WorldSnapshot["mode"];
  onNavigate: (target: NavigationTarget) => void;
}) {
  return (
    <button
      type="button"
      className="task-index-row"
      data-task-id={task.id}
      data-mission-phase={missionPhase(mission)}
      data-world-evolution={missionEvolution(mission)}
      onClick={() => onNavigate(taskTarget(project.project.id, task.id))}
      aria-label={`Open task ${task.displayName}, ${plural(task.agents.length, "agent")}`}
    >
      <span className="task-index-row__marker" style={{ background: project.project.color }} aria-hidden="true" />
      <span className="task-index-row__copy">
        <span className="task-index-row__context">Task · {missionPhaseLabel(mission)}</span>
        <strong>{task.displayName}</strong>
        <small>{stateSummaryShort(task)} · {plural(task.agents.length, "agent")}</small>
      </span>
      <span className="task-index-row__count">{task.agents.length}</span>
      <span className="task-index-row__arrow" aria-hidden="true">→</span>
    </button>
  );
}

function IslandCrew({ agents }: { agents: HierarchyAgent[] }) {
  const working = agents.filter(item => WORKING_STATES.has(item.agent.state));
  const preview = working.length ? working.slice(0, 3) : agents.slice(0, 1);
  return <span className="island-crew" aria-hidden="true">{preview.map((item, index) => (
    <span key={item.agent.id} className="island-route-carrier" style={{ "--agent-index": index } as AccentStyle}
      data-project-agent-state={item.agent.state}
      data-route-state={WORKING_STATES.has(item.agent.state) ? "commuting" : WAITING_STATES.has(item.agent.state) || item.agent.state === "needs-you" ? "work" : "home"}>
      <Robot className="island-crew__robot" variant={index} />
    </span>
  ))}</span>;
}

function ReferenceProject({ project, slot, missionWorld, onNavigate }: { project: HierarchyProject; slot: number; missionWorld: MissionWorld; onNavigate: (target: NavigationTarget) => void }) {
  const scene = [2, 1, 0][slot];
  const complete = missionWorld.projects.find(item => item.id === project.project.id)?.missions.some(item => item.evolution.verified);
  const status = project.needsYouCount ? "Waiting for you" : project.activeCount ? plural(project.activeCount, "agent working", "agents working") : complete ? "Complete" : project.waitingCount ? "Waiting on agent" : "Quiet";
  return <div className={`reference-project reference-project--${slot}`} data-project-id={project.project.id} data-project-island="true" data-world-evolution={complete ? "verified-complete" : "unchanged"} style={routeStyle(islandRoute(scene), true)}>
    <IslandCrew agents={project.agents} />
    <button type="button" className="reference-project__label" data-project-hit-target="true" data-project-info-plate="true" title={project.displayName} aria-label={`Open project ${project.displayName}`} onClick={() => onNavigate(projectTarget(project.project.id))}>
      <i className={`activity-dot${project.needsYouCount || project.waitingCount ? " activity-dot--waiting" : ""}`} aria-hidden="true" />
      <span className="project-card__identity"><strong>{project.displayName}</strong><small>{status}</small></span>
      <WorldIcon name="open" />
    </button>
  </div>;
}

function ProjectCard({ project, index, mode, missionWorld, onNavigate }: {
  project: HierarchyProject;
  index: number;
  mode: WorldSnapshot["mode"];
  missionWorld: MissionWorld;
  onNavigate: (target: NavigationTarget) => void;
}) {
  const seed = stableHash(project.project.id);
  const missionProject = missionWorld.projects.find((item) => item.id === project.project.id);
  const verifiedComplete = Boolean(missionProject?.missions.some((mission) => mission.evolution.verified));
  return (
    <article
      className="project-card realm-project"
      data-project-id={project.project.id}
      data-project-island="true"
      data-world-evolution={verifiedComplete ? "verified-complete" : "unchanged"}
      style={{ "--accent": project.project.color, "--seed": `${seed % 9}` } as AccentStyle}
    >
      <div className="realm-project__terrain island-plane" style={routeStyle(islandRoute(index))}>
        <IslandArt variant={index} />

        <span className="realm-project__lake" aria-hidden="true" />
        <span className="realm-project__trail" aria-hidden="true" />
        {verifiedComplete ? <VerifiedSettlementGrowth seed={seed} scale="project" /> : null}
        <IslandCrew agents={project.agents} />
        <button
          type="button"
          className="project-card__hero realm-project__portal"
          data-project-hit-target="true"
          onClick={() => onNavigate(projectTarget(project.project.id))}
          aria-label={`Open project ${project.displayName}`}
        >
          <span className="realm-project__crest" aria-hidden="true">

            <span className="realm-project__flag" style={{ background: project.project.color }} />
          </span>
          <span className="project-card__plate" data-project-info-plate="true">
            <span className="project-card__identity">
              <span className="project-card__eyebrow">Project {String(index + 1).padStart(2, "0")}</span>
              <strong>{project.displayName}</strong>
              <small>{plural(project.tasks.length, "task")} · {plural(project.agents.length, "agent")}</small>
              <span className="project-card__statusline">
                <span>{project.activeCount} working</span>
                <span className={project.waitingCount ? "has-waiting" : undefined}>{project.waitingCount} waiting</span>
                <span className={project.needsYouCount ? "has-attention" : undefined}>{needsYouSummary(project.needsYouCount)}</span>
              </span>
              {missionProject?.completeCount ? (
                <span className="project-card__verified">{plural(missionProject.completeCount, "verified task")}</span>
              ) : null}
            </span>
            <span className="project-card__open" aria-hidden="true"><span className="project-card__open-label">Open project</span><WorldIcon name="open" /></span>
          </span>
        </button>
        <div className="realm-project__beacon-row" aria-hidden="true">
          {project.tasks.map((task, taskIndex) => {
            const mission = missionForTask(missionWorld, project.project.id, task.id);
            return (
            <span
              key={task.id}
              className={`realm-beacon realm-beacon--${taskIndex % 4}${mission?.evolution.verified ? " is-verified" : ""}`}
              data-mission-phase={missionPhase(mission)}
              data-world-evolution={missionEvolution(mission)}
            >
              <span className="realm-beacon__light" />
            </span>
            );
          })}
        </div>
      </div>
      <div className="project-card__tasks" aria-label={`Tasks in ${project.displayName}`}>
        {project.tasks.map((task) => (
          <TaskButton
            key={task.id}
            project={project}
            task={task}
            mission={missionForTask(missionWorld, project.project.id, task.id)}
            mode={mode}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </article>
  );
}

function OverviewScene({ hierarchy, mode, missionWorld, onNavigate }: {
  hierarchy: WorldHierarchy;
  mode: WorldSnapshot["mode"];
  missionWorld: MissionWorld;
  onNavigate: (target: NavigationTarget) => void;
}) {
  const mapProjects = hierarchy.projects;
  const totalAgents = hierarchy.agents.length;
  const totalTasks = hierarchy.tasks.length;
  const active = hierarchy.projects.reduce((sum, project) => sum + project.activeCount, 0);
  const waiting = hierarchy.projects.reduce((sum, project) => sum + project.waitingCount, 0);
  const needsYou = hierarchy.projects.reduce((sum, project) => sum + project.needsYouCount, 0);
  const visibleMissions = hierarchy.projects.flatMap((project) => project.tasks
    .map((task) => missionForTask(missionWorld, project.project.id, task.id))
    .filter((mission): mission is Mission => Boolean(mission)));
  const decisionMission = visibleMissions.find((mission) => mission.requiresHumanDecision);
  const nextMission = decisionMission
    ?? visibleMissions.find((mission) => mission.activeCount > 0)
    ?? visibleMissions[0];
  const hasDecision = Boolean(decisionMission);
  return (
    <section className="zoom-scene zoom-scene--overview" aria-labelledby="overview-title">
      <div className="realm-map realm-map--overview" data-project-count={hierarchy.projects.length} data-project-layout={projectLayoutIntent(hierarchy.projects.length)}>
        <div className="realm-map__sky" aria-hidden="true" />
        <div className="realm-map__sun" aria-hidden="true" />
        <div className="realm-map__horizon" aria-hidden="true" />
        <header className="scene-heading overview-map__hud" data-overview-hud="true">
          <div>
            <span className="scene-heading__eyebrow">SUPERVISION MAP{mode === "live" ? " · LIVE" : ""}</span>
            <h2 id="overview-title">Your team, in view.</h2>
            <p>Projects become places. Know what needs you.</p>
          </div>
          <aside className="overview-summary" aria-label="Team overview">
            <h3>{hasDecision ? "Needs you" : "All in view"}</h3>
            <ScopeStrip projects={hierarchy.projects.length} tasks={totalTasks} agents={totalAgents} />
            <p className="overview-summary__state">{active} working · {waiting} waiting · {needsYouSummary(needsYou)}</p>
            {nextMission ? (
              <button
                type="button"
                className="overview-summary__action"
                aria-label={`${hasDecision ? "Review" : "Open"} task ${nextMission.displayName} in map`}
                onClick={() => onNavigate(taskTarget(nextMission.projectId, nextMission.taskId))}
              >
                <span className="overview-summary__action-copy">
                  <small>{hasDecision ? "Needs your review" : nextMission.activeCount > 0 ? "Active now" : "Latest task"}</small>
                  <strong>{nextMission.displayName}</strong>
                  <span className="overview-summary__action-project">{nextMission.projectName} · {nextMission.phaseLabel}</span>
                  {nextMission.decision ? (
                    <span className="overview-summary__action-reason">{nextMission.decision.reason}</span>
                  ) : null}
                </span>
                <span className="overview-summary__action-meta">
                  <span>{evidenceLabels[nextMission.evidence.strength]} evidence · {nextMission.evidence.freshness === "unknown" ? "freshness unavailable" : nextMission.evidence.freshness}</span>
                  <strong>
                    <span className="overview-summary__action-label overview-summary__action-label--long">{hasDecision ? "Review task" : "Open task"}</span>
                    <span className="overview-summary__action-label overview-summary__action-label--short">{hasDecision ? "Review" : "Open"}</span>
                    {" "}<WorldIcon name="arrow" />
                  </strong>
                </span>
              </button>
            ) : null}
            <section className="team-activity" aria-label="Team activity">
              <h3>Team activity</h3>
              {hierarchy.agents.slice(0, 4).map((item, index) => (
                <button key={item.agent.id} type="button" onClick={() => onNavigate(taskTarget(item.agent.projectId, item.rootTaskId))} aria-label={`Open task for ${item.displayName}`}>
                  <Robot variant={index} />
                  <span><strong>{item.displayName}</strong><small>{STATE_META[item.agent.state].label}</small></span>
                  <i className={`activity-dot activity-dot--${item.agent.state}`} aria-hidden="true" />
                </button>
              ))}
            </section>
            <p className="world-local-note">Local and read-only</p>
          </aside>
        </header>
        <div className="reference-world" aria-label="Project islands">
          <img className="reference-world__plate" src="/assets/sculpted/harbor-world.webp" width="1536" height="1024" alt="" aria-hidden="true" />
          {mapProjects.slice(0, 3).map((project, slot) => <ReferenceProject key={project.project.id} project={project} slot={slot} missionWorld={missionWorld} onNavigate={onNavigate} />)}
        </div>
        {mapProjects.length > 3 ? <section className="reference-more" aria-label="More projects"><h3>More projects</h3><div className="realm-map__islands">
          {mapProjects.slice(3).map((project, index) => <ProjectCard key={project.project.id} project={project} index={index} mode={mode} missionWorld={missionWorld} onNavigate={onNavigate} />)}
        </div></section> : null}

      </div>
    </section>
  );
}

function TaskDistrictCard({ project, task, mission, index, mode, onNavigate }: {
  project: HierarchyProject;
  task: HierarchyTask;
  mission?: Mission | null;
  index: number;
  mode: WorldSnapshot["mode"];
  onNavigate: (target: NavigationTarget) => void;
}) {
  const seed = stableHash(task.id);
  const visibleAgents = task.agents.slice(0, 5);
  const status = task.needsYouCount > 0 ? "alert" : task.waitingCount > 0 ? "waiting" : task.activeCount > 0 ? "working" : "quiet";
  return (
    <button
      type="button"
      className={`district-card district-card--${status}`}
      data-task-id={task.id}
      data-task-count={project.tasks.length}
      data-mission-phase={missionPhase(mission)}
      data-world-evolution={missionEvolution(mission)}
      style={{ "--accent": project.project.color, "--seed": `${seed % 9}`, "--district-index": index } as AccentStyle}
      onClick={() => onNavigate(taskTarget(project.project.id, task.id))}
      aria-label={`Open task ${task.displayName}`}
    >
      <span className="district-card__terrain island-plane" style={routeStyle(islandRoute(index))} aria-hidden="true">
        <IslandArt variant={index} />
        <span className="district-card__road" />
        <span className="district-card__completion-bridge" />
        {mission?.evolution.verified ? <VerifiedSettlementGrowth seed={seed} scale="district" /> : null}


        <span className="district-card__house"></span>
        <span className="district-card__terrain-label district-card__terrain-label--home">HOME BASE</span>
        <span className="district-card__workspot"><span>WORK</span></span>
        <IslandCrew agents={visibleAgents} />
      </span>
      <span className="district-card__info-plate" data-task-info-plate="true">
        <span className="district-card__topline">
          <span className="district-card__number">TASK {String(index + 1).padStart(2, "0")}</span>
          <span className="district-card__signal">{missionPhaseLabel(mission)}</span>
        </span>
        <span className="district-card__copy">
          <span className="district-card__context">Task</span>
          <strong>{task.displayName}</strong>
          <small>{plural(task.agents.length, "agent")} · {stateSummary(task)}</small>
          {mission?.evolution.verified ? <span className="district-card__verified">Completion verified</span> : null}
        </span>
        <span className="district-card__action">Open task <WorldIcon name="arrow" /></span>
      </span>
    </button>
  );
}

function ProjectScene({ project, mode, missionWorld, onNavigate }: {
  project: HierarchyProject;
  mode: WorldSnapshot["mode"];
  missionWorld: MissionWorld;
  onNavigate: (target: NavigationTarget) => void;
}) {
  return (
    <section className="zoom-scene zoom-scene--project" aria-labelledby="project-title">
      <header className="project-hero">
        <div className="project-hero__copy">
          <h2 id="project-title">{project.displayName}</h2>
          <p>{plural(project.tasks.length, "task")} · Select a task to follow its agents.</p>
        </div>
        <CountStrip active={project.activeCount} waiting={project.waitingCount} needsYou={project.needsYouCount} total={project.agents.length} />
      </header>
      <div className="project-map" data-project-id={project.project.id} data-task-count={project.tasks.length} data-task-layout={project.tasks.length === 1 ? "single-hero" : "multi-grid"}>
        <div className="project-map__water" aria-hidden="true" />
        <div className="project-map__terrain">

          <div className="project-map__plaza" aria-hidden="true"><span>PROJECT HUB</span></div>
          <div className="project-map__road project-map__road--vertical" aria-hidden="true" />
          <div className="project-map__road project-map__road--horizontal" aria-hidden="true" />
          <div className="district-grid" aria-label={`Tasks in ${project.displayName}`}>
            {project.tasks.map((task, index) => (
              <TaskDistrictCard
                key={task.id}
                project={project}
                task={task}
                mission={missionForTask(missionWorld, project.project.id, task.id)}
                index={index}
                mode={mode}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>

      </div>
    </section>
  );
}

type AgentKind = "Lead" | "Helper" | "Agent";

function agentKind(task: HierarchyTask, item: HierarchyAgent): AgentKind {
  if (!task.rootAgentId) return "Agent";
  return item.agent.id === task.rootAgentId ? "Lead" : "Helper";
}

function agentRailDetail(task: HierarchyTask, item: HierarchyAgent): string {
  const kind = agentKind(task, item);
  const state = STATE_META[item.agent.state].label;
  const descriptor = displayAgentDescriptor(item.agent);
  return descriptor ? `${kind} · ${state} · ${descriptor}` : `${kind} · ${state}`;
}

function AgentLot({ item, kind, agentIndex, selected, replayCutoff, onSelect, evidenceLensOn, evidenceSelectionActive, taskRootAgentId }: {
  item: HierarchyAgent;
  kind: AgentKind;
  agentIndex: number;
  selected: boolean;
  replayCutoff: number;
  onSelect: (id: string) => void;
  evidenceLensOn: boolean;
  evidenceSelectionActive: boolean;
  taskRootAgentId?: string;
}) {
  const route = islandRoute(agentIndex);
  const { agent } = item;
  const meta = STATE_META[agent.state];
  const future = !agentObservedAtCutoff(agent, replayCutoff);
  const active = WORKING_STATES.has(agent.state);
  const waiting = WAITING_STATES.has(agent.state);
  const attention = item.needsAttention && agent.state !== "waiting";
  const seed = stableHash(agent.id);
  const subtitle = agent.role?.trim() || meta.label;
  const routeState = active ? "commuting" : waiting || attention ? "work" : "home";
  const lensSelected = evidenceLensOn && selected;
  const lensPath = evidenceLensOn && evidenceSelectionActive && taskRootAgentId === agent.id;
  const lensDimmed = evidenceLensOn && evidenceSelectionActive && !lensSelected && !lensPath;
  return (
    <article
      className={`agent-lot${active ? " is-active" : ""}${waiting ? " is-waiting" : ""}${attention ? " is-attention" : ""}${selected ? " is-selected" : ""}${future ? " is-future" : ""}${lensSelected ? " is-lens-selected" : ""}${lensPath ? " is-lens-path" : ""}${lensDimmed ? " is-lens-dimmed" : ""}`}
      data-agent-id={agent.id}
      data-agent-index={agentIndex}
      data-agent-state={agent.state}
      data-agent-kind={kind}
      data-evidence-focus={lensSelected ? "selected" : lensPath ? "path" : lensDimmed ? "dimmed" : undefined}
      data-route-state={routeState}
      style={{ "--seed": `${seed % 7}`, "--agent-index": agentIndex } as AccentStyle}
    >
      <div className="island-plane agent-lot__stage" style={routeStyle(route)} data-island-variant={agentIndex % 3}>
      <IslandArt variant={agentIndex} className="agent-lot__art" />
      <span className="agent-lot__path" aria-hidden="true" />
      <div className="agent-home" aria-hidden="true">

        <span className="agent-route-anchor agent-route-anchor--home" data-route-anchor="home" />
      </div>
      <div className="agent-workspot" aria-hidden="true">

        <span>WORK</span>
        <span className="agent-route-anchor agent-route-anchor--work" data-route-anchor="work" />
      </div>
      <div className="island-route-carrier" data-route-state={routeState}>
      <button
        type="button"
        className="agent-villager"
        data-commute={routeState}
        disabled={future}
        aria-label={`${item.displayName}, ${meta.label}${agent.role?.trim() ? `, role ${agent.role.trim()}` : ""}`}
        aria-pressed={selected}
        onClick={() => onSelect(agent.id)}
      >
        <span className="agent-villager__effect" aria-hidden="true"><WorldIcon name={meta.glyph} /></span>
        <Robot variant={seed} />
      </button>
      </div>
      </div>
      <button type="button" className="agent-villager__nametag" data-agent-nameplate="true" disabled={future} aria-label={`Inspect ${item.displayName}`} aria-pressed={selected} onClick={() => onSelect(agent.id)}>
        <strong>{item.displayName}</strong>
        <small><span className={`activity-dot activity-dot--${agent.state}`} />{meta.label}{subtitle !== meta.label ? ` · ${subtitle}` : ""}</small>
      </button>
      {(agent.state === "complete" || agent.state === "idle") && agent.ageMs >= 5 * 60_000 ? (
        <span className="agent-lot__sleep" aria-hidden="true">Zzz</span>
      ) : null}
    </article>
  );
}

const evidenceLabels = {
  observed: "Observed",
  derived: "Derived",
  unknown: "Unknown",
} as const;

function EvidenceProofCard({ item, replayCutoff }: { item: HierarchyAgent; replayCutoff: number }) {
  const evidence = evidenceForCurrentState(item.agent, replayCutoff);
  const eventLabel = evidence.latestEvent?.label.trim() || "No bounded event";
  return (
    <aside className="evidence-proof-card" data-evidence-proof="true" aria-label="Evidence for current state">
      <div className="evidence-proof-card__heading">
        <span>Evidence for current state</span>
        <strong className={`evidence-proof-card__strength evidence-proof-card__strength--${evidence.strength}`}>
          {evidenceLabels[evidence.strength]}
        </strong>
      </div>
      <strong className="evidence-proof-card__event">{eventLabel}</strong>
      <span>{plural(evidence.boundedEventCount, "bounded event")} at replay position</span>
      <small>Payloads withheld</small>
    </aside>
  );
}

function AgentFocusCard({ item, onClearSelection }: {
  item: HierarchyAgent;
  onClearSelection?: () => void;
}) {
  const meta = STATE_META[item.agent.state];
  return (
    <aside className="agent-focus-card" aria-label={`Selected agent ${item.displayName}`} data-selected-agent-card="true">
      <span className="agent-focus-card__eyebrow">Selected agent</span>
      <strong>{item.displayName}</strong>
      <span>{meta.label}{item.agent.role ? ` · ${item.agent.role}` : ""}</span>
      {onClearSelection ? <button type="button" onClick={onClearSelection}>Clear selection</button> : null}
    </aside>
  );
}

function TaskScene({ project, task, mission, selectedId, replayCutoff, onSelect, onClearSelection, motionEnabled, mode, evidenceLensOn }: {
  project: HierarchyProject;
  task: HierarchyTask;
  mission?: Mission | null;
  mode: WorldSnapshot["mode"];
  selectedId?: string;
  replayCutoff: number;
  onSelect: (id: string) => void;
  onClearSelection?: () => void;
  motionEnabled: boolean;
  evidenceLensOn: boolean;
}) {
  const agentLayout = task.agents.length === 4
    ? "four-grid"
    : task.agents.length === 5
      ? "five-grid"
      : task.agents.length === 6
        ? "six-grid"
        : "adaptive";
  const routeMode = "assigned";
  const selectedAgent = selectedId
    ? task.agents.find((item) => item.agent.id === selectedId && agentObservedAtCutoff(item.agent, replayCutoff))
    : undefined;
  return (
    <section
      className="zoom-scene zoom-scene--task"
      aria-label={`${mode === "demo" ? "Demo task" : "Task"} ${task.displayName}`}
      data-route-mode={routeMode}
      data-evidence-lens={evidenceLensOn ? "on" : "off"}
      data-mission-phase={missionPhase(mission)}
      data-world-evolution={missionEvolution(mission)}
    >
      <div className="task-village-shell">
        <div className="task-village-water" aria-hidden="true" />
        <div
          className="task-village"
          data-task-id={task.id}
          data-agent-count={task.agents.length}
          data-agent-layout={agentLayout}
          data-route-mode={routeMode}
          data-motion-route={motionEnabled ? routeMode : "paused"}
          data-evidence-lens={evidenceLensOn ? "on" : "off"}
          data-mission-phase={missionPhase(mission)}
          data-world-evolution={missionEvolution(mission)}
        >
          <div className="task-village__plaque" style={{ "--accent": project.project.color } as AccentStyle}>
            <h2 id="task-title">{task.displayName}</h2>
            <strong>{missionPhaseLabel(mission)} · {stateSummaryShort(task)} · {plural(task.agents.length, "agent")}</strong>

            {mission?.evolution.verified ? <small className="task-village__verified">Completion verified</small> : null}
          </div>
          <div className="task-village__skyline" aria-hidden="true">





          </div>
          <div className="task-village__completion-bridge" aria-hidden="true"><span /><span /><span /></div>
          {mission?.evolution.verified ? <VerifiedSettlementGrowth seed={stableHash(task.id)} scale="village" /> : null}
          <div className="agent-lot-grid" data-agent-layout={agentLayout}>
            {task.agents.map((agent, agentIndex) => (
              <AgentLot
                key={agent.agent.id}
                item={agent}
                kind={agentKind(task, agent)}
                agentIndex={agentIndex}
                selected={agent.agent.id === selectedAgent?.agent.id}
                replayCutoff={replayCutoff}
                onSelect={onSelect}
                evidenceLensOn={evidenceLensOn}
                evidenceSelectionActive={Boolean(selectedAgent)}
                taskRootAgentId={task.rootAgentId}
              />
            ))}
          </div>
        </div>
        {selectedAgent || evidenceLensOn ? (
          <div className="task-context-strip" data-task-context-strip="true">
            {selectedAgent ? <AgentFocusCard item={selectedAgent} onClearSelection={onClearSelection} /> : null}
            {evidenceLensOn && selectedAgent ? <EvidenceProofCard item={selectedAgent} replayCutoff={replayCutoff} /> : null}
            {evidenceLensOn && !selectedAgent ? (
              <div className="evidence-lens-prompt" data-evidence-prompt="true">
                <strong>Evidence for current state</strong>
                <span>Select an agent to inspect its evidence.</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="task-village-legend" aria-label="Task map legend">
        <span data-route-legend="commute"><i className="legend-swatch legend-swatch--path" />Moving between home and work: active</span>
        <span><i className="legend-swatch legend-swatch--waiting" />At work means waiting or needs you</span>
        <span><i className="legend-swatch legend-swatch--home" />At home means quiet or complete</span>
      </div>
    </section>
  );
}

function WorldRail({ hierarchy, navigation, selectedId, onNavigate, onSelect, mode, missionWorld, replayCutoff }: {
  hierarchy: WorldHierarchy;
  mode: WorldSnapshot["mode"];
  missionWorld: MissionWorld;
  navigation: NavigationTarget;
  selectedId?: string;
  replayCutoff: number;
  onNavigate: (target: NavigationTarget) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <nav id="world-atlas" className="world-rail" aria-label="Project and task hierarchy">
      <div className="world-rail__heading">
        <div><span className="world-rail__pulse" aria-hidden="true" /><strong>Project map</strong></div>
        <span>{plural(hierarchy.projects.length, "project")}</span>
      </div>
      <button
        type="button"
        className={`world-rail__overview${navigation.level === "overview" ? " is-current" : ""}`}
        onClick={() => onNavigate({ level: "overview" })}
      >
        <span aria-hidden="true">✦</span>
        <span><strong>All projects</strong><small>{plural(hierarchy.tasks.length, "task")}</small></span>
      </button>
      <div className="world-tree">
        {hierarchy.projects.map((project) => {
          const projectCurrent = navigation.level !== "overview" && navigation.projectId === project.project.id;
          return (
            <section key={project.project.id} className={`world-tree__project${projectCurrent ? " is-open" : ""}`}>
              <button
                type="button"
                className={`world-tree__project-button${navigation.level === "project" && projectCurrent ? " is-current" : ""}`}
                onClick={() => onNavigate(projectTarget(project.project.id))}
              >
                <span className="world-tree__project-dot" style={{ background: project.project.color }} aria-hidden="true" />
                <span><strong>{project.displayName}</strong><small>{plural(project.tasks.length, "task")} · {plural(project.agents.length, "agent")}</small></span>
                <span aria-hidden="true">›</span>
              </button>
              <div className="world-tree__tasks">
                {project.tasks.map((task) => {
                  const taskCurrent = navigation.level === "task" && navigation.projectId === project.project.id && navigation.taskId === task.id;
                  const mission = missionForTask(missionWorld, project.project.id, task.id);
                  return (
                    <div
                      key={task.id}
                      className={`world-tree__task${taskCurrent ? " is-current" : ""}`}
                      data-mission-phase={missionPhase(mission)}
                      data-world-evolution={missionEvolution(mission)}
                    >
                      <button type="button" onClick={() => onNavigate(taskTarget(project.project.id, task.id))}>
                        <span className="world-tree__branch" aria-hidden="true" />
                        <span><strong>{task.displayName}</strong><small>{missionPhaseLabel(mission)} · {stateSummaryShort(task)}</small></span>
                        <span>{task.agents.length}</span>
                      </button>
                      {taskCurrent ? (
                        <div
                          className="world-tree__agents"
                          role="group"
                          aria-label={`${mode === "demo" ? "Sample agents" : "Agents"} in ${task.displayName}`}
                          data-agent-roster="true"
                          data-agent-count={task.agents.length}
                        >
                          <div className="world-tree__agents-heading">
                            <strong>{mode === "demo" ? "Sample agents" : "Agents"}</strong>
                            <span>{task.agents.length}</span>
                          </div>
                          {task.agents.map((item) => {
                            const kind = agentKind(task, item);
                            const available = agentObservedAtCutoff(item.agent, replayCutoff);
                            const selected = available && item.agent.id === selectedId;
                            return (
                              <button
                                key={item.agent.id}
                                type="button"
                                className={`world-tree__agent${selected ? " is-selected" : ""}`}
                                data-agent-id={item.agent.id}
                                data-agent-state={item.agent.state}
                                aria-label={`${available ? "Select " : "Not yet observed: "}${mode === "demo" ? "sample agent " : ""}${item.displayName}, ${kind} agent, ${STATE_META[item.agent.state].label}`}
                                aria-pressed={selected}
                                disabled={!available}
                                onClick={() => onSelect(item.agent.id)}
                              >
                                <span className="world-tree__agent-marker" aria-hidden="true" />
                                <span><strong>{item.displayName}</strong><small>{agentRailDetail(task, item)}</small></span>
                                <span className="world-tree__agent-indicator" aria-hidden="true">{selected ? "●" : "○"}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </nav>
  );
}

function Breadcrumbs({ hierarchy, missionWorld, navigation, onNavigate }: {
  hierarchy: WorldHierarchy;
  missionWorld: MissionWorld;
  navigation: NavigationTarget;
  onNavigate: (target: NavigationTarget) => void;
}) {
  const project = projectForNavigation(hierarchy, navigation);
  const task = taskForNavigation(hierarchy, navigation);
  const projectId = navigation.level === "overview" ? "" : navigation.projectId;
  const taskId = navigation.level === "task" ? navigation.taskId : "";
  const missionProject = missionWorld.projects.find((candidate) => candidate.id === projectId);
  const mission = missionProject?.missions.find((candidate) => candidate.taskId === taskId);
  const projectName = project?.displayName ?? missionProject?.displayName ?? (projectId ? `Project ${shortOpaqueId(projectId)}` : "");
  const taskName = task?.displayName ?? mission?.displayName ?? (taskId ? `Task ${shortOpaqueId(taskId)}` : "");
  const crumb = (label: string, current: boolean, action: () => void): ReactNode => current
    ? <span aria-current="page" title={label}>{label}</span>
    : <button type="button" title={label} onClick={action}>{label}</button>;
  return (
    <div className="world-breadcrumbs" aria-label="World location">
      {navigation.level !== "overview" ? (
        <button type="button" className="world-breadcrumbs__back" onClick={() => onNavigate(parentNavigation(navigation))} aria-label="Go back one level"><WorldIcon name="back" /></button>
      ) : <span className="world-breadcrumbs__mark" aria-hidden="true">✦</span>}
      {crumb("Project map", navigation.level === "overview", () => onNavigate({ level: "overview" }))}
      {projectName ? <span aria-hidden="true">/</span> : null}
      {projectName ? crumb(projectName, navigation.level === "project", () => onNavigate(projectTarget(projectId))) : null}
      {taskName ? <span aria-hidden="true">/</span> : null}
      {taskName ? <span aria-current="page" title={taskName}>{taskName}</span> : null}
    </div>
  );
}

function ReconnectingScene({ navigation }: { navigation: NavigationTarget }) {
  const isTask = navigation.level === "task";
  const locationId = navigation.level === "overview" ? "" : isTask ? navigation.taskId : navigation.projectId;
  return (
    <section className="zoom-scene reconnect-scene" aria-labelledby="reconnect-title">
      <div className="reconnect-scene__icon" aria-hidden="true">◌</div>
      <span className="scene-heading__eyebrow">WAITING FOR SOURCE UPDATE</span>
      <h2 id="reconnect-title">This {isTask ? "task" : "project"} is not in the latest source update</h2>
      <p>Its URL is preserved. The map will return here when a later update includes it.</p>
      <span className="reconnect-scene__id">{isTask ? `Task ${shortOpaqueId(locationId)}` : `Project ${shortOpaqueId(locationId)}`}</span>
    </section>
  );
}

function FilteredLocationScene({ navigation, missionWorld, onNavigate }: {
  navigation: NavigationTarget;
  missionWorld: MissionWorld;
  onNavigate: (target: NavigationTarget) => void;
}) {
  const isTask = navigation.level === "task";
  const missionProject = navigation.level === "overview"
    ? undefined
    : missionWorld.projects.find((project) => project.id === navigation.projectId);
  const mission = navigation.level === "task"
    ? missionProject?.missions.find((candidate) => candidate.taskId === navigation.taskId)
    : undefined;
  const locationName = isTask
    ? mission?.displayName ?? "this task"
    : missionProject?.displayName ?? "this project";
  return (
    <section className="zoom-scene reconnect-scene filtered-location-scene" aria-labelledby="filtered-location-title" data-filtered-location="true">
      <div className="reconnect-scene__icon" aria-hidden="true">⌕</div>
      <span className="scene-heading__eyebrow">LOCATION HIDDEN BY FILTER</span>
      <h2 id="filtered-location-title">This {isTask ? "task" : "project"} is hidden by the current filter</h2>
      <p>{locationName} is still in the full task map, but the current view has no matching agents to show here.</p>
      <button
        type="button"
        className="empty-world-scene__action empty-world-scene__action--primary"
        aria-label="Return to project map"
        onClick={() => onNavigate({ level: "overview" })}
      >
        Return to project map<WorldIcon name="arrow" />
      </button>
    </section>
  );
}

function EmptyWorldScene({ state }: { state: WorldEmptyState }) {
  const seed = stableHash(state.kind);
  const hasConnectionGuide = Boolean(state.connectionOptions?.length);
  return (
    <section
      className={`zoom-scene empty-world-scene empty-world-scene--${state.kind}`}
      role="region"
      aria-label={state.title}
      data-empty-world={state.kind}
    >
      <div className="empty-world-scene__copy">
        {!hasConnectionGuide ? <>
          <span className="scene-heading__eyebrow">{state.eyebrow}</span>
          <h2>{state.title.replaceAll("-", "‑")}</h2>
          <p className="empty-world-scene__description">{state.description}</p>
          {state.detail ? <p className="empty-world-scene__detail">{state.detail}</p> : null}
        </> : null}
        {hasConnectionGuide ? (
          <SourceSetup options={state.connectionOptions} contractNote={state.connectionNote} />
        ) : null}
        {state.primaryAction || state.secondaryAction ? (
          <div className="empty-world-scene__actions">
            {state.primaryAction ? (
              <button
                type="button"
                className="empty-world-scene__action empty-world-scene__action--primary"
                aria-label={state.primaryAction.ariaLabel ?? state.primaryAction.label}
                onClick={state.primaryAction.onClick}
              >
                {state.primaryAction.label}<WorldIcon name="arrow" />
              </button>
            ) : null}
            {state.secondaryAction ? (
              <button
                type="button"
                className="empty-world-scene__action empty-world-scene__action--secondary"
                aria-label={state.secondaryAction.ariaLabel ?? state.secondaryAction.label}
                onClick={state.secondaryAction.onClick}
              >
                {state.secondaryAction.label}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="empty-world-scene__boundary">
          <span className="empty-world-scene__boundary-dot" aria-hidden="true" />
          <span><strong>Read-only boundary active</strong> No raw prompts or payloads are shown.</span>
        </div>
      </div>

      <div className="empty-harbor" aria-hidden="true">
        <span className="empty-harbor__water empty-harbor__water--one" />
        <span className="empty-harbor__water empty-harbor__water--two" />
        <div className="empty-harbor__island">
          <span className="empty-harbor__dock" />
          <span className="empty-harbor__home"></span>



          <span className="empty-harbor__beacon" />
        </div>
        <span className="empty-harbor__caption">Waiting for the next source update</span>
      </div>
    </section>
  );
}

export function Archipelago({ snapshot, selectedId, onSelect, replayCutoff, navigation, onNavigate, evidenceLensOn = false, onEvidenceLensChange, onClearSelection, emptyState, missionWorld, visibleAgentIds, utilityControls }: ArchipelagoProps) {
  const [motionEnabled, setMotionEnabled] = useState(() => !(
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ));
  const replaySnapshot = useMemo(
    () => projectSnapshotAtCutoff(snapshot, replayCutoff),
    [replayCutoff, snapshot],
  );
  const fullHierarchy = useMemo(() => buildWorldHierarchy(replaySnapshot), [replaySnapshot]);
  const hierarchy = useMemo(
    () => visibleAgentIds === undefined
      ? fullHierarchy
      : filterRenderedHierarchy(fullHierarchy, visibleAgentIds),
    [fullHierarchy, visibleAgentIds],
  );
  const resolvedMissionWorld = useMemo(
    () => missionWorld ?? buildMissionWorld(snapshot, replayCutoff),
    [missionWorld, replayCutoff, snapshot],
  );
  const [cinematicMode, setCinematicMode] = useState(false);
  const requestedNavigation = navigation ?? { level: "overview" };
  const [atlasOpen, setAtlasOpen] = useState(false);
  const project = projectForNavigation(hierarchy, requestedNavigation);
  const task = taskForNavigation(hierarchy, requestedNavigation);
  const canonicalProject = requestedNavigation.level === "overview"
    ? undefined
    : resolvedMissionWorld.projects.find((candidate) => candidate.id === requestedNavigation.projectId);
  const canonicalTask = requestedNavigation.level === "task"
    ? canonicalProject?.missions.some((candidate) => candidate.taskId === requestedNavigation.taskId)
    : requestedNavigation.level === "project";
  const missingLocation = requestedNavigation.level !== "overview" && (!project || (requestedNavigation.level === "task" && !task));
  const filteredLocation = visibleAgentIds !== undefined
    && missingLocation
    && Boolean(canonicalProject && canonicalTask);
  const resolvedEmptyState: WorldEmptyState | undefined = filteredLocation
    ? undefined
    : hierarchy.agents.length === 0
    ? emptyState ?? {
      kind: "snapshot",
      eyebrow: "NO AGENTS IN SNAPSHOT",
      title: "Nothing to map yet",
      description: "This bounded snapshot does not contain any agent records.",
    }
    : undefined;
  const worldAvailable = !resolvedEmptyState;
  const effectiveAtlasOpen = worldAvailable && atlasOpen;
  const effectiveCinematicMode = worldAvailable && cinematicMode;
  const time = worldTimePhase(worldHour());
  const taskNavigation = requestedNavigation.level === "task" && task && project;
  const stageKey = requestedNavigation.level === "overview"
    ? "overview"
    : `${requestedNavigation.level}:${requestedNavigation.projectId}:${requestedNavigation.level === "task" ? requestedNavigation.taskId : ""}`;
  // Evidence is attached to an agent's task timeline. Keep the lens unavailable
  // at broader zoom levels so a remembered toggle can never imply project-wide
  // proof that the scene does not render.
  const effectiveEvidenceLensOn = Boolean(taskNavigation) && evidenceLensOn;

  useEffect(() => {
    if (cinematicMode && typeof window !== "undefined" && window.scrollY > 0) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [cinematicMode]);

  useEffect(() => {
    setAtlasOpen(false);
  }, [requestedNavigation.level, requestedNavigation.level === "overview" ? "" : requestedNavigation.projectId, requestedNavigation.level === "task" ? requestedNavigation.taskId : ""]);

  useEffect(() => {
    if (!resolvedEmptyState) return;
    setAtlasOpen(false);
    setCinematicMode(false);
  }, [resolvedEmptyState?.kind]);

  useEffect(() => {
    if (taskNavigation || !evidenceLensOn) return;
    onEvidenceLensChange?.(false);
  }, [evidenceLensOn, onEvidenceLensChange, taskNavigation]);

  useEffect(() => {
    if (requestedNavigation.level !== "task" || !selectedId || typeof document === "undefined") return;
    const lot = Array.from(document.querySelectorAll<HTMLElement>(".task-village [data-agent-id]"))
      .find((candidate) => candidate.dataset.agentId === selectedId);
    if (!lot) return;
    const bounds = lot.getBoundingClientRect();
    const alreadyVisible = bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    if (!alreadyVisible) lot.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
  }, [requestedNavigation.level, selectedId, task?.id]);

  return (
    <section className={`archipelago${effectiveCinematicMode ? " is-cinematic" : ""}`} aria-label={`${snapshot.mode === "live" ? "Live" : "Demo"} agent world`} data-source-context={snapshot.mode} data-zoom-level={requestedNavigation.level} data-motion={motionEnabled ? "on" : "off"} data-time={time} data-atlas={effectiveAtlasOpen ? "open" : "closed"} data-evidence-lens={effectiveEvidenceLensOn ? "on" : "off"} data-empty-state={resolvedEmptyState?.kind ?? "none"}>
      <header className="world-commandbar">
        <div className="world-commandbar__context">
          <Breadcrumbs hierarchy={hierarchy} missionWorld={resolvedMissionWorld} navigation={requestedNavigation} onNavigate={onNavigate} />
          <div
            className="world-commandbar__source"
            aria-label={`Source status: ${sourceLabel(snapshot)}, ${resolvedEmptyState?.sourceSummary ?? plural(hierarchy.agents.length, "agent")}`}
          >
            <span className="world-commandbar__live" aria-hidden="true" />
            <strong>{sourceLabel(snapshot)}</strong>
            <span>{resolvedEmptyState?.sourceSummary ?? plural(hierarchy.agents.length, "agent")}</span>
          </div>
        </div>
        <div className="world-commandbar__actions">
          {utilityControls}
          {worldAvailable ? <>
          {taskNavigation && onEvidenceLensChange ? (
          <button
            type="button"
            className={`world-commandbar__lens${effectiveEvidenceLensOn ? " is-on" : ""}`}
            aria-pressed={effectiveEvidenceLensOn}
            aria-label={effectiveEvidenceLensOn ? "Turn off Evidence lens" : "Turn on Evidence lens"}
            onClick={() => onEvidenceLensChange(!effectiveEvidenceLensOn)}
          >
            <WorldIcon name="lens" />
            <strong><span className="control-label-long">Evidence lens</span><span className="control-label-short">Evidence</span></strong>
            <small>{effectiveEvidenceLensOn ? "On" : "Off"}</small>
          </button>
          ) : null}
          <details className="world-commandbar__options">
            <summary aria-label="View options">
              <WorldIcon name="settings" />
              <strong><span className="control-label-long">View options</span><span className="control-label-short">View</span></strong>
            </summary>
            <div className="world-commandbar__options-body">
              <button
                type="button"
                className={`world-commandbar__atlas${atlasOpen ? " is-on" : ""}`}
                aria-expanded={atlasOpen}
                aria-controls="world-atlas"
                aria-label={atlasOpen ? "Close Atlas" : "Open Atlas"}
                onClick={() => setAtlasOpen((current) => !current)}
              >
                <WorldIcon name="list" />
                <strong><span className="control-label-long">{atlasOpen ? "Close Atlas" : "Open Atlas"}</span><span className="control-label-short">Atlas</span></strong>
              </button>
              <button
                type="button"
                className={`world-commandbar__motion${motionEnabled ? " is-on" : ""}`}
                aria-pressed={motionEnabled}
                aria-label={motionEnabled ? "Pause agent movement" : "Resume agent movement"}
                onClick={() => setMotionEnabled((current) => !current)}
              >
                <WorldIcon name={motionEnabled ? "pause" : "play"} />
                <strong><span className="control-label-long">{motionEnabled ? "Agents moving" : "Motion paused"}</span><span className="control-label-short">{motionEnabled ? "Pause" : "Move"}</span></strong>
              </button>
              <button
                type="button"
                className={`world-commandbar__cinematic${cinematicMode ? " is-on" : ""}`}
                aria-pressed={cinematicMode}
                aria-label={cinematicMode ? "Exit cinematic view" : "Open cinematic view"}
                onClick={() => setCinematicMode((current) => !current)}
              >
                <WorldIcon name="frame" />
                <strong>{cinematicMode ? "Cinematic on" : "Cinematic"}</strong>
              </button>
            </div>
          </details>
          </> : null}
        </div>
      </header>
      <div className="world-workspace" data-atlas={effectiveAtlasOpen ? "open" : "closed"}>
        {effectiveAtlasOpen ? (
          <WorldRail
            hierarchy={hierarchy}
            mode={snapshot.mode}
            missionWorld={resolvedMissionWorld}
            navigation={requestedNavigation}
            selectedId={selectedId}
            replayCutoff={replayCutoff}
            onNavigate={onNavigate}
            onSelect={onSelect}
          />
        ) : null}
        <div className="world-stage" key={stageKey}>
          {resolvedEmptyState ? <EmptyWorldScene state={resolvedEmptyState} /> : null}
          {!resolvedEmptyState && requestedNavigation.level === "overview" ? <OverviewScene hierarchy={hierarchy} mode={snapshot.mode} missionWorld={resolvedMissionWorld} onNavigate={onNavigate} /> : null}
          {!resolvedEmptyState && requestedNavigation.level === "project" && project ? <ProjectScene project={project} mode={snapshot.mode} missionWorld={resolvedMissionWorld} onNavigate={onNavigate} /> : null}
          {!resolvedEmptyState && taskNavigation ? <TaskScene project={project} task={task} mission={missionForTask(resolvedMissionWorld, project.project.id, task.id)} mode={snapshot.mode} selectedId={selectedId} replayCutoff={replayCutoff} onSelect={onSelect} onClearSelection={onClearSelection} motionEnabled={motionEnabled} evidenceLensOn={effectiveEvidenceLensOn} /> : null}
          {!resolvedEmptyState && filteredLocation ? <FilteredLocationScene navigation={requestedNavigation} missionWorld={resolvedMissionWorld} onNavigate={onNavigate} /> : null}
          {!resolvedEmptyState && missingLocation && !filteredLocation ? <ReconnectingScene navigation={requestedNavigation} /> : null}
        </div>
      </div>
    </section>
  );
}

export default Archipelago;
