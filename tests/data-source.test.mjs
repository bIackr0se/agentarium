import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createApiHandler, createSseHub, createSnapshotCache } from "../server/api.mjs";
import { createDataSource, dataSourceSelection, loadDataSourceOptions } from "../server/data-source.mjs";
import { createCodexWorkerSource } from "../server/data-source-runtime.mjs";
import { createObserver } from "../server/observer.mjs";
import { scanPrivacy } from "../server/privacy.mjs";
import { emptyLiveSnapshot, MAX_SNAPSHOT_BYTES, normalizeEvent } from "../server/snapshot-contract.mjs";
import { createSnapshotSource } from "../server/snapshot-source.mjs";
import { validateSnapshotText } from "../server/validate-snapshot.mjs";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function snapshot(title = "Source-backed task", eventCount = 1) {
  return {
    schemaVersion: 1,
    mode: "live",
    generatedAt: new Date(NOW).toISOString(),
    sourceFreshness: new Date(NOW).toISOString(),
    projects: [{ id: "project-source", name: "Source Lab", color: "#7ee7d1", agentIds: ["agent-source"], activeCount: 1, attentionCount: 0 }],
    agents: [{
      id: "agent-source",
      title,
      projectId: "project-source",
      projectName: "Source Lab",
      state: "running",
      evidence: "observed",
      lastSeen: new Date(NOW).toISOString(),
      ageMs: 0,
      currentAction: "Running a bounded check",
      childCount: 0,
      events: Array.from({ length: eventCount }, (_, index) => ({
        id: `event-${index}`,
        agentId: "agent-source",
        timestamp: new Date(NOW - index * 1000).toISOString(),
        kind: "command",
        label: `Check ${index}`,
        state: "running",
        source: "app-server",
        evidence: "observed",
      })),
    }],
    attention: [],
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: ["Fixture source is read-only."],
  };
}

function tempSource(extension, content) {
  const dir = mkdtempSync(join(tmpdir(), "agentarium-source-"));
  const path = join(dir, `world.${extension}`);
  writeFileSync(path, content, "utf8");
  return { dir, path };
}

function dispose(source) {
  rmSync(source.dir, { recursive: true, force: true });
}

function createEmptyObserverDatabases(statePath, historyPath) {
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
  state.close();
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
  history.close();
}

test("startup selection gives options precedence over environment and never uses query-like values", () => {
  const json = tempSource("json", JSON.stringify(snapshot("JSON source")));
  const jsonl = tempSource("jsonl", `${JSON.stringify(snapshot("JSONL source"))}\n`);
  try {
    const selected = dataSourceSelection({
      provider: "jsonl",
      snapshotPath: jsonl.path,
      env: { AGENTARIUM_PROVIDER: "json", AGENTARIUM_SNAPSHOT_PATH: json.path },
    });
    assert.deepEqual(selected, { requested: "jsonl", source: "options", provider: "jsonl", configuredPath: true });

    const envSelected = dataSourceSelection({ env: { AGENTARIUM_PROVIDER: "json", AGENTARIUM_SNAPSHOT_PATH: json.path } });
    assert.equal(envSelected.provider, "json");
    assert.equal(envSelected.source, "environment");

    const inferred = dataSourceSelection({ env: { AGENTARIUM_SNAPSHOT_PATH: jsonl.path } });
    assert.equal(inferred.provider, "snapshot");
    assert.equal(inferred.source, "snapshot-path");
    assert.equal(dataSourceSelection({ env: {} }).provider, "snapshot");

    const injected = {
      getSnapshot: () => snapshot("Injected observer"),
      getEvents: () => [],
      diagnostics: () => ({ ready: true }),
      close: () => {},
    };
    const injectedSource = createDataSource({ observer: injected, env: { AGENTARIUM_PROVIDER: "json", AGENTARIUM_SNAPSHOT_PATH: json.path } });
    assert.equal(injectedSource.diagnostics().provider, "codex-sqlite");
    assert.equal(injectedSource.getSnapshot({ nowMs: NOW }).agents[0].title, "Injected observer");
    injectedSource.close();
  } finally {
    dispose(json);
    dispose(jsonl);
  }
});

