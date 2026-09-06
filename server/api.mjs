import { createServer as createHttpServer } from "node:http";
import { URL } from "node:url";

import { createDataSource, loadDataSourceOptions } from "./data-source.mjs";
import { createDemoSnapshot } from "./fixtures.mjs";
import { assertPrivacySafe } from "./privacy.mjs";
import { emptyLiveSnapshot } from "./snapshot-contract.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_BODYLESS_PATH = 512;
const LIVE_CONTINUITY_WARNING = "Live source is unavailable or degraded. Showing the last safe snapshot until it recovers.";

function requestIsLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (address && !LOOPBACK_ADDRESSES.has(address)) return false;
  const rawHost = typeof req?.headers?.host === "string" ? req.headers.host : "";
  if (!rawHost) return true;
  const host = rawHost.replace(/^\[/, "").replace(/\](:\d+)?$/, "").replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}

function commonHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
  };
}

function sendJson(res, statusCode, body) {
  let payload;
  try {
    assertPrivacySafe(body);
    payload = JSON.stringify(body);
  } catch {
    statusCode = 500;
    payload = JSON.stringify({ error: "The response was rejected by the privacy boundary" });
  }
  res.writeHead(statusCode, commonHeaders());
  res.end(payload);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, commonHeaders("text/plain; charset=utf-8"));
  res.end(text);
}

function parseLimit(value, fallback = 12) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(24, n));
}

function digestSnapshot(snapshot) {
  // generatedAt is intentionally volatile.  Do not wake every SSE client if
  // no observable state changed.
  return JSON.stringify({ ...snapshot, generatedAt: "" });
}

function isEmptyLiveSnapshot(snapshot) {
  return snapshot?.mode === "live"
    && Array.isArray(snapshot.projects)
    && Array.isArray(snapshot.agents)
    && snapshot.projects.length === 0
    && snapshot.agents.length === 0;
}

function sourceIsDegraded(source) {
  let diagnostics;
  try {
    diagnostics = source?.diagnostics?.();
  } catch {
    // A provider that cannot report its health cannot safely replace a known
    // live snapshot with an empty one. The static warning below makes this
    // degradation visible without forwarding provider diagnostics.
    return true;
  }
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return false;
  return diagnostics.ready === false
    || diagnostics.healthy === false
    || diagnostics.degraded === true
    || diagnostics.normalizationError === true;
}

function staleLiveSnapshot(lastGood) {
  return {
    ...lastGood,
    warnings: [...new Set([LIVE_CONTINUITY_WARNING, ...(lastGood.warnings ?? [])])].slice(0, 8),
  };
}

/**
 * Keep one bounded live snapshot in memory for the API and every SSE client.
 * SQLite and file providers are synchronous by design, so this cache is the
 * boundary that prevents a connection fan-out from re-reading source state.
 */
export function createSnapshotCache(source, options = {}) {
  const intervalMs = Math.max(250, Math.min(30_000, Number(options.snapshotRefreshMs ?? options.intervalMs) || 1_500));
  let snapshot = null;
  let lastGoodLiveSnapshot = null;
  let fetchedAt = 0;
  let closed = false;
  const getSnapshot = (request = {}) => {
    if (closed) return emptyLiveSnapshot(request.nowMs, ["Snapshot cache is closed."]);
    const mode = request.mode === "demo" ? "demo" : "live";
    if (mode === "demo") return source.getSnapshot({ mode, nowMs: request.nowMs });
    const nowMs = Number.isFinite(request.nowMs) ? request.nowMs : Date.now();
    if (snapshot && nowMs - fetchedAt < intervalMs) return snapshot;
    const next = source.getSnapshot({ mode, nowMs });
    const empty = isEmptyLiveSnapshot(next);
    const degraded = empty && sourceIsDegraded(source);
    if (empty && lastGoodLiveSnapshot && degraded) {
      snapshot = staleLiveSnapshot(lastGoodLiveSnapshot);
    } else {
      snapshot = next;
      // An empty snapshot is valid when the provider explicitly reports a
      // healthy live source. Do not infer failure from the absence of agents.
      if (mode === "live" && (!empty || !degraded)) lastGoodLiveSnapshot = next;
    }
    fetchedAt = nowMs;
    return snapshot;
  };
  return {
    getSnapshot,
    invalidate() { snapshot = null; fetchedAt = 0; },
    close() { closed = true; snapshot = null; lastGoodLiveSnapshot = null; },
    get lastFetchedAt() { return fetchedAt || null; },
    get intervalMs() { return intervalMs; },
  };
}

/**
 * Small in-process SSE hub.  Polling is bounded and read-only; subscribers
 * only receive snapshots after the observer's observable digest changes.
 */
