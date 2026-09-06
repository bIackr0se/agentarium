import assert from "node:assert/strict";
import test from "node:test";

import { createDemoSnapshot as createBrowserDemoSnapshot } from "../src/lib/demo-fixture.mjs";
import { createDemoSnapshot as createServerDemoSnapshot, DEMO_NOW_MS, DEMO_SNAPSHOT } from "../server/fixtures.mjs";

test("browser and server demo fixtures share the complete replay snapshot", () => {
  const browserSnapshot = createBrowserDemoSnapshot(new Date(DEMO_NOW_MS));
  const serverSnapshot = createServerDemoSnapshot(DEMO_NOW_MS);

  assert.deepEqual(serverSnapshot, browserSnapshot);
  assert.deepEqual(serverSnapshot, DEMO_SNAPSHOT);
  assert.equal(serverSnapshot.agents.length, 12);
  assert.equal(serverSnapshot.projects.length, 4);
  assert.ok(serverSnapshot.agents.some((agent) => agent.events.length > 1));
  assert.deepEqual(
    serverSnapshot.agents.flatMap((agent) => agent.events),
    browserSnapshot.agents.flatMap((agent) => agent.events),
  );
});
