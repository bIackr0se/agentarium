/**
 * Evidence-aware state classifier.
 *
 * The local databases contain many rich item payloads.  Classification only
 * consumes their typed/status metadata and never returns their text, command,
 * path, or tool fields.  If the evidence does not support a state, the
 * classifier returns `unknown` rather than guessing that a quiet task is
 * sleeping or complete.
 */

export const STALE_AFTER_MS = 30 * 60 * 1000;

const STATES = new Set([
  "thinking",
  "reading",
  "editing",
  "running",
  "delegating",
  "waiting",
  "needs-you",
  "verifying",
  "failed",
  "complete",
  "interrupted",
  "idle",
  "stale",
  "unknown",
]);

const ITEM_STATE = Object.freeze({
  reasoning: "thinking",
  userMessage: "thinking",
  agentMessage: "thinking",
  commandExecution: "running",
  fileChange: "editing",
  mcpToolCall: "reading",
  dynamicToolCall: "reading",
  webSearch: "reading",
  imageView: "reading",
  imageGeneration: "editing",
  subAgentActivity: "delegating",
  collabAgentToolCall: "delegating",
  contextCompaction: "thinking",
  verification: "verifying",
  approval: "needs-you",
  approvalRequest: "needs-you",
});

const ACTIONS = Object.freeze({
  thinking: "Thinking through the next step",
  reading: "Reading evidence",
  editing: "Editing files",
  running: "Running a command",
  delegating: "Coordinating agents",
  waiting: "Waiting on an agent",
  "needs-you": "Needs your attention",
  verifying: "Verifying results",
  failed: "Latest agent run failed",
  complete: "Complete",
  interrupted: "Stopped before completion",
  idle: "Idle",
  stale: "Stale, evidence may be out of date",
  unknown: "State unavailable",
});

const ATTENTION = Object.freeze({
  waiting: "Waiting on another agent or external result",
  "needs-you": "Approval or input is requested",
  failed: "The latest agent run failed",
});

const WORKING_STATES = new Set(["thinking", "reading", "editing", "running", "delegating", "verifying"]);

function asString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeStatus(value) {
  const status = asString(value);
  if (status === "in_progress") return "inProgress";
  if (status === "in-progress") return "inProgress";
  if (status === "complete") return "completed";
  return status;
}

function statusFromItem(item) {
  if (!item || typeof item !== "object") return "";
  const direct = normalizeStatus(item.status);
  if (["inProgress", "completed", "failed", "interrupted", "declined"].includes(direct)) return direct;
  const result = item.result;
  if (result && typeof result === "object") {
    const nested = normalizeStatus(result.status);
    if (["inProgress", "completed", "failed", "interrupted", "declined"].includes(nested)) return nested;
  }
  return "";
}

function stateForItem(itemType, item) {
  const normalized = asString(itemType);
  const explicit = statusFromItem(item);
  if (explicit === "failed") return "failed";
  if (explicit === "interrupted") return "interrupted";
  if (explicit === "completed" || explicit === "declined") return "unknown";
  if (normalized === "approval" || normalized === "approvalRequest") return "needs-you";
  if (normalized === "collabAgentToolCall" && asString(item?.tool).toLowerCase() === "wait" && explicit === "inProgress") return "waiting";
  return ITEM_STATE[normalized] ?? "unknown";
}

function hasApprovalSignal(item) {
  if (!item || typeof item !== "object") return false;
  // Only boolean/enum metadata is consumed.  Arbitrary payloads are never
  // searched for words because doing so would encourage transcript leakage.
  return item.needsApproval === true || item.requiresApproval === true || item.approvalRequested === true ||
    ["approvalRequested", "needsApproval", "waitingForApproval"].includes(asString(item.status));
}

function normalizeNow(nowMs) {
  return Number.isFinite(nowMs) ? Math.max(0, nowMs) : Date.now();
}