test("bare startup stays provider-neutral and does not statically import the Codex adapter", async () => {
  const selection = dataSourceSelection({ env: {} });
  assert.deepEqual(selection, { requested: "snapshot", source: "default", provider: "snapshot", configuredPath: false });

  const options = await loadDataSourceOptions({ env: {} });
  assert.equal(options.createObserver, undefined);
  const source = createDataSource(options);
  const result = source.getSnapshot({ nowMs: NOW });
  assert.equal(result.agents.length, 0);
  assert.equal(source.diagnostics().provider, "snapshot-json");
  assert.equal(source.diagnostics().configured, false);
  assert.match(source.diagnostics().warning, /not configured/i);
  source.close();

  const moduleText = readFileSync(new URL("../server/data-source.mjs", import.meta.url), "utf8");
  assert.equal(/from\s+["']\.\/observer\.mjs["']/.test(moduleText), false);
});

test("Codex adapter loading requires an explicit provider opt-in", async () => {
  const options = await loadDataSourceOptions({ env: { AGENTARIUM_PROVIDER: "codex" } });
  assert.deepEqual(dataSourceSelection({ env: { AGENTARIUM_PROVIDER: "codex" } }), {
    requested: "codex",
    source: "environment",
    provider: "codex",
    configuredPath: false,
  });
  assert.equal(typeof options.createCodexWorkerSource, "function");

  const workers = [];
  const source = createDataSource({
    ...options,
    workerFactory: (_url, workerOptions) => {
      assert.equal(workerOptions.type, "module");
      assert.deepEqual(workerOptions.workerData.options, {});
      const worker = new EventEmitter();
      worker.terminate = () => Promise.resolve(0);
      workers.push(worker);
      return worker;
    },
  });
  assert.equal(workers.length, 1);
  assert.equal(source.diagnostics().provider, "codex-sqlite");
  assert.equal(source.diagnostics().isolated, true);
  assert.equal(source.getSnapshot({ nowMs: NOW }).agents.length, 0);
  source.close();

  // Direct factories remain available to observer-focused integrations and
  // tests, but they are only used when supplied explicitly.
  const direct = createDataSource({
    provider: "codex",
    env: {},
    createObserver: () => ({
      getSnapshot: () => snapshot("Explicit Codex source"),
      getEvents: () => [],
      diagnostics: () => ({ ready: true, provider: "codex-fixture" }),
      close: () => {},
    }),
  });
  assert.equal(direct.getSnapshot({ nowMs: NOW }).agents[0].title, "Explicit Codex source");
  direct.close();
});

test("a blocked worker refresh cannot delay the synchronous health handler", () => {
  const worker = new EventEmitter();
  worker.postMessage = () => {
    const deadline = Date.now() + 150;
    while (Date.now() < deadline) {
      // Deliberately model a worker-side stall. The main-thread source must
      // never call this during a snapshot or diagnostics read.
    }
  };
  worker.terminate = () => Promise.resolve(0);
  const source = createCodexWorkerSource({ workerFactory: () => worker });
  const handler = createApiHandler({ dataSource: source });
  const response = {
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = String(body ?? ""); },
  };
  const started = performance.now();
  handler({ method: "GET", url: "/api/health", headers: {}, socket: {} }, response);
  const elapsedMs = performance.now() - started;
  assert.equal(response.statusCode, 200);
  assert.ok(elapsedMs < 100, `health handler blocked for ${elapsedMs.toFixed(1)}ms`);
  assert.equal(JSON.parse(response.body).isolated, true);
  handler.close();
  source.close();
});

test("worker snapshots are normalized into the main-thread cache", () => {
  const worker = new EventEmitter();
  worker.terminate = () => Promise.resolve(0);
  const source = createCodexWorkerSource({ workerFactory: () => worker });
  worker.emit("message", {
    type: "snapshot",
    snapshot: snapshot("Cached Codex task"),
    diagnostics: { ready: true, schema: { valid: true, missingCount: 0 } },
  });
  assert.equal(source.getSnapshot({ nowMs: NOW }).agents[0].title, "Cached Codex task");
  assert.equal(source.diagnostics().ready, true);
  assert.equal(source.diagnostics().worker, "ready");
  assert.equal(source.getEvents("agent-source", { limit: 1 }).length, 1);
  source.close();
});

test("worker failure becomes a terminal browser-visible stopped state", () => {
  const worker = new EventEmitter();
  let terminations = 0;
  worker.terminate = () => {
    terminations += 1;
    return Promise.resolve(0);
  };
  const source = createCodexWorkerSource({ workerFactory: () => worker });

  const starting = source.getSnapshot({ nowMs: NOW });
  assert.match(starting.warnings.join(" "), /starting/i);
  worker.emit("error", new Error("planted startup failure"));

  const failed = source.getSnapshot({ nowMs: NOW });
  const diagnostics = source.diagnostics();
  assert.equal(diagnostics.ready, false);
  assert.equal(diagnostics.worker, "failed");
  assert.match(diagnostics.warning, /stopped/i);
  assert.match(diagnostics.warning, /restart Agentarium/i);
  assert.match(failed.warnings.join(" "), /stopped/i);
  assert.match(failed.warnings.join(" "), /restart Agentarium/i);
  assert.doesNotMatch(failed.warnings.join(" "), /starting/i);
  assert.equal(failed.sourceFreshness, "unknown");
  assert.deepEqual(scanPrivacy(failed), { safe: true, findings: [] });
  assert.equal(terminations, 1);

  worker.emit("message", {
    type: "snapshot",
    snapshot: snapshot("Late recovery must be ignored"),
    diagnostics: { ready: true },
  });
  assert.equal(source.getSnapshot({ nowMs: NOW }).agents.length, 0);
  assert.equal(source.diagnostics().ready, false);
  source.close();
});

test("worker failure retains last-good records only with a stopped warning in snapshot and SSE", () => {
  const worker = new EventEmitter();
  worker.terminate = () => Promise.resolve(0);
  const source = createCodexWorkerSource({ workerFactory: () => worker });
  worker.emit("message", {
    type: "snapshot",
    snapshot: snapshot("Last safe Codex task"),
    diagnostics: {
      ready: true,
      schema: { valid: true, missingCount: 0 },
      retry: { attempts: 1, maxAttempts: 3, retrying: true, nextAttemptAt: new Date(NOW + 1_000).toISOString() },
    },
  });
  const lastGood = source.getSnapshot({ nowMs: NOW });
  worker.emit("error", new Error("planted post-ready failure"));

  const failed = source.getSnapshot({ nowMs: NOW });
  const diagnostics = source.diagnostics();
  assert.equal(diagnostics.ready, false);
  assert.equal(diagnostics.worker, "failed");
  assert.equal(diagnostics.retry.retrying, false);
  assert.equal(diagnostics.retry.nextAttemptAt, null);
  assert.match(diagnostics.warning, /restart Agentarium/i);
  assert.notEqual(failed, lastGood);
  assert.equal(failed.generatedAt, lastGood.generatedAt);
  assert.equal(failed.sourceFreshness, lastGood.sourceFreshness);
  assert.deepEqual(failed.projects, lastGood.projects);
  assert.deepEqual(failed.agents, lastGood.agents);
  assert.match(failed.warnings[0], /stopped/i);
  assert.match(failed.warnings[0], /last safe snapshot/i);
  assert.deepEqual(scanPrivacy(failed), { safe: true, findings: [] });

  const handler = createApiHandler({ dataSource: source });
  const response = new EventEmitter();
  response.statusCode = 0;
  response.body = "";
  response.setHeader = () => {};
  response.writeHead = (status) => { response.statusCode = status; };
  response.write = (chunk) => { response.body += String(chunk); return true; };
  response.end = (chunk = "") => { response.body += String(chunk); };
  const request = new EventEmitter();
  request.method = "GET";
  request.url = "/api/events?mode=live";
  request.headers = {};
  request.socket = {};
  handler(request, response);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /event: snapshot/);
  assert.match(response.body, /Codex observer stopped/);
  assert.equal(response.body.includes("Last safe Codex task"), true);
  assert.deepEqual(scanPrivacy(JSON.parse(response.body.match(/data: (\{.*\})/)[1])), { safe: true, findings: [] });
  request.emit("close");
  handler.close();
  source.close();
});

