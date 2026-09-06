import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createApiHandler } from "../server/api.mjs";
import { createDataSource, loadDataSourceOptions } from "../server/data-source.mjs";
import { createObserver } from "../server/observer.mjs";
import { scanPrivacy } from "../server/privacy.mjs";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const FIXTURE_ROOT = new URL("./fixtures/providers/", import.meta.url);

function fixtureText(name) {
  return readFileSync(new URL(name, FIXTURE_ROOT), "utf8");
}

function fixtureJson(name) {
  return JSON.parse(fixtureText(name));
}

function tempFile(extension, content) {
  const dir = mkdtempSync(join(tmpdir(), "agentarium-provider-matrix-"));
  const path = join(dir, `world.${extension}`);
  writeFileSync(path, content, "utf8");
  return { dir, path };
}

function dispose(file) {
  rmSync(file.dir, { recursive: true, force: true });
}

function createCodexProbe() {
  const dir = mkdtempSync(join(tmpdir(), "agentarium-codex-probe-"));
  const statePath = join(dir, "state.sqlite");
  const historyPath = join(dir, "history.sqlite");
  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, archived INTEGER NOT NULL, source TEXT NOT NULL,
      model TEXT, reasoning_effort TEXT, tokens_used INTEGER NOT NULL, approval_mode TEXT NOT NULL,
      git_branch TEXT, agent_path TEXT, project_id TEXT, cwd TEXT NOT NULL
    );
  `);
  const history = new DatabaseSync(historyPath);
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
  state.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("project-codex-probe", "Codex adapter probe", 0);
  const insertThread = state.prepare(`
    INSERT INTO threads
      (id, title, created_at, updated_at, updated_at_ms, archived, source, model, reasoning_effort,
       tokens_used, approval_mode, git_branch, agent_path, project_id, cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seconds = Math.trunc(NOW / 1000);
  insertThread.run(
    "codex-root", "Codex root probe", seconds, seconds, NOW, 0, "fixture", "gpt-5.6-sol", "high",
    1200, "on-request", "probe", "/tmp/codex-root", "project-codex-probe", "/tmp/codex-root",
  );
  insertThread.run(
    "codex-child", "", seconds, seconds, NOW - 1_000, 0, "fixture", "gpt-5.6-luna", "max",
    300, "never", "probe", "/tmp/codex-child", "project-codex-probe", "/tmp/codex-child",
  );
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run("codex-root", "codex-child", "completed");
  state.close();

  const insertTurn = history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertTurn.run("codex-root", "turn-root", 1, "inProgress", seconds, null, null);
  insertTurn.run("codex-child", "turn-child", 1, "completed", seconds - 1, seconds, 1_000);
  const insertItem = history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertItem.run(
    "codex-root", "turn-root", "item-root", 1, NOW,
    JSON.stringify({ type: "commandExecution", status: "inProgress" }), "commandExecution",
  );
  history.close();
  return { dir, statePath, historyPath };
}

function responseCapture() {
  const response = new EventEmitter();
  response.statusCode = 0;
  response.headers = {};
  response.body = "";
  response.setHeader = (name, value) => { response.headers[name] = value; };
  response.writeHead = (statusCode, headers = {}) => {
    response.statusCode = statusCode;
    Object.assign(response.headers, headers);
  };
  response.write = (chunk) => {
    response.body += String(chunk);
    return true;
  };
  response.end = (chunk = "") => { response.body += String(chunk); };
  return response;
}

function request(url) {
  return { method: "GET", url, headers: {}, socket: {} };
}

function rootGroups(snapshot) {
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const groups = new Map();
  for (const agent of snapshot.agents) {
    let root = agent;
    const seen = new Set();
    while (root.parentAgentId && !seen.has(root.id)) {
      seen.add(root.id);
      const parent = byId.get(root.parentAgentId);
      if (!parent) break;
      root = parent;
    }
    const members = groups.get(root.id) ?? [];
    members.push(agent.id);
    groups.set(root.id, members);
  }
  return groups;
}