function normalizeLastSeen(thread) {
  if (!thread || typeof thread !== "object") return null;
  const candidates = [
    [thread.updated_at_ms, true],
    [thread.updatedAtMs, true],
    [thread.updated_at, false],
    [thread.updatedAt, false],
  ];
  for (const [candidate, alreadyMilliseconds] of candidates) {
    const n = Number(candidate);
    if (!Number.isFinite(n) || n <= 0) continue;
    // SQLite's legacy fields are seconds; *_ms fields are milliseconds even
    // in deterministic fixtures whose clock is intentionally small.
    return alreadyMilliseconds ? n : n * 1000;
  }
  return null;
}

/**
 * Classify one thread.  `turn` is the latest thread_turn row and `latestItem`
 * is a parsed item_json object paired with `latestItemType`.
 */
export function classifyThread({ thread = {}, turn = null, latestItem = null, latestItemType = "", nowMs = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const now = normalizeNow(nowMs);
  const turnStatus = normalizeStatus(turn?.status);
  const itemStatus = statusFromItem(latestItem);
  const lastSeenMs = normalizeLastSeen(thread);
  const ageMs = lastSeenMs === null ? null : Math.max(0, now - lastSeenMs);

  let state = "unknown";
  let evidence = "unknown";
  let attentionReason;
  let currentAction;

  // The turn is the agent lifecycle boundary. A failed or interrupted
  // operation inside a completed turn remains in the event trail, but it must
  // not overwrite the successful lifecycle outcome or become a live blocker.
  if (turnStatus === "failed") {
    state = "failed";
    evidence = "observed";
    attentionReason = ATTENTION.failed;
  } else if (turnStatus === "interrupted") {
    state = "interrupted";
    evidence = "observed";
  } else if (turnStatus === "completed") {
    state = "complete";
    evidence = "observed";
  } else if (turnStatus === "inProgress" && hasApprovalSignal(latestItem)) {
    state = "needs-you";
    evidence = "observed";
  } else if (turnStatus === "inProgress") {
    const inferred = stateForItem(latestItemType, latestItem);
    if (itemStatus === "failed" || itemStatus === "interrupted") {
      // A live agent can recover after an individual operation ends. Keep it
      // active and explain the recovery instead of declaring the whole agent
      // failed while its turn is still open.
      state = "thinking";
      evidence = "derived";
      currentAction = itemStatus === "failed"
        ? "Recovering from a failed operation"
        : "Continuing after an interrupted operation";
    } else if (itemStatus !== "inProgress" && ageMs !== null && ageMs >= staleAfterMs) {
      state = "stale";
      evidence = "derived";
    } else if (itemStatus === "completed" || itemStatus === "declined") {
      state = "thinking";
      evidence = "derived";
      currentAction = "Turn active after the last operation finished";
    } else if (inferred !== "unknown") {
      state = inferred;
      evidence = "derived";
    }
  } else if (turnStatus === "") {
    if (hasApprovalSignal(latestItem)) {
      state = "needs-you";
      evidence = "observed";
    } else if (itemStatus === "failed" || itemStatus === "interrupted") {
      // Some providers expose operation status without a surrounding turn.
      // In that reduced contract, the observed operation is the strongest
      // lifecycle evidence available.
      state = itemStatus;
      evidence = "observed";
      if (state === "failed") attentionReason = ATTENTION.failed;
    }
  }

  if (!STATES.has(state)) state = "unknown";
  if (ATTENTION[state] && !attentionReason) attentionReason = ATTENTION[state];

  return {
    state,
    evidence,
    ageMs,
    lastSeenMs,
    currentAction: currentAction ?? ACTIONS[state] ?? ACTIONS.unknown,
    attentionReason,
  };
}

export function classifyItem(itemType, item = null) {
  const state = stateForItem(itemType, item);
  return {
    state: STATES.has(state) ? state : "unknown",
    evidence: state === "unknown" ? "unknown" : "derived",
    currentAction: ACTIONS[state] ?? ACTIONS.unknown,
  };
}

export function stateAction(state) {
  return ACTIONS[STATES.has(state) ? state : "unknown"];
}

export function stateAttentionReason(state) {
  return ATTENTION[STATES.has(state) ? state : "unknown"];
}

export function isActiveState(state) {
  return WORKING_STATES.has(state);
}

export function isAttentionState(state) {
  return Boolean(ATTENTION[state]);
}

export const ITEM_STATE_MAP = ITEM_STATE;