test("non-Codex startup skips the optional SQLite adapter", async () => {
  const file = tempSource("json", JSON.stringify(snapshot()));
  try {
    const options = await loadDataSourceOptions({ provider: "json", snapshotPath: file.path, env: {} });
    assert.equal(options.createObserver, undefined);
    const source = createDataSource(options);
    assert.equal(source.getSnapshot({ nowMs: NOW }).agents.length, 1);
    source.close();
  } finally {
    dispose(file);
  }
});

test("published harness example validates and preserves neutral provenance", () => {
  const example = readFileSync(new URL("../docs/world-snapshot.example.json", import.meta.url), "utf8");
  const [snapshotResult] = validateSnapshotText(example);
  assert.equal(snapshotResult.sourceLabel, "Example harness");
  assert.equal(snapshotResult.agents[0].events[0].agentId, "agent-lead");
  assert.equal(snapshotResult.agents[0].events[0].source, "example-harness");
  assert.equal(snapshotResult.agents[1].parentAgentId, "agent-lead");
});

test("JSON provider projects an allowlist, removes unknown fields, and redacts unsafe labels", () => {
  const sourceFile = snapshot("api_key=example-secret-token-12345678901234567890 /Users/example/private");
  sourceFile.secret = "api_key=example-secret-token-12345678901234567890";
  sourceFile.rawTranscript = "private transcript /Users/example/private";
  sourceFile.agents[0].unknownField = { cwd: "/Users/example/private", payload: "secret" };
  sourceFile.agents[0].branch = "/Users/example/private-branch";
  const file = tempSource("json", JSON.stringify(sourceFile));
  try {
    const source = createDataSource({ provider: "json", snapshotPath: file.path, env: {} });
    const result = source.getSnapshot({ nowMs: NOW });
    const wire = JSON.stringify(result);
    assert.equal(result.mode, "live");
    assert.equal(result.agents[0].title.includes("example-secret-token"), false);
    assert.equal(wire.includes("rawTranscript"), false);
    assert.equal(wire.includes("unknownField"), false);
    assert.equal(wire.includes("/Users/example/private"), false);
    assert.deepEqual(scanPrivacy(result), { safe: true, findings: [] });
    source.close();
  } finally {
    dispose(file);
  }
});

