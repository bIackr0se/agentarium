import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoSnapshot } from "../../src/lib/demo-fixture.mjs";

export const sourcePath = fileURLToPath(new URL("../../output/playwright/runtime/snapshot.json", import.meta.url));

export function writeFixture(action = "Browser fixture ready") {
  const snapshot = { ...createDemoSnapshot(Date.now()), mode: "live" as const, sourceLabel: "Browser fixture" };
  const root = snapshot.agents.find(agent => agent.id === "release-verifier")!;
  root.currentAction = action;
  root.events.push({
    id: `browser-${action}`,
    agentId: root.id,
    timestamp: snapshot.generatedAt,
    kind: "verification",
    label: action,
    state: "verifying",
    source: "browser-fixture",
    evidence: "observed",
  });
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, JSON.stringify(snapshot));
}
