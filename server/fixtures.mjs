import { createDemoSnapshot as createSharedDemoSnapshot } from "../src/lib/demo-fixture.mjs";
import { assertPrivacySafe } from "./privacy.mjs";

export const DEMO_NOW_MS = Date.parse("2026-08-29T12:00:00.000Z");

export function createDemoSnapshot(nowMs = DEMO_NOW_MS) {
  const normalizedNow = Number.isFinite(nowMs) ? nowMs : DEMO_NOW_MS;
  const snapshot = createSharedDemoSnapshot(normalizedNow);
  assertPrivacySafe(snapshot);
  return snapshot;
}

export const DEMO_SNAPSHOT = Object.freeze(createDemoSnapshot());