test("contract preserves an explicit mode while live API calls can override it", () => {
  const sourceFile = snapshot("Demo-labelled source");
  sourceFile.mode = "demo";
  const file = tempSource("json", JSON.stringify(sourceFile));
  try {
    const rawSource = createSnapshotSource({ snapshotPath: file.path, format: "json" });
    assert.equal(rawSource.getSnapshot({ nowMs: NOW }).mode, "demo");
    const source = createDataSource({ provider: "json", snapshotPath: file.path, env: {} });
    assert.equal(source.getSnapshot({ nowMs: NOW }).mode, "live");
    assert.equal(source.getSnapshot({ mode: "demo", nowMs: NOW }).mode, "demo");
    source.close();
    rawSource.close();
  } finally {
    dispose(file);
  }
});

test("punctuation-only project, action, event, and task labels fail closed to readable fallbacks", () => {
  const sourceFile = snapshot("???");
  sourceFile.projects[0].name = "!!!";
  sourceFile.agents[0].currentAction = "...";
  sourceFile.agents[0].events[0].label = "???";
  const file = tempSource("json", JSON.stringify(sourceFile));
  try {
    const source = createDataSource({ provider: "json", snapshotPath: file.path, env: {} });
    const result = source.getSnapshot({ nowMs: NOW });
    assert.equal(result.projects[0].name, "Unnamed project");
    assert.equal(result.agents[0].title, "Untitled task · t-source");
    assert.equal(result.agents[0].currentAction, "State unavailable");
    assert.equal(result.agents[0].events[0].label, "Activity observed");
    assert.equal(JSON.stringify(result).includes("?"), false);
    assert.deepEqual(scanPrivacy(result), { safe: true, findings: [] });
    source.close();
  } finally {
    dispose(file);
  }
});

