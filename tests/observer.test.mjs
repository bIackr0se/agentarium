import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { EventEmitter, once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createApiServer, createSseHub } from "../server/api.mjs";
import { classifyThread, isAttentionState, STALE_AFTER_MS } from "../server/classifier.mjs";
import { createDemoSnapshot } from "../server/fixtures.mjs";
import { createObserver, HISTORY_ITEM_METADATA_COLUMNS, selectRecentItemRows } from "../server/observer.mjs";
import { assertPrivacySafe, redactText, scanPrivacy } from "../server/privacy.mjs";
import { normalizeSnapshot } from "../server/snapshot-contract.mjs";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");

function createFixture({ drift = false, malformed = false, withMetadata = false, includeInternalRoot = false, includeNamedRoot = false, agentPaths = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentarium-observer-"));
  const statePath = join(dir, "state.sqlite");
  const historyPath = join(dir, "history.sqlite");
  const state = new DatabaseSync(statePath);
  const history = new DatabaseSync(historyPath);
  const metadataColumns = withMetadata ? ", name TEXT, agent_nickname TEXT, agent_role TEXT" : "";
  const metadataInsertColumns = withMetadata ? ", name, agent_nickname, agent_role" : "";
  const metadataInsertValues = withMetadata ? ", ?, ?, ?" : "";
  const pathFor = (name, fallback) => Object.prototype.hasOwnProperty.call(agentPaths, name) ? agentPaths[name] : fallback;
  const positiveAgentPath = pathFor("positive", "/Users/example/private-worktree");
  const childAgentPath = pathFor("child", "/Users/example/child");
  const internalAgentPath = pathFor("internal", "/Users/example/internal");
  state.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, archived INTEGER NOT NULL, source TEXT NOT NULL,
      model TEXT, ${drift ? "" : "reasoning_effort TEXT,"} tokens_used INTEGER NOT NULL, approval_mode TEXT NOT NULL,
      git_branch TEXT, agent_path TEXT, project_id TEXT, cwd TEXT NOT NULL${metadataColumns}
    );
  `);
  history.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL,
      started_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
      PRIMARY KEY (thread_id, turn_id)
    );
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, item_id)
    );
  `);
  const project = state.prepare("INSERT INTO projects VALUES (?, ?, ?)");
  project.run("p1", "Fixture Lab", 0);
  const thread = state.prepare(`INSERT INTO threads
    (id,title,created_at,updated_at,updated_at_ms,archived,source,model,${drift ? "" : "reasoning_effort,"}tokens_used,approval_mode,git_branch,agent_path,project_id,cwd${metadataInsertColumns})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${drift ? "" : "?, "}?, ?, ?, ?, ?, ?${metadataInsertValues})`);
  const threadArgs = [
    "thread-positive",
    malformed ? "Fixture title api_key=example-secret-token-12345678901234567890" : withMetadata ? "Root title".padEnd(97, "x") : "Fixture task",
    Math.trunc(NOW / 1000), Math.trunc(NOW / 1000), NOW, 0, "fixture", "gpt-5.6-sol",
    ...(drift ? [] : ["xhigh"]), 42, "on-request", "feat/fixture", positiveAgentPath, "p1", "/Users/example/private-worktree",
    ...(withMetadata ? ["Fixture named task", null, null] : []),
  ];
  thread.run(...threadArgs);
  thread.run(
    "thread-child", withMetadata ? "Child title".padEnd(97, "y") : "Child task", Math.trunc(NOW / 1000), Math.trunc(NOW / 1000), NOW, 0, "fixture", "gpt-5.6-luna",
    ...(drift ? [] : ["max"]), 5, "never", "main", childAgentPath, "p1", "/Users/example/child",
    ...(withMetadata ? [null, "Maxwell", "explorer"] : []),
  );
  if (includeInternalRoot) {
    thread.run(
      "thread-internal", "", Math.trunc(NOW / 1000), Math.trunc(NOW / 1000), NOW, 0, "fixture", "gpt-5.4-mini",
      ...(drift ? [] : ["low"]), 0, "never", "main", internalAgentPath, null, "/Users/example/internal",
      ...(withMetadata ? [null, null, null] : []),
    );
  }
  if (includeNamedRoot) {
    thread.run(
      "thread-named-root", "Named root task", Math.trunc(NOW / 1000), Math.trunc(NOW / 1000), NOW, 0, "fixture", "gpt-5.6-sol",
      ...(drift ? [] : ["xhigh"]), 0, "never", "main", "/Users/example/named-root", "p1", "/Users/example/named-root",
      ...(withMetadata ? [null, null, null] : []),
    );
  }
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run("thread-positive", "thread-child", "completed");
  const turn = history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)");
  turn.run("thread-positive", "turn-1", 1, "inProgress", Math.trunc(NOW / 1000), null, null);
  turn.run("thread-child", "turn-1", 1, "completed", Math.trunc(NOW / 1000) - 10, Math.trunc(NOW / 1000), 10_000);
  const item = history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)");
  const planted = JSON.stringify({
    type: "commandExecution",
    id: "item-1",
    status: "inProgress",
    command: "cat /Users/example/private-worktree/.env",
    cwd: "/Users/example/private-worktree",
    aggregatedOutput: "api_key=example-secret-token-12345678901234567890 owner@example.com 10.0.0.7",
    durationMs: 12,
  });
  item.run("thread-positive", "turn-1", "item-1", 1, NOW, planted, "commandExecution");
  item.run("thread-child", "turn-1", "item-2", 1, NOW - 1_000, JSON.stringify({ type: "fileChange", status: "completed" }), "fileChange");
  if (malformed) item.run("thread-positive", "turn-1", "item-bad", 2, NOW, "not-json", "unknownActivity");
  state.close();
  history.close();
  return { dir, statePath, historyPath };
}

