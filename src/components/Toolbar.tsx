import { WorldIcon } from "./WorldIcon";
import brandMarkUrl from "../assets/brand-mark.svg?no-inline";
import { useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import type { AgentState, ProjectSnapshot, WorldSnapshot } from "../lib/contracts";
import { SourceSetup } from "./SourceSetup";

export type SourceMode = "live" | "demo";

export interface ToolbarProps {
  utilityControls?: ReactNode;
  snapshot: WorldSnapshot;
  projects: ProjectSnapshot[];
  visibleCount: number;
  totalCount: number;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  projectFilter: string;
  onProjectChange: (value: string) => void;
  attentionOnly: boolean;
  onAttentionChange: (value: boolean) => void;
  sourceMode: SourceMode;
  onSourceModeChange: (value: SourceMode) => void;
  onRefresh: () => void;
  refreshing: boolean;
  liveUnavailable: boolean;
  replayActive: boolean;
  onResetReplay: () => void;
}

const stateLabels: Record<AgentState, string> = {
  thinking: "Thinking",
  reading: "Reading",
  editing: "Editing",
  running: "Running",
  delegating: "Delegating",
  waiting: "Waiting",
  "needs-you": "Needs you",
  verifying: "Verifying",
  failed: "Run failed",
  complete: "Complete",
  interrupted: "Last run stopped",
  idle: "Idle",
  stale: "Stale",
  unknown: "Evidence unavailable",
};

function formatFreshness(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "freshness unknown";

  const delta = Math.max(0, Date.now() - parsed);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes === 1) return "updated 1 min ago";
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `updated ${hours}h ago`;
}

function displaySourceFreshness(value: string): string {
  return Number.isFinite(Date.parse(value)) ? formatFreshness(value) : value;
}

export function humanizeState(state: AgentState): string {
  return stateLabels[state] ?? state;
}