export function createSseHub(observer, options = {}) {
  const intervalMs = Math.max(250, Math.min(30_000, Number(options.intervalMs) || 1_500));
  const clients = new Set();
  let timer = null;
  const cache = options.snapshotCache ?? createSnapshotCache(observer, { intervalMs });
  const snapshot = (mode) => {
    if (typeof options.snapshotReader === "function") return options.snapshotReader(mode);
    return cache.getSnapshot({ mode });
  };
  const publish = () => {
    for (const client of [...clients]) {
      try {
        const current = snapshot(client.mode);
        assertPrivacySafe(current);
        const digest = digestSnapshot(current);
        if (digest === client.digest && client.sent) continue;
        client.digest = digest;
        client.sent = true;
        client.res.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`);
      } catch {
        client.res.write("event: error\ndata: {\"error\":\"Snapshot unavailable\"}\n\n");
      }
    }
    if (!clients.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const ensureTimer = () => {
    if (!timer) timer = setInterval(publish, intervalMs);
  };
  const connect = (req, res, mode = "live") => {
    res.writeHead(200, {
      ...commonHeaders("text/event-stream; charset=utf-8"),
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const client = { req, res, mode: mode === "demo" ? "demo" : "live", digest: "", sent: false };
    clients.add(client);
    const cleanup = () => clients.delete(client);
    req?.on?.("close", cleanup);
    res.on?.("close", cleanup);
    res.write(": agentarium observer stream\n\n");
    publish();
    ensureTimer();
  };
  const close = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const client of clients) {
      try { client.res.end(); } catch { /* best effort */ }
    }
    clients.clear();
    if (!options.snapshotCache) cache.close();
  };
  return { connect, publish, close, get clientCount() { return clients.size; } };
}

/**
 * Return an HTTP handler suitable for Node, Vite's connect middleware, or a
 * test server.  It intentionally exposes only GET endpoints.  Controls for
 * managed App Server tasks belong in a separately authenticated integration.
 */
export function createApiHandler(options = {}) {
  const dataSource = createDataSource(options);
  const ownDataSource = !options.dataSource;
  const snapshotCache = options.snapshotCache ?? createSnapshotCache(dataSource, options);
  const readSnapshot = (mode) => mode === "demo"
    ? createDemoSnapshot()
    : snapshotCache.getSnapshot({ mode: "live" });
  const readEvents = (agentId, mode, limit) => {
    if (mode === "demo") {
      const snapshot = createDemoSnapshot();
      return snapshot.agents.find((agent) => agent.id === agentId)?.events.slice(0, limit) ?? [];
    }
    return dataSource.getEvents(agentId, { mode: "live", limit });
  };
  const sse = options.sseHub ?? createSseHub(dataSource, { ...options, snapshotCache, snapshotReader: readSnapshot });
  const allowOrigin = new Set(["http://127.0.0.1:4173", "http://localhost:4173", "http://[::1]:4173"]);

  const handler = (req, res, next) => {
    if (!requestIsLoopback(req)) {
      sendJson(res, 403, { error: "Agentarium is localhost-only" });
      return;
    }
    const origin = typeof req.headers?.origin === "string" ? req.headers.origin : "";
    if (origin && allowOrigin.has(origin)) res.setHeader?.("Access-Control-Allow-Origin", origin);
    if (origin) res.setHeader?.("Vary", "Origin");
    if (req.method === "OPTIONS") {
      if (origin && !allowOrigin.has(origin)) {
        sendJson(res, 403, { error: "Origin is not allowed" });
        return;
      }
      res.writeHead(204, {
        ...commonHeaders(),
        "Access-Control-Allow-Origin": origin || "http://127.0.0.1:4173",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.setHeader?.("Allow", "GET, OPTIONS");
      sendJson(res, 405, { error: "Only read-only GET endpoints are available" });
      return;
    }
    const rawUrl = typeof req.url === "string" && req.url.length <= MAX_BODYLESS_PATH ? req.url : "/";
    let url;
    try { url = new URL(rawUrl, "http://127.0.0.1"); } catch {
      sendJson(res, 400, { error: "Malformed request URL" });
      return;
    }
    const pathname = url.pathname;
    const mode = url.searchParams.get("mode") === "demo" ? "demo" : "live";
    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, mode, ...dataSource.diagnostics() });
      return;
    }
    if (pathname === "/api/world" || pathname === "/api/snapshot") {
      sendJson(res, 200, readSnapshot(mode));
      return;
    }
    if (pathname === "/api/demo") {
      sendJson(res, 200, createDemoSnapshot());
      return;
    }
    if (pathname === "/api/stream" || pathname === "/api/events") {
      sse.connect(req, res, mode);
      return;
    }
    const agentMatch = pathname.match(/^\/api\/(?:agents|threads)\/([^/]+)\/events$/);
    if (agentMatch) {
      let agentId;
      try {
        agentId = decodeURIComponent(agentMatch[1]);
      } catch {
        // A malformed percent escape is a client input error, not a reason to
        // tear down the localhost server or leak the URI parser exception.
        sendJson(res, 400, { error: "Malformed agent identifier" });
        return;
      }
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(agentId)) {
        sendJson(res, 400, { error: "Invalid agent identifier" });
        return;
      }
      sendJson(res, 200, { agentId, events: readEvents(agentId, mode, parseLimit(url.searchParams.get("limit"))) });
      return;
    }
    if (typeof next === "function") {
      next();
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  };
  handler.close = () => {
    sse.close();
    if (!options.snapshotCache) snapshotCache.close();
    if (ownDataSource) dataSource.close();
  };
  // Keep the old property for integrations that inspect the injected
  // observer, while exposing the provider-neutral handle for new callers.
  handler.observer = options.observer ?? dataSource;
  handler.dataSource = dataSource;
  handler.snapshotCache = snapshotCache;
  handler.sseHub = sse;
  return handler;
}

export function createApiServer(options = {}) {
  const handler = options.handler ?? createApiHandler(options);
  const server = createHttpServer(handler);
  server.on("close", () => handler.close?.());
  return server;
}

/** Vite dev/preview middleware plugin. */
export function agentariumApiPlugin(options = {}) {
  let handler = null;
  const ensureHandler = async () => {
    if (!handler) handler = createApiHandler(await loadDataSourceOptions(options));
    return handler;
  };
  return {
    name: "agentarium-local-observer-api",
    async configureServer(server) {
      server.middlewares.use(await ensureHandler());
    },
    async configurePreviewServer(server) {
      server.middlewares.use(await ensureHandler());
    },
    closeBundle() {
      handler?.close?.();
    },
  };
}