test("JSONL provider returns the last valid snapshot and skips malformed trailing records", () => {
  const first = snapshot("First valid snapshot");
  const last = snapshot("Last valid snapshot");
  const file = tempSource("jsonl", `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(last)}\n{\"schemaVersion\":\"bad\"}\n`);
  try {
    const source = createDataSource({ provider: "jsonl", snapshotPath: file.path, env: {} });
    const result = source.getSnapshot({ nowMs: NOW });
    assert.equal(result.agents[0].title, "Last valid snapshot");
    assert.equal(source.diagnostics().ready, true);
    assert.equal(source.diagnostics().recovered, true);
    assert.equal(source.diagnostics().degraded, true);
    assert.equal(source.diagnostics().skippedRecords, 2);
    assert.match(source.diagnostics().warning, /last complete snapshot/i);
    assert.ok(result.warnings.some((warning) => /last complete snapshot/i.test(warning)));
    source.close();
  } finally {
    dispose(file);
  }
});

test("malformed, schema-mismatched, and oversized files fail closed", () => {
  const malformed = tempSource("json", "{not json");
  const schema = tempSource("json", JSON.stringify({ schemaVersion: 99 }));
  const oversized = tempSource("json", "x".repeat(MAX_SNAPSHOT_BYTES + 1));
  try {
    for (const file of [malformed, schema, oversized]) {
      const source = createSnapshotSource({ snapshotPath: file.path, format: "json" });
      const result = source.getSnapshot({ nowMs: NOW });
      assert.equal(result.agents.length, 0);
      assert.equal(result.projects.length, 0);
      assert.equal(result.privacy.rawContentExposed, false);
      assert.deepEqual(scanPrivacy(result), { safe: true, findings: [] });
      assert.equal(source.diagnostics().ready, false);
      source.close();
    }
  } finally {
    dispose(malformed);
    dispose(schema);
    dispose(oversized);
  }
});

test("snapshot reads are read-only and events stay bounded", () => {
  const file = tempSource("json", JSON.stringify(snapshot("Read-only source", 40)));
  const before = readFileSync(file.path);
  const beforeStat = statSync(file.path);
  try {
    chmodSync(file.path, 0o444);
    const source = createSnapshotSource({ snapshotPath: file.path, format: "json" });
    const result = source.getSnapshot({ nowMs: NOW });
    assert.equal(result.agents[0].events.length, 24);
    assert.equal(source.getEvents("agent-source", { limit: 500 }).length, 24);
    assert.deepEqual(readFileSync(file.path), before);
    const afterStat = statSync(file.path);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(source.diagnostics().readOnly, true);
    source.close();
  } finally {
    dispose(file);
  }
});

test("provider diagnostics are bounded and do not expose configured paths", () => {
  const file = tempSource("json", JSON.stringify(snapshot()));
  try {
    const source = createDataSource({ provider: "json", snapshotPath: file.path, env: {} });
    const diagnostics = source.diagnostics();
    assert.equal(diagnostics.provider, "snapshot-json");
    assert.equal(diagnostics.readOnly, true);
    assert.equal(diagnostics.configured, true);
    assert.equal(JSON.stringify(diagnostics).includes(file.path), false);
    source.getSnapshot({ nowMs: NOW });
    assert.equal(source.diagnostics().ready, true);
    source.close();
  } finally {
    dispose(file);
  }
});

