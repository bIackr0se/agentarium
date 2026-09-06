import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentSnapshot, WorldSnapshot } from "./lib/contracts";
import { Archipelago } from "./components/Archipelago";
import type { WorldEmptyState } from "./components/Archipelago";
import { Inspector } from "./components/Inspector";
import { MissionBoard } from "./components/MissionBoard";
import { Timeline } from "./components/Timeline";
import { SourceMode, Toolbar } from "./components/Toolbar";
import { SOURCE_CONNECTION_OPTIONS, SOURCE_CONTRACT_NOTE } from "./components/SourceSetup";
import { buildWorldHierarchy, projectTarget, taskTarget, WORKING_STATES } from "./lib/hierarchy";
import type { NavigationTarget } from "./lib/hierarchy";
import { createDemoSnapshot } from "./lib/demo-fixture.mjs";
import { agentObservedAtCutoff, buildMissionWorld, projectSnapshotAtCutoff } from "./lib/missions";
import { normalizeClientSnapshot } from "./lib/snapshot-contract";
import "./shell.css";
import "./styles.css";

export type FocusMode = "overview" | "attention" | "project" | "task" | "search";

export interface AppProps {
  /** A fixture may be injected by tests or an embedding shell. */
  initialSnapshot?: WorldSnapshot;
}

export { createDemoSnapshot };


