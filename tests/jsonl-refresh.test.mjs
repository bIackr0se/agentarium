import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createApiHandler, createApiServer } from "../server/api.mjs";
import { MAX_SNAPSHOT_BYTES, normalizeSnapshot } from "../server/snapshot-contract.mjs";
import { createSnapshotSource } from "../server/snapshot-source.mjs";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const record = {
  schemaVersion: 1, mode: "live", generatedAt: "", sourceFreshness: "",
  projects: [], agents: [], privacy: { rawContentExposed: false },
};
const line = `${JSON.stringify(record)}\n`;
// Distinct records, as in a real history: identical lines would let a cache
// keyed by line text validate the whole file once.
const recordAt = (index) => ({ ...record, sourceLabel: `Record ${String(index).padStart(5, "0")}` });
const recordLine = (index) => `${JSON.stringify(recordAt(index))}\n`;
const records = Math.floor(MAX_SNAPSHOT_BYTES / Buffer.byteLength(recordLine(0)));
const distinctHistory = Array.from({ length: records }, (_, index) => recordLine(index)).join("");

function history(t, text = distinctHistory) {
  const directory = mkdtempSync(join(tmpdir(), "agentarium-jsonl-refresh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "history.jsonl");
  writeFileSync(path, text);
  return path;
}

test("bounded JSONL history refresh fits the minimum API refresh interval", async (t) => {
  const source = createSnapshotSource({ snapshotPath: history(t), format: "jsonl" });
  t.after(() => source.close());
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const times = [];
  const cpuBefore = process.cpuUsage();
  loop.enable();
  try {
    // Same 15 direct reads and bounded input as the scan report. Yield between
    // reads so the event-loop monitor can observe synchronous stalls.
    for (let index = 0; index < 15; index += 1) {
      await delay(10);
      const start = performance.now();
      const actual = source.getSnapshot({ nowMs: NOW + index * 1000 });
      times.push(performance.now() - start);
      assert.deepEqual(actual, normalizeSnapshot(recordAt(records - 1), { nowMs: NOW + index * 1000 }));
    }
    await delay(10);
  } finally {
    loop.disable();
  }
  const cpu = process.cpuUsage(cpuBefore);
  const sorted = times.toSorted((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  t.diagnostic(JSON.stringify({ bytes: Buffer.byteLength(distinctHistory), records,
    reads: times.length, coldMs: times[0], medianMs, maxMs: sorted.at(-1),
    meanCpuMs: (cpu.user + cpu.system) / 1000 / times.length,
    eventLoopP95Ms: loop.percentile(95) / 1e6, eventLoopMaxMs: loop.max / 1e6 }));
  // api.mjs permits a 250 ms refresh interval. A median exceeding that
  // interval means ordinary refreshes cannot keep up with the supported rate.
  assert.ok(medianMs < 250, `median refresh ${medianMs.toFixed(3)} ms exceeds the 250 ms refresh interval`);
  assert.equal(source.diagnostics().skippedRecords, 0);
});

test("JSONL history reuse preserves normalization, warning counts, and file changes", (t) => {
  const invalid = JSON.stringify({ ...record, schemaVersion: 99 });
  const latest = { ...record, sourceLabel: "Newest fixture" };
  const path = history(t, `${invalid}\nnot-json\n${JSON.stringify(latest)}\n${invalid}\n`);
  const source = createSnapshotSource({ snapshotPath: path, format: "jsonl" });
  t.after(() => source.close());
  for (const nowMs of [NOW, NOW + 1000]) {
    const actual = source.getSnapshot({ nowMs });
    const expected = normalizeSnapshot(latest, { nowMs });
    expected.warnings.unshift("Showing the last complete snapshot; newer JSONL records were malformed or incomplete.");
    assert.deepEqual(actual, expected);
    assert.equal(source.diagnostics().skippedRecords, 3);
  }
  // Same-size replacement, append after an incomplete record, then truncate.
  const replaced = { ...latest, sourceLabel: "Edited fixture" };
  writeFileSync(path, `${invalid}\nnot-json\n${JSON.stringify(replaced)}\n${invalid}\n`);
  assert.equal(source.getSnapshot({ nowMs: NOW }).sourceLabel, replaced.sourceLabel);
  assert.equal(source.diagnostics().skippedRecords, 3);
  writeFileSync(path, `${JSON.stringify(replaced)}\n{`);
  assert.equal(source.getSnapshot({ nowMs: NOW }).sourceLabel, replaced.sourceLabel);
  assert.equal(source.diagnostics().skippedRecords, 1);
  writeFileSync(path, `${JSON.stringify(replaced)}\n${JSON.stringify(latest)}\n`);
  assert.deepEqual(source.getSnapshot({ nowMs: NOW }), normalizeSnapshot(latest, { nowMs: NOW }));
  assert.equal(source.diagnostics().skippedRecords, 0);
  writeFileSync(path, line);
  assert.deepEqual(source.getSnapshot({ nowMs: NOW }), normalizeSnapshot(record, { nowMs: NOW }));
  rmSync(path);
  assert.equal(source.getSnapshot({ nowMs: NOW }).agents.length, 0);
  assert.equal(source.diagnostics().ready, false);
  writeFileSync(path, line);
  assert.deepEqual(source.getSnapshot({ nowMs: NOW }), normalizeSnapshot(record, { nowMs: NOW }));
  source.close();
  assert.equal(source.getSnapshot({ nowMs: NOW }).agents.length, 0);
  assert.equal(source.diagnostics().ready, false);
});

test("JSONL history parses only new record text and returns independent projections", (t) => {
  const first = JSON.stringify({ ...record, sourceLabel: "First fixture" });
  const second = JSON.stringify({ ...record, sourceLabel: "Second fixture" });
  const path = history(t, `${first}\n${second}\nnot-json\n`);
  const source = createSnapshotSource({ snapshotPath: path, format: "jsonl" });
  t.after(() => source.close());
  const parse = t.mock.method(JSON, "parse");
  // Each new line is parsed once for validation, and the selected line once
  // per read for its projection.
  const initial = source.getSnapshot({ nowMs: NOW });
  assert.equal(parse.mock.callCount(), 4);
  initial.sourceLabel = "Mutated by caller";
  initial.warnings.length = 0;
  const next = source.getSnapshot({ nowMs: NOW + 1000 });
  assert.equal(parse.mock.callCount(), 5);
  assert.equal(next.sourceLabel, "Second fixture");
  assert.equal(next.generatedAt, new Date(NOW + 1000).toISOString());
  assert.equal(next.warnings.length, 2);
  const third = JSON.stringify({ ...record, sourceLabel: "Third fixture" });
  writeFileSync(path, `${first}\n${second}\nnot-json\n${third}\n`);
  assert.equal(source.getSnapshot({ nowMs: NOW }).sourceLabel, "Third fixture");
  assert.equal(parse.mock.callCount(), 7);
  writeFileSync(path, `${first}\n`);
  assert.equal(source.getSnapshot({ nowMs: NOW }).sourceLabel, "First fixture");
  assert.equal(source.recordValidity.size, 1, "removed history must leave the cache");
  assert.equal(parse.mock.callCount(), 8);
  source.close();
  assert.equal(source.recordValidity.size, 0);
});

test("JSONL validation cache recovers after an invalid refresh clock", (t) => {
  const source = createSnapshotSource({ snapshotPath: history(t, line), format: "jsonl" });
  t.after(() => source.close());
  assert.throws(() => source.getSnapshot({ nowMs: Number.MAX_VALUE }), RangeError);
  assert.equal(source.diagnostics().ready, false);
  assert.deepEqual(source.getSnapshot({ nowMs: NOW }), normalizeSnapshot(record, { nowMs: NOW }));
  assert.equal(source.diagnostics().ready, true);
});

test("JSONL API and SSE handlers serve the refreshed record", (t) => {
  const path = history(t);
  const handler = createApiHandler({ provider: "jsonl", snapshotPath: path, env: {}, snapshotRefreshMs: 250 });
  t.after(() => handler.close());
  const request = (url) => Object.assign(new EventEmitter(), { method: "GET", url, headers: {}, socket: {} });
  const response = () => Object.assign(new EventEmitter(), {
    body: "", statusCode: 0,
    writeHead(status) { this.statusCode = status; },
    write(text) { this.body += text; },
    end(text = "") { this.body += text; },
  });
  const api = response();
  handler(request("/api/snapshot"), api);
  assert.equal(api.statusCode, 200);
  assert.equal(JSON.parse(api.body).schemaVersion, 1);
  const streamRequest = request("/api/stream");
  const stream = response();
  handler(streamRequest, stream);
  assert.equal(stream.statusCode, 200);
  assert.match(stream.body, /event: snapshot/);
  const latest = { ...record, sourceLabel: "Appended fixture" };
  writeFileSync(path, line.repeat(records - 2) + `${JSON.stringify(latest)}\n`);
  handler.snapshotCache.invalidate();
  handler.sseHub.publish();
  assert.match(stream.body, /Appended fixture/);
  const updated = response();
  handler(request("/api/snapshot"), updated);
  assert.equal(JSON.parse(updated.body).sourceLabel, latest.sourceLabel);
  streamRequest.emit("close");
});

test("JSONL snapshot and SSE refresh expose the latest normalized record", { timeout: 20_000 }, async (t) => {
  const path = history(t);
  const server = createApiServer({ provider: "jsonl", snapshotPath: path, env: {}, snapshotRefreshMs: 250, intervalMs: 250 });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  {
    const snapshot = await fetch(`${base}/api/snapshot`);
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).schemaVersion, 1);
    const stream = await fetch(`${base}/api/stream`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const nextSnapshot = async () => {
      while (true) {
        const end = pending.indexOf("\n\n");
        if (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.startsWith("event: snapshot\ndata: ")) return JSON.parse(frame.slice("event: snapshot\ndata: ".length));
        } else {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "SSE must remain open until a snapshot arrives");
          pending += decoder.decode(chunk.value, { stream: true });
        }
      }
    };
    try {
      assert.equal((await nextSnapshot()).schemaVersion, 1);
      writeFileSync(path, line.repeat(records - 2) + `${JSON.stringify({ ...record, sourceLabel: "Appended fixture" })}\n`);
      assert.equal((await nextSnapshot()).sourceLabel, "Appended fixture");
      // The 250 ms refresh keeps reading the source after the SSE update.
      let health;
      for (const deadline = Date.now() + 5000; Date.now() < deadline; await delay(50)) {
        health = await fetch(`${base}/api/health`).then((response) => response.json());
        if (health.recordsRead > 2) break;
      }
      assert.equal(health.ready, true);
      assert.ok(health.recordsRead > 2);
    } finally {
      await reader.cancel();
    }
  }
});