test("injected diagnostics use a strict health allowlist", () => {
  const injected = {
    getSnapshot: () => snapshot(),
    getEvents: () => [],
    diagnostics: () => ({
      ready: true,
      warning: "safe warning",
      workspaceRoot: "/repo/worktree",
      accountLabel: "private-account",
      dbName: "user-secrets.sqlite",
      nested: { payload: "secret" },
    }),
    close: () => {},
  };
  const source = createDataSource({ dataSource: injected });
  const diagnostics = source.diagnostics();
  assert.equal(diagnostics.ready, true);
  assert.equal(diagnostics.warning, "safe warning");
  assert.equal(diagnostics.provider, "injected");
  assert.equal(diagnostics.readOnly, true);
  assert.equal("workspaceRoot" in diagnostics, false);
  assert.equal("accountLabel" in diagnostics, false);
  assert.equal("dbName" in diagnostics, false);
  assert.equal("nested" in diagnostics, false);
  assert.deepEqual(scanPrivacy(diagnostics), { safe: true, findings: [] });
  source.close();

  const handler = createApiHandler({ dataSource: injected });
  const response = {
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = String(body ?? ""); },
  };
  handler({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:4173" }, socket: { remoteAddress: "127.0.0.1" } }, response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal("workspaceRoot" in body, false);
  assert.equal("dbName" in body, false);
  assert.deepEqual(scanPrivacy(body), { safe: true, findings: [] });
  handler.close();
});

test("API shares one live snapshot across requests until the refresh interval", () => {
  let reads = 0;
  const source = {
    getSnapshot() {
      reads += 1;
      return snapshot(`Read ${reads}`);
    },
    getEvents() { return []; },
    diagnostics() { return { ready: true, provider: "fixture", readOnly: true }; },
    close() {},
  };
  const handler = createApiHandler({ dataSource: source, snapshotRefreshMs: 30_000 });
  // The cache is directly observable here, which avoids opening a network
  // socket solely to prove a request-level implementation detail.
  assert.equal(handler.snapshotCache.getSnapshot().agents[0].title, "Read 1");
  assert.equal(handler.snapshotCache.getSnapshot().agents[0].title, "Read 1");
  assert.equal(reads, 1);
  handler.snapshotCache.invalidate();
  assert.equal(handler.snapshotCache.getSnapshot().agents[0].title, "Read 2");
  assert.equal(reads, 2);
  handler.close();
});

test("injected sources are validated, snapshots are normalized, and health fails closed", () => {
  const invalid = { getSnapshot: () => snapshot("invalid") };
  const rejected = createDataSource({ dataSource: invalid });
  assert.equal(rejected.getSnapshot({ nowMs: NOW }).agents.length, 0);
  assert.equal(rejected.diagnostics().ready, false);

  const unsafeEvent = {
    ...snapshot().agents[0].events[0],
    freeText: "private transcript",
    command: "cat /Users/example/private/.env",
  };
  const injected = {
    getSnapshot: () => snapshot("Injected normalized source"),
    getEvents: () => [unsafeEvent],
    diagnostics: () => ({ ready: true, provider: "fixture" }),
    close: () => {},
  };
  const source = createDataSource({ dataSource: injected });
  const events = source.getEvents("agent-source", { limit: 99 });
  assert.equal(events.length, 1);
  assert.equal("freeText" in events[0], false);
  assert.equal("command" in events[0], false);
  assert.deepEqual(scanPrivacy(events), { safe: true, findings: [] });

  let valid = false;
  const unstable = createDataSource({ dataSource: {
    getSnapshot: () => valid ? snapshot("Recovered source") : { schemaVersion: 99 },
    getEvents: () => [],
    diagnostics: () => ({ ready: true, healthy: true }),
    close: () => {},
  } });
  unstable.getSnapshot({ nowMs: NOW });
  assert.equal(unstable.diagnostics().ready, false);
  assert.equal(unstable.diagnostics().healthy, false);
  assert.equal(unstable.diagnostics().normalizationError, true);
  valid = true;
  unstable.getSnapshot({ nowMs: NOW + 1 });
  assert.equal(unstable.diagnostics().ready, true);
  assert.equal(unstable.diagnostics().normalizationError, undefined);

  const response = { statusCode: 0, body: "", setHeader() {}, writeHead(status) { this.statusCode = status; }, end(body) { this.body = String(body ?? ""); } };
  const handler = createApiHandler({ dataSource: invalid });
  handler({ method: "GET", url: "/api/health", headers: {}, socket: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ready, false);
  handler.close();
  source.close();
  unstable.close();
});

test("closed caches and providers never call or reopen their source", () => {
  let reads = 0;
  const underlying = {
    getSnapshot: () => { reads += 1; return snapshot("Should not be read"); },
    getEvents: () => { reads += 1; return []; },
    diagnostics: () => ({ ready: true }),
    close: () => { reads += 1; },
  };
  const source = createDataSource({ dataSource: underlying });
  source.close();
  assert.equal(source.getSnapshot({ nowMs: NOW }).agents.length, 0);
  assert.deepEqual(source.getEvents("agent-source"), []);
  assert.equal(source.diagnostics().closed, true);
  assert.equal(reads, 0, "closing an injected provider must not touch its source");

  const cache = createSnapshotCache(underlying, { snapshotRefreshMs: 30_000 });
  cache.close();
  assert.equal(cache.getSnapshot({ nowMs: NOW }).agents.length, 0);
  assert.equal(cache.getSnapshot({ mode: "demo", nowMs: NOW }).agents.length, 0);
  assert.equal(reads, 0, "a closed cache must not call its source");

  const observer = createObserver({
    stateDbPath: join(tmpdir(), "agentarium-closed-state.sqlite"),
    historyDbPath: join(tmpdir(), "agentarium-closed-history.sqlite"),
  });
  observer.close();
  assert.deepEqual(observer.getEvents("release-verifier", { mode: "demo" }), []);
});

test("observer retries a transient startup open failure within bounded attempts", () => {
  const file = tempSource("marker", "retry");
  const statePath = join(file.dir, "state.sqlite");
  const historyPath = join(file.dir, "history.sqlite");
  const observer = createObserver({
    stateDbPath: statePath,
    historyDbPath: historyPath,
    catalogDbPath: join(file.dir, "catalog.sqlite"),
    openRetryAfterMs: 1_000,
    maxOpenAttempts: 3,
  });
  try {
    assert.equal(observer.getSnapshot({ nowMs: NOW }).agents.length, 0);
    assert.equal(observer.getSnapshot({ nowMs: NOW + 500 }).agents.length, 0);
    createEmptyObserverDatabases(statePath, historyPath);
    assert.equal(observer.getSnapshot({ nowMs: NOW + 1_001 }).agents.length, 0);
    const diagnostics = observer.diagnostics();
    assert.equal(diagnostics.ready, true);
    assert.equal(diagnostics.retry.attempts, 2);
    assert.equal(diagnostics.retry.retrying, false);
  } finally {
    observer.close();
    dispose(file);
  }
});

test("observer startup retries stop at the configured cap", () => {
  const file = tempSource("marker", "retry-cap");
  const observer = createObserver({
    stateDbPath: join(file.dir, "state.sqlite"),
    historyDbPath: join(file.dir, "history.sqlite"),
    catalogDbPath: join(file.dir, "catalog.sqlite"),
    openRetryAfterMs: 0,
    maxOpenAttempts: 2,
  });
  try {
    observer.getSnapshot({ nowMs: NOW });
    observer.getSnapshot({ nowMs: NOW + 1 });
    observer.getSnapshot({ nowMs: NOW + 2 });
    const diagnostics = observer.diagnostics();
    assert.equal(diagnostics.ready, false);
    assert.equal(diagnostics.retry.attempts, 2);
    assert.equal(diagnostics.retry.retrying, false);
  } finally {
    observer.close();
    dispose(file);
  }
});

test("multiple SSE clients share one provider read per refresh window", () => {
  let reads = 0;
  const source = {
    getSnapshot() {
      reads += 1;
      return snapshot(`SSE read ${reads}`);
    },
    getEvents() { return []; },
    diagnostics() { return { ready: true, provider: "fixture", readOnly: true }; },
    close() {},
  };
  const hub = createSseHub(source, { intervalMs: 30_000 });
  try {
    for (let index = 0; index < 3; index += 1) {
      const request = new EventEmitter();
      const response = new EventEmitter();
      response.writeHead = () => {};
      response.write = () => true;
      response.end = () => {};
      hub.connect(request, response, "live");
    }
    hub.publish();
    assert.equal(hub.clientCount, 3);
    assert.equal(reads, 1);
  } finally {
    hub.close();
  }
});

test("live API continuity preserves the last safe snapshot after an explicit degraded empty result", () => {
  let current = snapshot("Last safe provider snapshot");
  let healthy = true;
  const source = {
    getSnapshot() { return current; },
    getEvents() { return []; },
    diagnostics() { return { ready: healthy, healthy, degraded: !healthy, provider: "fixture", readOnly: true }; },
    close() {},
  };
  const handler = createApiHandler({ dataSource: source, snapshotRefreshMs: 250 });
  const response = () => ({
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = String(body ?? ""); },
  });

  const first = response();
  handler({ method: "GET", url: "/api/world", headers: {}, socket: {} }, first);
  assert.equal(JSON.parse(first.body).agents[0].title, "Last safe provider snapshot");

  healthy = false;
  current = emptyLiveSnapshot(NOW + 1_000, ["Provider became unavailable."]);
  handler.snapshotCache.invalidate();
  const degraded = response();
  handler({ method: "GET", url: "/api/world", headers: {}, socket: {} }, degraded);
  const degradedBody = JSON.parse(degraded.body);
  assert.equal(degradedBody.agents[0].title, "Last safe provider snapshot");
  assert.match(degradedBody.warnings.join(" "), /last safe snapshot/i);
  assert.equal(degradedBody.sourceFreshness, new Date(NOW).toISOString());
  handler.close();
});

test("live SSE continuity does not replace a safe snapshot with an explicit degraded empty result", () => {
  let healthy = true;
  let current = snapshot("SSE safe provider snapshot");
  const source = {
    getSnapshot() { return current; },
    getEvents() { return []; },
    diagnostics() { return { ready: healthy, healthy, degraded: !healthy, provider: "fixture", readOnly: true }; },
    close() {},
  };
  const cache = createSnapshotCache(source, { intervalMs: 250 });
  const hub = createSseHub(source, { intervalMs: 250, snapshotCache: cache });
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.body = "";
  response.writeHead = () => {};
  response.write = (chunk) => { response.body += String(chunk); return true; };
  response.end = () => {};
  hub.connect(request, response, "live");
  assert.equal(response.body.includes("SSE safe provider snapshot"), true);

  healthy = false;
  current = emptyLiveSnapshot(NOW + 1_000, ["Provider became unavailable."]);
  cache.invalidate();
  hub.publish();
  const payloads = [...response.body.matchAll(/data: (\{.*\})/g)].map((match) => JSON.parse(match[1]));
  assert.equal(payloads.at(-1).agents[0].title, "SSE safe provider snapshot");
  assert.match(payloads.at(-1).warnings.join(" "), /last safe snapshot/i);
  request.emit("close");
  hub.close();
  cache.close();
});

test("healthy live zero-agent snapshots remain empty instead of inheriting older records", () => {
  let current = snapshot("Prior provider snapshot");
  let healthy = true;
  const source = {
    getSnapshot() { return current; },
    getEvents() { return []; },
    diagnostics() { return { ready: healthy, healthy, degraded: false, provider: "fixture", readOnly: true }; },
    close() {},
  };
  const cache = createSnapshotCache(source, { snapshotRefreshMs: 250 });
  assert.equal(cache.getSnapshot({ nowMs: NOW }).agents[0].title, "Prior provider snapshot");
  current = {
    ...emptyLiveSnapshot(NOW + 1_000, ["Provider is healthy with no active agents."]),
    sourceFreshness: new Date(NOW + 1_000).toISOString(),
  };
  cache.invalidate();
  const empty = cache.getSnapshot({ nowMs: NOW + 1_000 });
  assert.equal(empty.agents.length, 0);
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.sourceFreshness, new Date(NOW + 1_000).toISOString());
  assert.equal(empty.warnings.some((warning) => /last safe snapshot/i.test(warning)), false);
  cache.close();
});

test("JSON and JSONL sources retain the last safe snapshot across a malformed refresh", () => {
  for (const [extension, provider, malformed] of [
    ["json", "json", "{malformed"],
    ["jsonl", "jsonl", "not-json\n"],
  ]) {
    const file = tempSource(extension, JSON.stringify(snapshot(`${provider} safe snapshot`)));
    try {
      const source = createDataSource({ provider, snapshotPath: file.path, env: {} });
      const cache = createSnapshotCache(source, { snapshotRefreshMs: 250 });
      assert.equal(cache.getSnapshot({ nowMs: NOW }).agents[0].title, `${provider} safe snapshot`);
      writeFileSync(file.path, malformed, "utf8");
      cache.invalidate();
      const degraded = cache.getSnapshot({ nowMs: NOW + 1_000 });
      assert.equal(degraded.agents[0].title, `${provider} safe snapshot`);
      assert.match(degraded.warnings.join(" "), /last safe snapshot/i);
      cache.close();
      source.close();
    } finally {
      dispose(file);
    }
  }
});