async function requestLiveSnapshot(): Promise<WorldSnapshot> {
  if (typeof fetch !== "function") throw new Error("fetch is unavailable");
  const controller = new AbortController();
  // A cold read of a local lifecycle store can take a few seconds. The API
  // now shares that read across clients, so allow the first bounded refresh to
  // finish instead of flashing a false demo fallback.
  const timer = globalThis.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("/api/snapshot?mode=live", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`snapshot request failed (${response.status})`);
    const payload: unknown = await response.json();
    const normalized = normalizeClientSnapshot(payload, { mode: "live" });
    if (!normalized) throw new Error("snapshot contract validation failed");
    return normalized;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function eventTime(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function allEvents(agents: AgentSnapshot[]): AgentEvent[] {
  return agents.flatMap((agent) => agent.events);
}

function snapshotBounds(snapshot: WorldSnapshot): { min: number; max: number } {
  const times = [
    ...allEvents(snapshot.agents).map((event) => eventTime(event.timestamp)),
    ...snapshot.agents.map((agent) => eventTime(agent.lastSeen)),
  ].filter((value): value is number => value !== null);
  const generated = eventTime(snapshot.generatedAt);
  // Agent lifecycle timestamps are evidence too. Including them keeps a live
  // villager selectable even when its newest state has no event row yet.
  if (times.length === 0 && generated !== null) times.push(generated);
  return {
    min: times.length > 0 ? Math.min(...times) : Date.now(),
    max: times.length > 0 ? Math.max(...times) : Date.now(),
  };
}

function navigationFromLocation(): NavigationTarget {
  if (typeof window === "undefined") return { level: "overview" };
  const parameters = new URLSearchParams(window.location.search);
  const projectId = parameters.get("project")?.trim();
  const taskId = parameters.get("task")?.trim();
  if (projectId && taskId) return { level: "task", projectId, taskId };
  if (projectId) return { level: "project", projectId };
  return { level: "overview" };
}

function urlForNavigation(target: NavigationTarget): URL {
  const url = new URL(window.location.href);
  if (target.level === "overview") {
    url.searchParams.delete("project");
    url.searchParams.delete("task");
  } else {
    url.searchParams.set("project", target.projectId);
    if (target.level === "task") url.searchParams.set("task", target.taskId);
    else url.searchParams.delete("task");
  }
  return url;
}

function sameNavigation(left: NavigationTarget, right: NavigationTarget): boolean {
  if (left.level !== right.level) return false;
  if (left.level === "overview" || right.level === "overview") return true;
  if (left.projectId !== right.projectId) return false;
  return left.level === "project" || right.level === "project" || left.taskId === right.taskId;
}

function resetViewportAfterNavigation(): void {
  if (typeof window !== "undefined" && window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
}

export interface FilterOptions {
  searchQuery: string;
  projectFilter: string;
  attentionOnly: boolean;
}

type AgentWithLegacyParent = AgentSnapshot & { parentThreadId?: string };

function parentIdFor(agent: AgentSnapshot): string | undefined {
  const candidate = agent as AgentWithLegacyParent;
  return candidate.parentAgentId ?? candidate.parentThreadId;
}

function rootAgentFor(agent: AgentSnapshot, byId: Map<string, AgentSnapshot>): AgentSnapshot {
  let current = agent;
  const seen = new Set<string>();
  while (parentIdFor(current) && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = parentIdFor(current);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parent || parent.projectId !== agent.projectId) break;
    current = parent;
  }
  return current;
}

export function filterAgents(snapshot: WorldSnapshot, options: FilterOptions): AgentSnapshot[] {
  const query = options.searchQuery.trim().toLocaleLowerCase();
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  return snapshot.agents.filter((agent) => {
    if (options.projectFilter && agent.projectId !== options.projectFilter) return false;
    if (options.attentionOnly && !snapshot.attention.includes(agent.id)) return false;
    if (!query) return true;
    const root = rootAgentFor(agent, byId);
    const haystack = [
      agent.id,
      agent.assignment ?? "",
      agent.nickname ?? "",
      agent.title,
      agent.role ?? "",
      agent.projectName,
      agent.state,
      agent.currentAction,
      agent.branch ?? "",
      agent.attentionReason ?? "",
      root.id !== agent.id ? root.title : "",
      root.id !== agent.id ? root.assignment ?? "" : "",
      root.id !== agent.id ? root.currentAction : "",
      ...agent.events.map((event) => `${event.label} ${event.kind}`),
    ].join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });
}

function visibleSnapshot(snapshot: WorldSnapshot, agents: AgentSnapshot[]): WorldSnapshot {
  // Keep matching agents as the rendered subset, but retain their in-snapshot
  // parents as context records so a helper-only search still resolves to the
  // human root-task title. The map can therefore name the task without
  // promoting a helper's nickname or assignment to the task level.
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const contextIds = new Set(agents.map((agent) => agent.id));
  agents.forEach((agent) => {
    let current = agent;
    const seen = new Set<string>();
    while (parentIdFor(current) && !seen.has(current.id)) {
      seen.add(current.id);
      const parentId = parentIdFor(current);
      const parent = parentId ? byId.get(parentId) : undefined;
      if (!parent || parent.projectId !== agent.projectId) break;
      contextIds.add(parent.id);
      current = parent;
    }
  });
  const contextAgents = snapshot.agents
    .filter((agent) => contextIds.has(agent.id))
    .map((agent) => {
      const parentId = parentIdFor(agent);
      return parentId && !agent.parentAgentId ? { ...agent, parentAgentId: parentId } : agent;
    });
  return {
    ...snapshot,
    agents: contextAgents,
    projects: snapshot.projects
      .map((project) => ({
        ...project,
        agentIds: project.agentIds.filter((id) => contextIds.has(id)),
        activeCount: contextAgents.filter((agent) => agent.projectId === project.id && WORKING_STATES.has(agent.state)).length,
        attentionCount: contextAgents.filter((agent) => agent.projectId === project.id && snapshot.attention.includes(agent.id)).length,
      }))
      .filter((project) => project.agentIds.length > 0),
  };
}

const UNCONFIGURED_SOURCE = /not configured|without configuration/i;
const STOPPED_SOURCE = /\b(?:source|observer|adapter|database|schema)\b[^.\n]{0,160}\b(?:stopped|unreadable|malformed|rejected|invalid|not recognized)\b|\b(?:stopped|unreadable|malformed|rejected|invalid)\b[^.\n]{0,80}\b(?:source|observer|adapter|database|schema)\b/i;
const UNAVAILABLE_SOURCE = /unavailable|cannot be reached|could not be read|failed to (?:load|read|connect)/i;
const STARTING_SOURCE = /\b(?:observer|source|worker)\b[^.\n]{0,80}\b(?:starting|initializing|not ready|warming up)\b|\b(?:starting|initializing|not ready|warming up)\b[^.\n]{0,80}\b(?:observer|source|worker)\b/i;

function firstWarning(snapshot: WorldSnapshot, pattern: RegExp): string | undefined {
  return snapshot.warnings.find((warning) => pattern.test(warning));
}

export function App({ initialSnapshot }: AppProps) {
  const embeddedSnapshot = useMemo(
    () => initialSnapshot === undefined ? null : normalizeClientSnapshot(initialSnapshot),
    [initialSnapshot],
  );
  const hasEmbeddedSnapshot = initialSnapshot !== undefined;
  const [snapshot, setSnapshot] = useState<WorldSnapshot>(() => embeddedSnapshot ?? createDemoSnapshot());
  // The public entry point is always the clearly synthetic fixture. Embedders
  // that provide an initial snapshot retain their explicit source selection.
  const [sourceMode, setSourceMode] = useState<SourceMode>(() => embeddedSnapshot?.mode ?? "demo");
  const sourceModeRef = useRef<SourceMode>(embeddedSnapshot?.mode ?? "demo");
  const [searchQuery, setSearchQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [evidenceLensOn, setEvidenceLensOn] = useState(false);
  const [utilityPanel, setUtilityPanel] = useState<"missions" | "replay" | null>(null);
  const missionLauncherRef = useRef<HTMLButtonElement>(null);
  const replayLauncherRef = useRef<HTMLButtonElement>(null);
  const utilityOpenerRef = useRef<HTMLButtonElement | null>(null);
  const inspectorOpenerRef = useRef<HTMLElement | null>(null);
  const [navigation, setNavigation] = useState<NavigationTarget>(navigationFromLocation);
  const [replayCutoff, setReplayCutoff] = useState(() => snapshotBounds(snapshot).max);
  const replayCutoffRef = useRef(replayCutoff);
  const replayMaxRef = useRef(snapshotBounds(snapshot).max);
  const bufferedLiveSnapshotRef = useRef<WorldSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const loadVersion = useRef(0);

  const acceptLiveSnapshot = useCallback((next: WorldSnapshot) => {
    // Replay is a frozen view of the last-good world. Keep the newest live
    // update out of rendered state until the user explicitly returns to live.
    if (replayCutoffRef.current < replayMaxRef.current) {
      bufferedLiveSnapshotRef.current = next;
      return;
    }
    setSnapshot(next);
  }, []);

  const loadLive = useCallback(async () => {
    const version = ++loadVersion.current;
    setRefreshing(true);
    try {
      const next = await requestLiveSnapshot();
      if (version !== loadVersion.current) return;
      acceptLiveSnapshot(next);
      setLiveUnavailable(false);
      sourceModeRef.current = "live";
      setSourceMode("live");
    } catch {
      if (version !== loadVersion.current) return;
      if (sourceModeRef.current === "live") {
        // A transient refresh or poll failure must not replace a valid live
        // world with sample data. Keep the last-good snapshot visible and
        // surface the degraded source state until the next valid update.
        setLiveUnavailable(true);
        return;
      }
      const fallback = createDemoSnapshot();
      const fallbackMax = snapshotBounds(fallback).max;
      bufferedLiveSnapshotRef.current = null;
      replayMaxRef.current = fallbackMax;
      replayCutoffRef.current = fallbackMax;
      setReplayCutoff(fallbackMax);
      setSnapshot(fallback);
      setLiveUnavailable(true);
      // A failed opt-in must never leave the synthetic fallback labelled as a
      // private live view. Keep the safe fixture selected and make the reason
      // explicit in the toolbar detail.
      sourceModeRef.current = "demo";
      setSourceMode("demo");
    } finally {
      if (version === loadVersion.current) setRefreshing(false);
    }
  }, [acceptLiveSnapshot]);

  useEffect(() => {
    if (hasEmbeddedSnapshot || sourceMode !== "live" || typeof EventSource !== "function") return;

    const stream = new EventSource("/api/events?mode=live");
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const next: unknown = JSON.parse(event.data);
        const normalized = normalizeClientSnapshot(next, { mode: "live" });
        if (!normalized) return;
        acceptLiveSnapshot(normalized);
        setLiveUnavailable(false);
        sourceModeRef.current = "live";
      } catch {
        // The bounded polling path remains active if a stream event is malformed.
      }
    };
    const onError = () => {
      if (sourceModeRef.current === "live") setLiveUnavailable(true);
    };
    stream.addEventListener("snapshot", onSnapshot);
    stream.addEventListener("error", onError);
    return () => {
      stream.removeEventListener("snapshot", onSnapshot);
      stream.removeEventListener("error", onError);
      stream.close();
    };
  }, [acceptLiveSnapshot, hasEmbeddedSnapshot, sourceMode]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      if (sourceMode === "live") void loadLive();
    }, 30_000);
    return () => globalThis.clearInterval(interval);
  }, [loadLive, sourceMode]);

  useLayoutEffect(() => {
    const nextMax = snapshotBounds(snapshot).max;
    const previousMax = replayMaxRef.current;
    const nextCutoff = replayCutoffRef.current >= previousMax
      ? nextMax
      : Math.min(replayCutoffRef.current, nextMax);
    replayCutoffRef.current = nextCutoff;
    setReplayCutoff(nextCutoff);
    replayMaxRef.current = nextMax;
  }, [snapshot]);

  useEffect(() => {
    if (projectFilter && !snapshot.projects.some((project) => project.id === projectFilter)) {
      setProjectFilter("");
    }
  }, [projectFilter, snapshot.projects]);

  const replaySnapshot = useMemo(
    () => projectSnapshotAtCutoff(snapshot, replayCutoff),
    [replayCutoff, snapshot],
  );
  const visibleAgents = useMemo(
    () => filterAgents(replaySnapshot, { searchQuery, projectFilter, attentionOnly }),
    [attentionOnly, projectFilter, replaySnapshot, searchQuery],
  );
  const selectableAgents = useMemo(
    () => visibleAgents.filter((agent) => agentObservedAtCutoff(agent, replayCutoff)),
    [replayCutoff, visibleAgents],
  );
  const visibleAgentIds = useMemo(() => visibleAgents.map((agent) => agent.id), [visibleAgents]);
  const displaySnapshot = useMemo(() => visibleSnapshot(replaySnapshot, visibleAgents), [replaySnapshot, visibleAgents]);
  const timelineAgents = useMemo(() => {
    const visibleIds = new Set(visibleAgents.map((agent) => agent.id));
    return snapshot.agents.filter((agent) => visibleIds.has(agent.id));
  }, [snapshot.agents, visibleAgents]);
  const missionTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);
  // Missions always come from the complete normalized snapshot. Search and
  // queue filters may hide agents on the map, but they must never erase a
  // root task, rename it, or change its evidence-derived lifecycle.
  const missionWorld = useMemo(
    () => buildMissionWorld(snapshot, replayCutoff, { timeZone: missionTimeZone }),
    [missionTimeZone, replayCutoff, snapshot],
  );
  const selectedAgent = useMemo(
    () => selectableAgents.find((agent) => agent.id === selectedId) ?? null,
    [selectableAgents, selectedId],
  );
  const focusMode: FocusMode = searchQuery ? "search" : attentionOnly ? "attention" : navigation.level;
  const replayBounds = useMemo(() => snapshotBounds(snapshot), [snapshot]);
  const replayActive = replayCutoff < replayBounds.max;
  const sourceNeedsSetup = snapshot.warnings.some((warning) => UNCONFIGURED_SOURCE.test(warning));
  const observerStopped = !sourceNeedsSetup && snapshot.warnings.some((warning) => STOPPED_SOURCE.test(warning));
  const sourceUnavailable = !sourceNeedsSetup && !observerStopped && snapshot.warnings.some((warning) => UNAVAILABLE_SOURCE.test(warning));
  const sourceStarting = !sourceNeedsSetup && !observerStopped && !sourceUnavailable && snapshot.warnings.some((warning) => STARTING_SOURCE.test(warning));
  const missionDecisionCount = missionWorld.missions.filter((mission) => mission.requiresHumanDecision).length;

  const returnToLive = useCallback(() => {
    const buffered = bufferedLiveSnapshotRef.current;
    bufferedLiveSnapshotRef.current = null;
    if (buffered && sourceModeRef.current === "live") {
      const nextMax = snapshotBounds(buffered).max;
      replayMaxRef.current = nextMax;
      replayCutoffRef.current = nextMax;
      setSnapshot(buffered);
      setReplayCutoff(nextMax);
      return;
    }
    const nextMax = replayMaxRef.current;
    replayCutoffRef.current = nextMax;
    setReplayCutoff(nextMax);
  }, []);

  const closeUtilityPanel = useCallback(() => {
    utilityOpenerRef.current?.focus();
    setUtilityPanel(null);
  }, []);

  const toggleUtilityPanel = useCallback((panel: "missions" | "replay") => {
    if (utilityPanel === panel) {
      closeUtilityPanel();
      return;
    }
    utilityOpenerRef.current = panel === "missions" ? missionLauncherRef.current : replayLauncherRef.current;
    setUtilityPanel(panel);
  }, [closeUtilityPanel, utilityPanel]);

  useEffect(() => {
    // A filter may hide a selected task. Closing the drawer is predictable and
    // keeps selection explicit, rather than choosing another task implicitly.
    if (selectedId && !selectableAgents.some((agent) => agent.id === selectedId)) {
      setSelectedId(null);
      setInspectorOpen(false);
    }
  }, [selectableAgents, selectedId]);

  useEffect(() => {
    if (visibleAgents.length > 0) return;
    setUtilityPanel(null);
    setEvidenceLensOn(false);
    setSelectedId(null);
    setInspectorOpen(false);
  }, [visibleAgents.length]);

  useEffect(() => {
    if (missionWorld.missionCount > 0) return;
    setUtilityPanel(null);
  }, [missionWorld.missionCount]);

  useEffect(() => {
    const onPopState = () => {
      setSelectedId(null);
      setInspectorOpen(false);
      setNavigation(navigationFromLocation());
      resetViewportAfterNavigation();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.history.replaceState(window.history.state, "", urlForNavigation(navigation));
  }, [navigation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;
      if (inspectorOpen && event.key !== "Escape") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[aria-label="Search agents, projects, or actions"]')?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (!isTyping) {
          if (inspectorOpen) setInspectorOpen(false);
          else if (utilityPanel) closeUtilityPanel();
          else setSelectedId(null);
        }
        return;
      }
      if (isTyping) return;
      if (event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[aria-label="Search agents, projects, or actions"]')?.focus();
        return;
      }
      if (selectableAgents.length === 0 || !["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = selectableAgents.findIndex((agent) => agent.id === selectedId);
      const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = currentIndex < 0
        ? 0
        : Math.max(0, Math.min(selectableAgents.length - 1, currentIndex + direction));
      const nextId = selectableAgents[nextIndex]?.id ?? null;
      if (nextId === selectedId) return;
      setInspectorOpen(false);
      setSelectedId(nextId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeUtilityPanel, inspectorOpen, selectableAgents, selectedId, utilityPanel]);

  const handleSourceModeChange = (nextMode: SourceMode) => {
    setSelectedId(null);
    setInspectorOpen(false);
    setEvidenceLensOn(false);
    setNavigation({ level: "overview" });
    resetViewportAfterNavigation();
    bufferedLiveSnapshotRef.current = null;
    if (nextMode === "demo") {
      loadVersion.current += 1;
      sourceModeRef.current = "demo";
      const demo = createDemoSnapshot();
      const demoMax = snapshotBounds(demo).max;
      replayMaxRef.current = demoMax;
      replayCutoffRef.current = demoMax;
      setReplayCutoff(demoMax);
      setRefreshing(false);
      setSourceMode("demo");
      setLiveUnavailable(false);
      setSnapshot(demo);
      return;
    }
    replayCutoffRef.current = replayMaxRef.current;
    setReplayCutoff(replayMaxRef.current);
    void loadLive();
  };

  const handleReplayCutoff = (value: number) => {
    const bounded = Math.min(replayBounds.max, Math.max(replayBounds.min, value));
    if (bounded >= replayBounds.max) {
      returnToLive();
      return;
    }
    replayCutoffRef.current = bounded;
    setReplayCutoff(bounded);
  };

  const handleNavigation = useCallback((target: NavigationTarget) => {
    if (sameNavigation(navigation, target)) return;
    if (typeof window !== "undefined") window.history.pushState(window.history.state, "", urlForNavigation(target));
    setSelectedId(null);
    setInspectorOpen(false);
    setEvidenceLensOn(false);
    setNavigation(target);
    resetViewportAfterNavigation();
  }, [navigation]);

  const handleOpenAgent = useCallback((agentId: string) => {
    const selectableIds = new Set(selectableAgents.map((agent) => agent.id));
    const hierarchyAgent = buildWorldHierarchy(replaySnapshot).agents.find((item) => (
      item.agent.id === agentId && selectableIds.has(item.agent.id)
    ));
    setSearchQuery("");
    setProjectFilter("");
    setAttentionOnly(false);
    if (!hierarchyAgent) {
      // A historical decision can remain mission-visible even when the
      // decision agent has not yet been observed at this replay cutoff. Keep
      // Review in map actionable by opening the owning task instead of
      // silently dropping the click.
      const mission = missionWorld.missions.find((candidate) => candidate.decision?.agentId === agentId);
      if (mission) {
        const returnTarget = inspectorOpenerRef.current;
        handleNavigation(taskTarget(mission.projectId, mission.taskId));
        queueMicrotask(() => {
          if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
        });
      }
      return;
    }
    handleNavigation(taskTarget(hierarchyAgent.agent.projectId, hierarchyAgent.rootTaskId));
    setSelectedId(agentId);
    setInspectorOpen(true);
  }, [handleNavigation, missionWorld.missions, replaySnapshot, selectableAgents]);

  const handleSelectAgent = useCallback((agentId: string) => {
    if (!selectableAgents.some((agent) => agent.id === agentId)) return;
    const activeElement = document.activeElement;
    inspectorOpenerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setUtilityPanel(null);
    setSelectedId(agentId);
    setInspectorOpen(true);
  }, [selectableAgents]);

  const handleClearView = useCallback(() => {
    setSearchQuery("");
    setProjectFilter("");
    setAttentionOnly(false);
    setSelectedId(null);
    setInspectorOpen(false);
    setEvidenceLensOn(false);
    setUtilityPanel(null);
    handleNavigation({ level: "overview" });
  }, [handleNavigation]);

  const emptyState: WorldEmptyState | undefined = visibleAgents.length > 0
    ? undefined
    : snapshot.agents.length > 0
      ? {
        kind: "filtered",
        eyebrow: "VIEW FILTERED TO ZERO",
        title: "No agents match this view",
        description: "Clear the current search and filters to return to the project map.",
        detail: "The source still has records. Nothing was removed from the underlying snapshot.",
        sourceSummary: `0 visible · ${snapshot.agents.length} total`,
        primaryAction: { label: "Clear view", onClick: handleClearView },
      }
      : sourceMode === "live" && sourceNeedsSetup
        ? {
          kind: "unconfigured",
          eyebrow: "LIVE SOURCE SETUP",
          title: "Connect a source",
          description: "Connect a local source to see your projects, tasks, and agents.",
          detail: "Stop the current Agentarium server if needed, restart it with one adapter below, return here, then select Live.",
          sourceSummary: "Source not configured",
          connectionOptions: SOURCE_CONNECTION_OPTIONS,
          connectionNote: `Contract: docs/world-snapshot.schema.json · ${SOURCE_CONTRACT_NOTE}`,
          primaryAction: { label: "Open demo world", onClick: () => handleSourceModeChange("demo") },
          secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: () => void loadLive() },
        }
        : sourceMode === "live" && observerStopped
          ? {
            kind: "stopped",
            eyebrow: "FAIL-CLOSED SOURCE",
            title: "Live source stopped safely",
            description: "Agentarium stopped before showing untrusted data from this source.",
            detail: `Source report: ${firstWarning(snapshot, STOPPED_SOURCE) ?? firstWarning(snapshot, UNAVAILABLE_SOURCE) ?? "The live snapshot could not be validated."}`,
            sourceSummary: "Snapshot withheld",
            primaryAction: { label: "Open demo world", onClick: () => handleSourceModeChange("demo") },
            secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: () => void loadLive() },
          }
          : sourceMode === "live" && sourceUnavailable
            ? {
              kind: "unavailable",
              eyebrow: "LIVE SOURCE UNAVAILABLE",
              title: "Live source unavailable",
              description: "Agentarium could not read a valid snapshot from the configured source.",
              detail: `Source report: ${firstWarning(snapshot, UNAVAILABLE_SOURCE) ?? "The source could not be reached."}`,
              sourceSummary: "Source unavailable",
              primaryAction: { label: "Open demo world", onClick: () => handleSourceModeChange("demo") },
              secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: () => void loadLive() },
            }
          : sourceMode === "live" && sourceStarting
            ? {
              kind: "unavailable",
              eyebrow: "LIVE SOURCE STARTING",
              title: "Live source is starting",
              description: "The configured observer is still starting its isolated worker.",
              detail: `${firstWarning(snapshot, STARTING_SOURCE) ?? "The live source is not ready yet."} Try again in a moment.`,
              sourceSummary: "Source starting",
              primaryAction: { label: "Open demo world", onClick: () => handleSourceModeChange("demo") },
              secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: () => void loadLive() },
            }
          : sourceMode === "live"
            ? {
              kind: "empty",
              eyebrow: "LIVE SOURCE READY",
              title: "No active agents yet",
              description: "The live source is connected and currently reports zero agent records.",
              detail: "Leave this view open or retry when an agent run begins.",
              sourceSummary: "Connected · 0 agents",
              primaryAction: { label: "Open demo world", onClick: () => handleSourceModeChange("demo") },
              secondaryAction: { label: "Retry live", ariaLabel: "Retry live source", onClick: () => void loadLive() },
            }
            : {
              kind: "snapshot",
              eyebrow: "EMPTY SNAPSHOT",
              title: "Nothing to map yet",
              description: "This snapshot does not contain any agent records.",
              detail: "Choose another source or refresh the current snapshot.",
              sourceSummary: "0 agents",
            };

  useEffect(() => {
    const locationLabel = navigation.level === "overview"
      ? "Project map"
      : navigation.level === "project"
        ? "Project view"
        : "Task village";
    document.title = `Agentarium · ${locationLabel}`;
  }, [navigation.level]);

  const utilityControls = missionWorld.missionCount > 0 ? (
    <div
      className="utility-dock"
      data-utility-panel={utilityPanel ?? "closed"}
      data-utility-placement={utilityPanel ? "overlay" : "navigation"}
    >
      <div className="utility-dock__launchers" role="group" aria-label="World utilities">
        <button
          ref={missionLauncherRef}
          id="mission-board-launcher"
          type="button"
          aria-label={`Mission board, ${missionWorld.missionCount} ${missionWorld.missionCount === 1 ? "mission" : "missions"}, ${missionDecisionCount} ${missionDecisionCount === 1 ? "needs" : "need"} your move`}
          aria-expanded={utilityPanel === "missions"}
          aria-controls="mission-board-panel"
          className={utilityPanel === "missions" ? "is-active" : ""}
          onClick={() => toggleUtilityPanel("missions")}
        >
          <span>Missions</span>
          <strong>{missionDecisionCount > 0 ? `${missionDecisionCount} due` : missionWorld.missionCount}</strong>
        </button>
        <button
          ref={replayLauncherRef}
          id="replay-launcher"
          type="button"
          aria-label="Replay"
          aria-expanded={utilityPanel === "replay"}
          aria-controls="replay-panel"
          className={utilityPanel === "replay" ? "is-active" : ""}
          onClick={() => toggleUtilityPanel("replay")}
        >
          <span>Replay</span>
          <strong>{replayActive ? "On" : "Live"}</strong>
        </button>
      </div>
      {utilityPanel ? (
        <div
          id={utilityPanel === "missions" ? "mission-board-panel" : "replay-panel"}
          className="utility-dock__panel"
          role="region"
          aria-labelledby={utilityPanel === "missions" ? "mission-board-launcher" : "replay-launcher"}
        >
          <button
            type="button"
            className="utility-dock__close"
            aria-label={utilityPanel === "missions" ? "Close mission board" : "Close replay"}
            onClick={closeUtilityPanel}
          >
            Close
          </button>
          {utilityPanel === "missions" ? (
            <MissionBoard
              world={missionWorld}
              onNavigate={(target) => {
                const returnTarget = missionLauncherRef.current;
                returnTarget?.focus({ preventScroll: true });
                setUtilityPanel(null);
                setSearchQuery("");
                setProjectFilter("");
                setAttentionOnly(false);
                handleNavigation(target);
                queueMicrotask(() => {
                  if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
                });
              }}
              onOpenAgent={(agentId) => {
                inspectorOpenerRef.current = missionLauncherRef.current;
                setUtilityPanel(null);
                handleOpenAgent(agentId);
              }}
            />
          ) : (
            <Timeline
              agents={timelineAgents}
              replayCutoff={replayCutoff}
              replayBounds={replayBounds}
              onReplayCutoff={handleReplayCutoff}
              onResetReplay={returnToLive}
            />
          )}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="app-shell" data-focus-mode={focusMode} data-source-mode={sourceMode}>
      <Toolbar
        utilityControls={utilityControls}
        snapshot={replaySnapshot}
        projects={replaySnapshot.projects}
        visibleCount={visibleAgents.length}
        totalCount={replaySnapshot.agents.length}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        projectFilter={projectFilter}
        onProjectChange={(projectId) => {
          setProjectFilter(projectId);
          handleNavigation(projectId ? projectTarget(projectId) : { level: "overview" });
        }}
        attentionOnly={attentionOnly}
        onAttentionChange={setAttentionOnly}
        sourceMode={sourceMode}
        onSourceModeChange={handleSourceModeChange}
        onRefresh={() => {
          if (sourceMode === "live") {
            void loadLive();
            return;
          }
          const demo = createDemoSnapshot();
          replayMaxRef.current = snapshotBounds(demo).max;
          replayCutoffRef.current = replayMaxRef.current;
          bufferedLiveSnapshotRef.current = null;
          setReplayCutoff(replayMaxRef.current);
          setLiveUnavailable(false);
          setSnapshot(demo);
        }}
        refreshing={refreshing}
        liveUnavailable={liveUnavailable}
        replayActive={replayActive}
        onResetReplay={returnToLive}
      />

      <main className="app-layout">
        <section className="world-column" aria-label="Agent workspace">
          <div className="world-frame">
            <Archipelago
              snapshot={displaySnapshot}
              selectedId={selectedId ?? undefined}
              onSelect={handleSelectAgent}
              replayCutoff={replayCutoff}
              visibleAgentIds={visibleAgentIds}
              navigation={navigation}
              onNavigate={handleNavigation}
              evidenceLensOn={evidenceLensOn}
              onEvidenceLensChange={setEvidenceLensOn}
              onClearSelection={() => {
                setSelectedId(null);
                setInspectorOpen(false);
              }}
              onOpenInspector={() => {
                const activeElement = document.activeElement;
                inspectorOpenerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
                setUtilityPanel(null);
                setInspectorOpen(true);
              }}
              emptyState={emptyState}
              missionWorld={missionWorld}
            />
          </div>
        </section>

        {selectedAgent && inspectorOpen ? (
          <Inspector
            agent={selectedAgent}
            mode={snapshot.mode}
            replayCutoff={replayCutoff}
            opener={inspectorOpenerRef.current}
            onClose={() => setInspectorOpen(false)}
          />
        ) : null}
      </main>

      <footer className="app-footer">
        <span><span className="footer-pulse" aria-hidden="true" />{
          liveUnavailable
            ? "Live source unavailable"
            : sourceMode === "demo"
              ? "Demo sample"
              : sourceNeedsSetup
                ? "Live source not connected"
                : observerStopped
                  ? "Source stopped safely"
                  : sourceUnavailable
                    ? "Live source unavailable"
                    : sourceStarting
                      ? "Connecting to local source"
                      : "Live local source"
        }</span>
        <span>Prompts and payloads are never displayed</span>
      </footer>
    </div>
  );
}

export default App;
