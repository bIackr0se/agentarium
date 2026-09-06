import { parentPort, workerData } from "node:worker_threads";

import { createObserver } from "./observer.mjs";

const MIN_REFRESH_MS = 250;
const MAX_REFRESH_MS = 30_000;

function refreshDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1_500;
  return Math.max(MIN_REFRESH_MS, Math.min(MAX_REFRESH_MS, Math.trunc(number)));
}

const options = workerData?.options && typeof workerData.options === "object" ? workerData.options : {};
const refreshMs = refreshDelay(workerData?.refreshMs);
let observer = null;
let timer = null;
let stopped = false;

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* the parent may be closing */ }
}

function schedule() {
  if (stopped) return;
  timer = setTimeout(refresh, refreshMs);
}

function refresh() {
  if (stopped) return;
  try {
    const snapshot = observer?.getSnapshot({ mode: "live", nowMs: Date.now() });
    const diagnostics = observer?.diagnostics?.() ?? {};
    post({ type: "snapshot", snapshot, diagnostics });
  } catch {
    post({ type: "error", diagnostics: observer?.diagnostics?.() ?? {} });
  }
  schedule();
}

parentPort?.on("message", (message) => {
  if (message?.type !== "close") return;
  stopped = true;
  if (timer) clearTimeout(timer);
  observer?.close?.();
  process.exit(0);
});

try {
  observer = createObserver(options);
  refresh();
} catch {
  post({ type: "error", diagnostics: { ready: false } });
  schedule();
}
