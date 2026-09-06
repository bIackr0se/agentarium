import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_SNAPSHOT_BYTES, normalizeSnapshot } from "./snapshot-contract.mjs";

export function validateSnapshotText(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("Snapshot input must be text");
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds the size limit");
  const format = options.format === "jsonl" ? "jsonl" : "json";
  const records = format === "jsonl" ? text.split(/\r?\n/).filter((line) => line.trim()) : [text];
  if (records.length === 0) throw new Error("Snapshot input is empty");
  return records.map((record, index) => {
    let parsed;
    try {
      parsed = JSON.parse(record);
    } catch {
      throw new Error(`Record ${index + 1} is not valid JSON`);
    }
    return normalizeSnapshot(parsed);
  });
}

export function validateSnapshotFile(fileName) {
  const input = fileName === "-" ? readFileSync(0, "utf8") : (() => {
    const filePath = resolve(fileName);
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error("Snapshot path is not a file");
    if (stats.size > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds the size limit");
    return readFileSync(filePath, "utf8");
  })();
  const extension = fileName === "-" ? "" : extname(fileName).toLowerCase();
  return validateSnapshotText(input, { format: extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : "json" });
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  const fileName = process.argv[2];
  if (!fileName) {
    console.error("Usage: npm run validate:snapshot -- <snapshot.json|snapshot.jsonl|->");
    process.exitCode = 1;
  } else {
    try {
      const snapshots = validateSnapshotFile(fileName);
      const last = snapshots.at(-1);
      const events = last.agents.reduce((sum, agent) => sum + agent.events.length, 0);
      console.log(`Valid Agentarium snapshot: ${last.projects.length} projects, ${last.agents.length} agents, ${events} events${snapshots.length > 1 ? `, ${snapshots.length} records` : ""}.`);
    } catch (error) {
      console.error(`Invalid Agentarium snapshot: ${error?.message ?? "validation failed"}.`);
      process.exitCode = 1;
    }
  }
}