export function Toolbar({
  utilityControls,
  snapshot,
  projects,
  visibleCount,
  totalCount,
  searchQuery,
  onSearchChange,
  projectFilter,
  onProjectChange,
  attentionOnly,
  onAttentionChange,
  sourceMode,
  onSourceModeChange,
  onRefresh,
  refreshing,
  liveUnavailable,
  replayActive,
  onResetReplay,
}: ToolbarProps) {
  const advancedFiltersRef = useRef<HTMLDetailsElement>(null);
  const [sourceSetupOpen, setSourceSetupOpen] = useState(false);
  const criticalWarning = snapshot.warnings.find((warning) => /not configured|without configuration/i.test(warning))
    ?? snapshot.warnings.find((warning) => /stopped|unavailable|unreadable|malformed|rejected|schema(?: was)? not recognized|invalid/i.test(warning));
  const selectedProjectName = projectFilter
    ? projects.find((project) => project.id === projectFilter)?.name
    : undefined;
  const activeFilterCount = Number(Boolean(projectFilter)) + Number(attentionOnly) + Number(Boolean(searchQuery.trim()));
  const handleSearch = (event: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(event.target.value);
  };
  const closeAdvancedFilters = () => {
    if (advancedFiltersRef.current) advancedFiltersRef.current.open = false;
  };

  return (
    <header className="toolbar" aria-label="Agentarium controls">
      <div className="toolbar__brand">
        <div className="brand-mark" aria-hidden="true">
          <img src={brandMarkUrl} alt="" width="64" height="64" />
        </div>
        <div>

          <h1>Agentarium</h1>
        </div>
      </div>

      <nav className="primary-navigation" aria-label="Main navigation">
        <button type="button" className="primary-navigation__projects" onClick={() => onProjectChange("")}>Projects</button>
        {utilityControls}
      </nav>

      <div className="toolbar__status" aria-label="Observer status">
        <div className="mode-lockup">
          <span className="mode-lock" aria-hidden="true">⌁</span>
          <div>
            <span className="mode-title">{sourceMode === "demo" ? "Demo / read-only" : "Local live view / read-only"}</span>
            <span className="mode-detail">
              {sourceMode === "demo"
                ? liveUnavailable
                  ? "Live source unavailable · safe demo active"
                  : "Fictional sample"
                : criticalWarning ?? formatFreshness(snapshot.generatedAt)}
            </span>
          </div>
        </div>
        <span className="toolbar__freshness">{displaySourceFreshness(snapshot.sourceFreshness)}</span>
      </div>

      <div className="toolbar__controls">
        <label className="search-field">
          <span className="sr-only">Search agents, projects, or actions</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
            <path d="m20 20-4.2-4.2m1.2-5.3a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={handleSearch}
            placeholder="Find project, task, or agent"
            aria-label="Search agents, projects, or actions"
          />
          {searchQuery ? (
            <button
              type="button"
              className="icon-button search-clear"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
            >
              <WorldIcon name="close" />
            </button>
          ) : null}
        </label>

        <div className="source-switch" role="group" aria-label="Snapshot source">
          <button
            type="button"
            className={sourceMode === "demo" ? "is-active" : ""}
            onClick={() => onSourceModeChange("demo")}
            aria-pressed={sourceMode === "demo"}
            aria-label="Use Demo source"
            title="Use sample data"
          >
            Demo
          </button>
          <button
            type="button"
            className={sourceMode === "live" ? "is-active" : ""}
            onClick={() => onSourceModeChange("live")}
            aria-pressed={sourceMode === "live"}
            aria-label="Use live workspace source"
            title="Use the private live workspace source"
          >
            <span className="live-dot" aria-hidden="true" />
            Live
          </button>
        </div>

        <button
          type="button"
          className={`connect-source-button${sourceSetupOpen ? " is-active" : ""}`}
          aria-expanded={sourceSetupOpen}
          aria-controls="source-setup"
          onClick={() => setSourceSetupOpen((open) => !open)}
        >
          Connect
        </button>


        <details ref={advancedFiltersRef} className="advanced-filters">
          <summary aria-label="Refine view">
            <WorldIcon name="settings" />
            <span><span className="advanced-filters__label--long">Refine view</span><span className="advanced-filters__label--short">Refine</span></span>
            <span className="advanced-filters__count">{activeFilterCount ? `${activeFilterCount} active` : "All"}</span>
          </summary>
          <div className="advanced-filters__body">
        <button
          type="button"
          className="refresh-button refresh-button--menu"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh snapshot"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false" className={refreshing ? "is-spinning" : ""}>
            <path d="M20 11a8 8 0 0 0-14.9-4M4 5v5h5m-5 3a8 8 0 0 0 14.9 4M20 19v-5h-5" />
          </svg>
          <span>Refresh snapshot</span>
        </button>

            <label className="select-field">
              <span className="sr-only">Filter by project</span>
              <select
                value={projectFilter}
                onChange={(event) => {
                  onProjectChange(event.target.value);
                  closeAdvancedFilters();
                }}
                aria-label="Filter by project"
              >
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={`filter-button${attentionOnly ? " is-active" : ""}`}
              onClick={() => {
                onAttentionChange(!attentionOnly);
                closeAdvancedFilters();
              }}
              aria-pressed={attentionOnly}
              aria-label={attentionOnly ? "Show all agents" : "Show agents needing attention"}
            >
              <span className="attention-dot" aria-hidden="true" />
              Agent attention
              <span className="control-count">{snapshot.attention.length}</span>
            </button>
          </div>
        </details>

        <div className="toolbar__stats" aria-label={`${visibleCount} of ${totalCount} agents visible`}>
          <strong>{visibleCount}</strong>
          <span>/ {totalCount} agents</span>
          {selectedProjectName ? <span className="stats-filter">· {selectedProjectName}</span> : null}
          {replayActive ? (
            <button type="button" className="replay-reset" onClick={onResetReplay}>
              Exit replay
            </button>
          ) : null}
        </div>
      </div>

      {sourceSetupOpen ? (
        <div id="source-setup" className="toolbar__source-setup">
          <SourceSetup onClose={() => setSourceSetupOpen(false)} />
        </div>
      ) : null}
    </header>
  );
}