test("Codex local observer is the first real adapter probe", () => {
  const fixture = createCodexProbe();
  const observer = createObserver({
    stateDbPath: fixture.statePath,
    historyDbPath: fixture.historyPath,
    snapshotEventLimit: 4,
  });
  try {
    const world = observer.getSnapshot({ nowMs: NOW });
    assert.equal(world.mode, "live");
    assert.equal(world.projects[0]?.name, "Codex adapter probe");
    assert.equal(world.agents.length, 2);
    const child = world.agents.find((agent) => agent.id === "codex-child");
    assert.equal(child?.parentAgentId, "codex-root");
    assert.equal(observer.diagnostics().readOnly, true);
    assert.deepEqual(scanPrivacy(world), { safe: true, findings: [] });
  } finally {
    observer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("Claude Code normalized JSON fixture crosses the public contract", () => {
  const input = fixtureJson("claude-code-normalized.json");
  input.rawTranscript = "private transcript";
  input.agents[0].cwd = "/Users/example/private-worktree";
  input.agents[0].command = "cat /Users/example/private-worktree/.env";
  input.agents[1].toolResult = "api_key=example-secret-token-12345678901234567890";
  const file = tempFile("json", JSON.stringify(input));
  try {
    const source = createDataSource({ provider: "json", snapshotPath: file.path, env: {} });
    const world = source.getSnapshot({ nowMs: NOW });
    const wire = JSON.stringify(world);
    assert.equal(source.diagnostics().provider, "snapshot-json");
    assert.equal(world.sourceLabel, "Claude Code normalized fixture");
    assert.equal(world.projects.length, 1);
    assert.equal(world.agents.length, 2);
    assert.equal(world.agents.find((agent) => agent.id === "claude-review")?.parentAgentId, "claude-root");
    assert.equal(wire.includes("rawTranscript"), false);
    assert.equal(wire.includes("private-worktree"), false);
    assert.equal(wire.includes("example-secret-token"), false);
    assert.deepEqual(scanPrivacy(world), { safe: true, findings: [] });
    source.close();
  } finally {
    dispose(file);
  }
});

test("OpenAI Agents SDK normalized JSONL fixture recovers the last complete record", () => {
  const file = tempFile("jsonl", fixtureText("openai-agents-sdk-normalized.jsonl"));
  try {
    const source = createDataSource({ provider: "jsonl", snapshotPath: file.path, env: {} });
    const world = source.getSnapshot({ nowMs: NOW });
    const diagnostics = source.diagnostics();
    assert.equal(diagnostics.provider, "snapshot-jsonl");
    assert.equal(diagnostics.recovered, true);
    assert.equal(diagnostics.skippedRecords, 1);
    assert.equal(world.sourceLabel, "OpenAI Agents SDK normalized fixture");
    assert.equal(world.agents.find((agent) => agent.id === "openai-root")?.state, "running");
    assert.equal(world.agents.find((agent) => agent.id === "openai-check")?.state, "complete");
    assert.equal(world.agents.find((agent) => agent.id === "openai-check")?.parentAgentId, "openai-root");
    assert.deepEqual(scanPrivacy(world), { safe: true, findings: [] });
    source.close();
  } finally {
    dispose(file);
  }
});

test("normalized provider records preserve one-time project/task hierarchy membership", () => {
  for (const [provider, filename, extension] of [
    ["json", "claude-code-normalized.json", "json"],
    ["jsonl", "openai-agents-sdk-normalized.jsonl", "jsonl"],
  ]) {
    const file = tempFile(extension, fixtureText(filename));
    try {
      const source = createDataSource({ provider, snapshotPath: file.path, env: {} });
      const world = source.getSnapshot({ nowMs: NOW });
      const groups = rootGroups(world);
      const ids = world.agents.map((agent) => agent.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal([...groups.values()].flat().length, ids.length);
      assert.equal(groups.size, 1);
      assert.equal([...groups.values()][0].length, 2);
      source.close();
    } finally {
      dispose(file);
    }
  }
});

test("JSON startup serves health, snapshot, Demo, and SSE through one contract", async () => {
  const file = tempFile("json", fixtureText("claude-code-normalized.json"));
  try {
    assert.deepEqual(
      scanPrivacy({ recordsRead: 2, skippedRecords: 0, shipStatus: "ready", recovered: false }),
      { safe: true, findings: [] },
    );
    assert.equal(
      scanPrivacy({ rawTranscript: "fixture text", absolutePath: "fixture path", ipAddress: "192.0.2.1" }).safe,
      false,
    );
    const options = await loadDataSourceOptions({ provider: "json", snapshotPath: file.path, env: {} });
    assert.equal(options.createCodexWorkerSource, undefined);
    const handler = createApiHandler(options);

    const health = responseCapture();
    handler(request("/api/health"), health);
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).provider, "snapshot-json");
    assert.equal(JSON.parse(health.body).ready, false, "cold health reports that the lazy source has not been read yet");

    const snapshot = responseCapture();
    handler(request("/api/snapshot"), snapshot);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(JSON.parse(snapshot.body).sourceLabel, "Claude Code normalized fixture");
    assert.equal(snapshot.body.includes("private"), false);

    const warmHealth = responseCapture();
    handler(request("/api/health"), warmHealth);
    assert.equal(warmHealth.statusCode, 200);
    assert.equal(JSON.parse(warmHealth.body).ready, true);

    const demo = responseCapture();
    handler(request("/api/snapshot?mode=demo"), demo);
    assert.equal(demo.statusCode, 200);
    assert.equal(JSON.parse(demo.body).mode, "demo");
    assert.equal(JSON.parse(demo.body).sourceLabel, "Demo world");

    const streamRequest = new EventEmitter();
    streamRequest.method = "GET";
    streamRequest.url = "/api/stream";
    streamRequest.headers = {};
    streamRequest.socket = {};
    const stream = responseCapture();
    handler(streamRequest, stream);
    assert.equal(stream.statusCode, 200);
    assert.match(stream.body, /event: snapshot/);
    assert.match(stream.body, /Claude Code normalized fixture/);
    assert.equal(stream.body.includes("private-worktree"), false);
    streamRequest.emit("close");
    handler.close();
  } finally {
    dispose(file);
  }
});