function createCatalog(fixture, rows) {
  const catalogPath = join(fixture.dir, "catalog.sqlite");
  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE local_thread_catalog (
      thread_id TEXT NOT NULL,
      display_title TEXT NOT NULL,
      missing_candidate INTEGER NOT NULL,
      source_recency_at REAL NOT NULL
    );
  `);
  const insert = catalog.prepare("INSERT INTO local_thread_catalog VALUES (?, ?, ?, ?)");
  for (const row of rows) insert.run(row.threadId, row.displayTitle, row.missingCandidate ? 1 : 0, row.sourceRecencyAt);
  catalog.close();
  return catalogPath;
}

function disposeFixture(fixture) {
  rmSync(fixture.dir, { recursive: true, force: true });
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest(parsed, {
      method: options.method ?? "GET",
      headers: { Connection: "close", ...(options.headers ?? {}) },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: chunks.join("") }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

test("demo fixture is deterministic, complete, and privacy-safe", () => {
  const first = createDemoSnapshot(NOW);
  const second = createDemoSnapshot(NOW);
  assert.deepEqual(first, second);
  assert.equal(first.mode, "demo");
  assert.equal(first.privacy.rawContentExposed, false);
  assert.deepEqual(first.projects.map((project) => project.id), ["release-readiness", "product-update", "source-review", "field-research"]);
  assert.deepEqual(first.projects.map((project) => project.name), ["Release Readiness", "Product Update", "Source Review", "Field Research"]);
  assert.equal(first.agents.length, 12);
  assert.deepEqual(first.agents.filter((agent) => agent.projectId === "release-readiness").map((agent) => agent.id), ["release-verifier", "release-probe", "release-scout", "release-mapper"]);
  assert.deepEqual(
    first.agents.filter((agent) => !agent.parentAgentId).map((agent) => agent.title),
    ["Verify release candidate", "Draft product update", "Coordinate field research", "Approve interface direction", "Review current sources"],
  );
  assert.equal(/aurora|signal garden|atlas research|frontier lab/i.test(JSON.stringify(first)), false);
  const demoStates = new Set(first.agents.map((agent) => agent.state));
  for (const state of ["reading", "editing", "running", "delegating", "waiting", "needs-you", "verifying", "complete", "interrupted"]) {
    assert.equal(demoStates.has(state), true, `missing demo state: ${state}`);
  }
  const queuedStates = new Set(first.agents.filter((agent) => first.attention.includes(agent.id)).map((agent) => agent.state));
  assert.deepEqual([...queuedStates].sort(), ["needs-you", "waiting"]);
  assert.equal(first.agents.some((agent) => first.attention.includes(agent.id) && ["interrupted", "stale"].includes(agent.state)), false);
  assert.ok(first.agents.filter((agent) => agent.parentAgentId).length >= 6);
  assert.ok(first.agents.filter((agent) => !agent.parentAgentId).every((agent) => agent.childCount > 0));
  assert.equal(/Private Alpha|Private Beta|Private Gamma|Private Epsilon|Private Delta/i.test(JSON.stringify(first)), false);
  assert.deepEqual(scanPrivacy(first), { safe: true, findings: [] });
  assert.deepEqual(normalizeSnapshot(first, { mode: "demo", nowMs: NOW }), first);
  for (const agent of first.agents) {
    assert.equal(typeof agent.lastSeen, "string");
    assert.equal(typeof agent.ageMs, "number");
    assert.ok(Array.isArray(agent.events));
  }
});

test("live snapshot scans bounded item metadata before loading event payloads", () => {
  assert.equal(HISTORY_ITEM_METADATA_COLUMNS.includes("item_json"), false);
  const candidates = Array.from({ length: 64 }, (_, index) => ({
    item_id: `item-${index}`,
    rollout_ordinal: 100 - index,
    created_at_ms: NOW - index * 1_000,
  }));
  candidates[63].created_at_ms = NOW + 1_000;

  const selected = selectRecentItemRows(candidates, 8);
  assert.equal(selected.length, 8);
  assert.equal(selected[0].item_id, "item-63");
  assert.equal(selected.some((row) => row.item_id === "item-0"), true);
  assert.equal(selected.some((row) => row.item_id === "item-8"), false);
});

test("live adapter reads only allowlisted metadata and builds a recent timeline", () => {
  const fixture = createFixture();
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
    eventLimit: 8,
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  assert.equal(snapshot.mode, "live");
  assert.equal(snapshot.agents.length, 2);
  const positive = snapshot.agents.find((agent) => agent.id === "thread-positive");
  assert.ok(positive);
  assert.equal(positive.state, "running");
  assert.equal(positive.evidence, "derived");
  assert.equal(positive.projectName, "Fixture Lab");
  assert.equal(positive.childCount, 1);
  assert.equal(positive.branch, "feat/fixture");
  assert.equal(positive.events[0].kind, "command");
  assert.equal(positive.events[0].label, "Command activity");
  assert.ok(positive.events.length <= 4);
  assert.equal("nickname" in positive, false);
  assert.equal("role" in positive, false);
  const wire = JSON.stringify(snapshot);
  assert.ok(!wire.includes("example-secret-token-12345678901234567890"));
  assert.ok(!wire.includes("owner@example.com"));
  assert.ok(!wire.includes("/Users/example/private-worktree"));
  assert.ok(!wire.includes("10.0.0.7"));
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("oversized lifecycle payloads are skipped while typed activity remains usable", () => {
  const fixture = createFixture();
  const history = new DatabaseSync(fixture.historyPath);
  history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "thread-positive",
    "turn-1",
    "item-oversized",
    2,
    NOW + 1_000,
    JSON.stringify({ status: "inProgress", raw: "x".repeat(200_000) }),
    "reasoning",
  );
  history.close();

  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
    eventLimit: 8,
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW + 2_000 });
  const agent = snapshot.agents.find((candidate) => candidate.id === "thread-positive");
  assert.equal(agent.state, "thinking");
  assert.equal(agent.events[0].label, "Thinking");
  assert.equal(JSON.stringify(snapshot).includes("x".repeat(200)), false);
  observer.close();
  disposeFixture(fixture);
});

test("current thread metadata names tasks and agents without exposing source fields", () => {
  const fixture = createFixture({ withMetadata: true });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
    eventLimit: 8,
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const root = snapshot.agents.find((agent) => agent.id === "thread-positive");
  const child = snapshot.agents.find((agent) => agent.id === "thread-child");
  assert.ok(root);
  assert.ok(child);

  assert.equal(root.title, "Fixture named task");
  assert.equal(child.title, "Untitled task · ad-child");
  assert.equal(child.nickname, "Maxwell");
  assert.equal(child.role, "explorer");
  assert.equal("nickname" in root, false);
  assert.equal("role" in root, false);

  const wire = JSON.stringify(snapshot);
  for (const prohibited of ["agent_path", "agentPath", "first_user_message", "preview", "cwd", "item_json"]) {
    assert.equal(wire.includes(prohibited), false, `prohibited field leaked: ${prohibited}`);
  }
  assert.equal(wire.includes("Root title"), false);
  assert.equal(wire.includes("Child title"), false);
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("derives a readable assignment from the final path segment without exposing the path", () => {
  const fixture = createFixture({
    withMetadata: true,
    agentPaths: { positive: "/root", child: "/root/fresh-public_scan" },
  });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const root = snapshot.agents.find((agent) => agent.id === "thread-positive");
  const child = snapshot.agents.find((agent) => agent.id === "thread-child");

  assert.ok(root);
  assert.ok(child);
  assert.equal(root.assignment, undefined, "the /root sentinel is not an assignment");
  assert.equal(child.assignment, "Fresh public scan");
  const wire = JSON.stringify(snapshot);
  assert.ok(wire.includes("Fresh public scan"));
  assert.equal(wire.includes("/root/fresh-public_scan"), false);
  assert.equal(wire.includes("agent_path"), false);
  assert.equal(wire.includes("agentPath"), false);
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("omits null and generic assignment basenames while retaining metadata fallbacks", () => {
  const fixture = createFixture({
    withMetadata: true,
    includeInternalRoot: true,
    agentPaths: { positive: "/root", child: null, internal: "/root/agent" },
  });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const child = snapshot.agents.find((agent) => agent.id === "thread-child");
  const internal = snapshot.agents.find((agent) => agent.id === "thread-internal");

  assert.ok(child);
  assert.ok(internal);
  assert.equal("assignment" in child, false);
  assert.equal("assignment" in internal, false);
  assert.equal(child.nickname, "Maxwell");
  assert.equal(child.role, "explorer");
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("rejects punctuation-only path basenames", () => {
  const fixture = createFixture({
    agentPaths: { positive: "/root/---", child: "/root/___" },
  });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });

  assert.ok(snapshot.agents.every((agent) => !("assignment" in agent)));
  const wire = JSON.stringify(snapshot);
  assert.equal(wire.includes("/root/---"), false);
  assert.equal(wire.includes("/root/___"), false);
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("rejects secret-shaped assignment basenames before humanizing separators", () => {
  const fixture = createFixture({
    agentPaths: { positive: "/root", child: "/root/api_key=example-secret-token-12345678901234567890" },
  });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const child = snapshot.agents.find((agent) => agent.id === "thread-child");

  assert.ok(child);
  assert.equal("assignment" in child, false);
  const wire = JSON.stringify(snapshot);
  assert.equal(wire.includes("example-secret-token-12345678901234567890"), false);
  assert.equal(wire.includes("api key="), false);
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("without a catalog, legacy unnamed roots and spawned children remain visible", () => {
  const fixture = createFixture({ includeInternalRoot: true });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });

  assert.equal(snapshot.agents.length, 3);
  assert.ok(snapshot.agents.some((agent) => agent.id === "thread-internal"));
  assert.ok(snapshot.agents.some((agent) => agent.id === "thread-child"));
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("catalog titles win by recency, retain spawned children, and omit internal roots", () => {
  const fixture = createFixture({ withMetadata: true, includeInternalRoot: true });
  const catalogPath = createCatalog(fixture, [
    { threadId: "thread-positive", displayTitle: "Older catalog title", sourceRecencyAt: 10, missingCandidate: false },
    { threadId: "thread-positive", displayTitle: "Newest catalog title", sourceRecencyAt: 20, missingCandidate: false },
    { threadId: "thread-positive", displayTitle: "Ignored missing title", sourceRecencyAt: 30, missingCandidate: true },
    { threadId: "thread-positive", displayTitle: "???", sourceRecencyAt: 40, missingCandidate: false },
  ]);
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: catalogPath,
    eventLimit: 8,
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const root = snapshot.agents.find((agent) => agent.id === "thread-positive");
  const child = snapshot.agents.find((agent) => agent.id === "thread-child");

  assert.equal(snapshot.agents.length, 2);
  assert.ok(root);
  assert.ok(child);
  assert.equal(root.title, "Newest catalog title");
  assert.equal(root.title === "Fixture named task", false);
  assert.equal(child.title, "Untitled task · ad-child");
  assert.equal(child.nickname, "Maxwell");
  assert.equal(child.role, "explorer");
  assert.equal(snapshot.agents.some((agent) => agent.id === "thread-internal"), false);

  const wire = JSON.stringify(snapshot);
  for (const prohibited of [
    "display_title", "missing_candidate", "source_recency_at", "source_kind", "source_detail", "cwd",
  ]) {
    assert.equal(wire.includes(prohibited), false, `catalog field leaked: ${prohibited}`);
  }
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  assert.equal(observer._catalogDb, null);
  disposeFixture(fixture);
});

test("a valid empty catalog retains a standalone root with a meaningful persisted title", () => {
  const fixture = createFixture({ includeNamedRoot: true });
  const catalogPath = createCatalog(fixture, []);
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: catalogPath,
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const namedRoot = snapshot.agents.find((agent) => agent.id === "thread-named-root");

  assert.ok(namedRoot);
  assert.equal(namedRoot.title, "Named root task");
  assert.equal(namedRoot.parentAgentId, undefined);
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("classifier separates unknown, running, and exact stale boundary", () => {
  const base = { updated_at_ms: 1_000 };
  const before = classifyThread({ thread: base, turn: { status: "inProgress" }, latestItemType: "not-known", nowMs: 1_000 + STALE_AFTER_MS - 1 });
  const exact = classifyThread({ thread: base, turn: { status: "inProgress" }, latestItemType: "not-known", nowMs: 1_000 + STALE_AFTER_MS });
  const running = classifyThread({ thread: base, turn: { status: "inProgress" }, latestItemType: "commandExecution", latestItem: { status: "inProgress" }, nowMs: 1_000 + STALE_AFTER_MS * 4 });
  assert.equal(before.state, "unknown");
  assert.equal(exact.state, "stale");
  assert.equal(exact.attentionReason, undefined);
  assert.equal(running.state, "running");
  assert.equal(running.evidence, "derived");

  const oldWithoutLifecycle = classifyThread({ thread: base, turn: null, latestItem: null, nowMs: 1_000 + STALE_AFTER_MS * 4 });
  assert.equal(oldWithoutLifecycle.state, "unknown");
  assert.equal(oldWithoutLifecycle.attentionReason, undefined);
});

test("turn lifecycle outranks a failed operation and live recovery stays active", () => {
  const thread = { updated_at_ms: 2_000 };
  const completedAfterFailure = classifyThread({
    thread,
    turn: { status: "completed" },
    latestItemType: "commandExecution",
    latestItem: { status: "failed" },
    nowMs: 3_000,
  });
  const recovering = classifyThread({
    thread,
    turn: { status: "inProgress" },
    latestItemType: "commandExecution",
    latestItem: { status: "failed" },
    nowMs: 3_000,
  });
  const itemOnlyFailure = classifyThread({
    thread,
    turn: null,
    latestItemType: "commandExecution",
    latestItem: { status: "failed" },
    nowMs: 3_000,
  });

  assert.deepEqual(
    { state: completedAfterFailure.state, evidence: completedAfterFailure.evidence, attention: completedAfterFailure.attentionReason },
    { state: "complete", evidence: "observed", attention: undefined },
  );
  assert.deepEqual(
    { state: recovering.state, evidence: recovering.evidence, action: recovering.currentAction, attention: recovering.attentionReason },
    { state: "thinking", evidence: "derived", action: "Recovering from a failed operation", attention: undefined },
  );
  assert.equal(itemOnlyFailure.state, "failed");
  assert.equal(itemOnlyFailure.attentionReason, "The latest agent run failed");
});

test("observer infers current activity from wall-clock order within the latest turn", () => {
  const fixture = createFixture();
  const history = new DatabaseSync(fixture.historyPath);
  const insert = history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run(
    "thread-positive",
    "turn-1",
    "item-older-failure",
    99,
    NOW - 60_000,
    JSON.stringify({ type: "commandExecution", status: "failed" }),
    "commandExecution",
  );
  insert.run(
    "thread-positive",
    "turn-1",
    "item-newer-reasoning",
    2,
    NOW + 1_000,
    JSON.stringify({ type: "reasoning", status: "inProgress" }),
    "reasoning",
  );
  history.close();

  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
    eventLimit: 8,
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW + 2_000 });
  const agent = snapshot.agents.find((candidate) => candidate.id === "thread-positive");

  assert.equal(agent.state, "thinking");
  assert.equal(agent.currentAction, "Thinking through the next step");
  assert.equal(agent.events.some((event) => event.status === "failed"), true);
  assert.equal(agent.events[0].label, "Thinking");
  observer.close();
  disposeFixture(fixture);
});

test("waiting reflects an open wait call and completed work cannot freeze the queue", () => {
  const freshThread = { updated_at_ms: 1_000 };
  const waiting = classifyThread({
    thread: freshThread,
    turn: { status: "inProgress" },
    latestItemType: "collabAgentToolCall",
    latestItem: { tool: "wait", status: "inProgress" },
    nowMs: 2_000,
  });
  const completedWait = classifyThread({
    thread: freshThread,
    turn: { status: "inProgress" },
    latestItemType: "collabAgentToolCall",
    latestItem: { tool: "wait", status: "completed" },
    nowMs: 2_000,
  });
  const completedAndOld = classifyThread({
    thread: freshThread,
    turn: { status: "inProgress" },
    latestItemType: "commandExecution",
    latestItem: { status: "completed" },
    nowMs: 1_000 + STALE_AFTER_MS,
  });

  assert.equal(waiting.state, "waiting");
  assert.equal(completedWait.state, "thinking");
  assert.equal(completedWait.evidence, "derived");
  assert.equal(completedWait.currentAction, "Turn active after the last operation finished");
  assert.equal(completedAndOld.state, "stale");
});

test("the live queue excludes historical interruption and stale-health states", () => {
  assert.equal(isAttentionState("waiting"), true);
  assert.equal(isAttentionState("needs-you"), true);
  assert.equal(isAttentionState("failed"), true);
  assert.equal(isAttentionState("interrupted"), false);
  assert.equal(isAttentionState("stale"), false);
  assert.equal(isAttentionState("complete"), false);
});

test("only explicit approval evidence creates a human gate", () => {
  const policyOnly = classifyThread({
    thread: { updated_at_ms: 1_000, approval_mode: "on-request" },
    turn: { status: "inProgress" },
    latestItemType: "reasoning",
    latestItem: { status: "inProgress" },
    nowMs: 2_000,
  });
  const explicitGate = classifyThread({
    thread: { updated_at_ms: 1_000, approval_mode: "never" },
    turn: { status: "inProgress" },
    latestItemType: "approvalRequest",
    latestItem: { status: "inProgress" },
    nowMs: 2_000,
  });

  assert.equal(policyOnly.state, "thinking");
  assert.equal(policyOnly.attentionReason, undefined);
  assert.equal(explicitGate.state, "needs-you");
  assert.equal(explicitGate.attentionReason, "Approval or input is requested");
});

test("null and malformed evidence fail closed", () => {
  const nullResult = classifyThread({ thread: null, turn: null, latestItem: null, latestItemType: null, nowMs: NOW });
  assert.equal(nullResult.state, "unknown");
  assert.equal(nullResult.evidence, "unknown");

  const fixture = createFixture({ malformed: true });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  const malformed = snapshot.agents.find((agent) => agent.id === "thread-positive");
  assert.ok(malformed);
  assert.equal(malformed.state, "unknown");
  assert.ok(snapshot.warnings.some((warning) => warning.includes("malformed")));
  assert.ok(!JSON.stringify(snapshot).includes("not-json"));
  observer.close();
  disposeFixture(fixture);
});

test("privacy detector catches a planted secret, and redaction restores safety", () => {
  const planted = { title: "api_key=example-secret-token-12345678901234567890", nested: { email: "owner@example.com", cwd: "/Users/example/private" } };
  const report = scanPrivacy(planted);
  assert.equal(report.safe, false);
  assert.ok(report.findings.length >= 3);
  assert.throws(() => assertPrivacySafe(planted), /privacy boundary/i);
  const redacted = redactText("api_key=example-secret-token-12345678901234567890 owner@example.com /Users/example/private 10.0.0.7");
  assert.ok(redacted.redactions >= 4);
  assert.deepEqual(scanPrivacy({ title: redacted.value }), { safe: true, findings: [] });
});

test("privacy redaction catches absolute paths after key delimiters", () => {
  const planted = "cwd=/Users/example/private path:/home/example/secret source=file:///private/tmp/data";
  const report = scanPrivacy({ title: planted });
  assert.equal(report.safe, false);
  assert.ok(report.findings.some((finding) => finding.endsWith(":path")));

  const redacted = redactText(planted);
  assert.equal(redacted.value.includes("/Users/example/private"), false);
  assert.equal(redacted.value.includes("/home/example/secret"), false);
  assert.equal(redacted.value.includes("file:///private/tmp/data"), false);
  assert.equal(redacted.value, "cwd=[redacted-path] path:[redacted-path] source=[redacted-path]");
  assert.ok(redacted.redactions >= 3);
  assert.deepEqual(scanPrivacy({ title: redacted.value }), { safe: true, findings: [] });
});

test("privacy detector covers underscore secrets, generic POSIX paths, and compressed IPv6", () => {
  const positive = [
    "sk_live_12345678901234567890",
    "token_12345678901234567890",
    "/repo/worktree",
    "/run/user/501/socket",
    "/tmp",
    "/Users/José/code",
    "/home/dev+ops/work",
    "/repo/José/code",
    "/Users/José Rahman/O'Brien/code",
    "/repo/My Project/O'Brien/file",
    "/TMP",
    "C:\\Users\\José Rahman\\code",
    "file:///Users/José Rahman/code",
    "fe80::1",
    "2001:db8::dead:beef",
    "::ffff:192.0.2.1",
  ];
  for (const value of positive) {
    assert.equal(scanPrivacy({ value }).safe, false, `expected detector hit for ${value}`);
    const redacted = redactText(value);
    assert.equal(scanPrivacy({ value: redacted.value }).safe, true, `expected redaction for ${value}`);
    assert.ok(redacted.redactions >= 1, `expected redaction count for ${value}`);
  }

  const negative = [
    "read/write",
    "https://example.com/docs",
    "1:2:3",
    "token_1234",
    "ordinary project note",
  ];
  for (const value of negative) {
    assert.deepEqual(scanPrivacy({ value }), { safe: true, findings: [] }, `unexpected detector hit for ${value}`);
    assert.equal(redactText(value).value, value);
  }
  assert.deepEqual(redactText(null), { value: "", redactions: 0 });
  assert.deepEqual(redactText(undefined), { value: "", redactions: 0 });
  assert.equal(redactText("/Users/José/code").value, "[redacted-path]");
  assert.equal(redactText("/home/dev+ops/work").value, "[redacted-path]");
  assert.equal(redactText("/repo/José/code").value, "[redacted-path]");
  assert.equal(redactText("/Users/José Rahman/O'Brien/code").value, "[redacted-path]");
  assert.equal(redactText("/repo/My Project/O'Brien/file").value, "[redacted-path]");
  assert.equal(redactText("/TMP").value, "[redacted-path]");
  assert.equal(redactText("cwd=/Users/José Rahman/code action=running").value, "cwd=[redacted-path] action=running");
  assert.equal(redactText(",/Users/José Rahman/code").value, ",[redacted-path]");
  assert.equal(redactText(">/Users/José Rahman/code").value, ">[redacted-path]");
  assert.equal(redactText(";/Users/José Rahman/code").value, ";[redacted-path]");
  assert.equal(redactText("|/Users/José Rahman/code").value, "|[redacted-path]");
  assert.equal(redactText("[/Users/José Rahman/code").value, "[[redacted-path]");
  assert.equal(redactText("{/Users/José Rahman/code").value, "{[redacted-path]");
  assert.equal(scanPrivacy({ filepath: "relative.txt" }).safe, false);
  assert.equal(scanPrivacy({ pathname: "relative.txt" }).safe, false);
});

test("event stream rechecks the privacy boundary before writing a snapshot", () => {
  const observer = {
    getSnapshot: () => ({ schemaVersion: 1, title: "api_key=example-secret-token-12345678901234567890" }),
  };
  const request = new EventEmitter();
  const response = new EventEmitter();
  const writes = [];
  response.writeHead = () => {};
  response.write = (chunk) => { writes.push(String(chunk)); };
  response.end = () => {};
  const hub = createSseHub(observer, { intervalMs: 30_000 });
  try {
    hub.connect(request, response, "live");
    const wire = writes.join("");
    assert.match(wire, /event: error/);
    assert.ok(!wire.includes("example-secret-token"));
  } finally {
    hub.close();
  }
});

test("schema drift produces an empty live view instead of guessed records", () => {
  const fixture = createFixture({ drift: true });
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const diagnostics = observer.diagnostics();
  assert.equal(diagnostics.ready, false);
  assert.equal(diagnostics.schema.valid, false);
  const snapshot = observer.getSnapshot({ nowMs: NOW });
  assert.equal(snapshot.agents.length, 0);
  assert.equal(snapshot.projects.length, 0);
  assert.ok(snapshot.warnings.some((warning) => warning.includes("schema")));
  assert.deepEqual(scanPrivacy(snapshot), { safe: true, findings: [] });
  observer.close();
  disposeFixture(fixture);
});

test("API is loopback-only, read-only, and serves a contract snapshot", async () => {
  const fixture = createFixture();
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    catalogDbPath: join(fixture.dir, "missing-catalog.sqlite"),
  });
  const server = createApiServer({ observer });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const worldResponse = await requestText(`${base}/api/world`);
    assert.equal(worldResponse.status, 200);
    const world = JSON.parse(worldResponse.body);
    assert.equal(world.schemaVersion, 1);
    assert.equal(world.privacy.rawContentExposed, false);
    assert.deepEqual(scanPrivacy(world), { safe: true, findings: [] });

    const demoResponse = await requestText(`${base}/api/world?mode=demo`);
    assert.equal(demoResponse.status, 200);
    assert.equal(JSON.parse(demoResponse.body).mode, "demo");

    const eventsResponse = await requestText(`${base}/api/agents/thread-positive/events`);
    assert.equal(eventsResponse.status, 200);
    const eventPayload = JSON.parse(eventsResponse.body);
    assert.equal(eventPayload.agentId, "thread-positive");
    assert.equal(eventPayload.events.every((event) => event.agentId === "thread-positive"), true);

    const malformedAgentResponse = await requestText(`${base}/api/agents/%ZZ/events`);
    assert.equal(malformedAgentResponse.status, 400);
    assert.deepEqual(JSON.parse(malformedAgentResponse.body), { error: "Malformed agent identifier" });
    const healthAfterMalformedRequest = await requestText(`${base}/api/health`);
    assert.equal(healthAfterMalformedRequest.status, 200);

    const writeResponse = await requestText(`${base}/api/world`, { method: "POST" });
    assert.equal(writeResponse.status, 405);

    const remoteHostResponse = await requestText(`${base}/api/world`, { headers: { Host: "example.com" } });
    assert.equal(remoteHostResponse.status, 403);
  } finally {
    // Explicitly close all test-owned sockets, even when an assertion fails.
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    observer.close();
    disposeFixture(fixture);
  }
});
