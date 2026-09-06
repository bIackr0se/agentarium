import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createApiHandler } from "./api.mjs";
import { loadDataSourceOptions } from "./data-source.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_DIST = join(ROOT, "dist");
const LOOPBACK = "127.0.0.1";

function staticFile(distDir, pathname) {
  if (!pathname || pathname === "/") pathname = "/index.html";
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0") || decoded.includes("..")) return null;
  const candidate = resolve(distDir, `.${decoded}`);
  if (!(candidate === distDir || candidate.startsWith(`${distDir}${sep}`))) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

function createStaticHandler(apiHandler, distDir) {
  return (req, res) => {
    if (typeof req.url === "string" && req.url.startsWith("/api/")) {
      apiHandler(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    let file = staticFile(distDir, pathname);
    // A client-side route gets the app shell.  If no dist exists, return a
    // bounded diagnostic rather than exposing a filesystem error.
    if (!file && existsSync(join(distDir, "index.html"))) file = join(distDir, "index.html");
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Agentarium build is not available");
      return;
    }
    let content;
    try { content = readFileSync(file); } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Agentarium asset is unavailable");
      return;
    }
    const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const contentType = extension === "html" ? "text/html; charset=utf-8" : extension === "js" ? "text/javascript; charset=utf-8" : extension === "css" ? "text/css; charset=utf-8" : extension === "svg" ? "image/svg+xml" : "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.byteLength,
      "Cache-Control": file.endsWith("index.html") ? "no-store" : "no-cache",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method === "HEAD") res.end();
    else res.end(content);
  };
}

export async function startServer(options = {}) {
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : Number(process.env.PORT || 4173);
  const distDir = resolve(options.distDir ?? DEFAULT_DIST);
  const resolvedOptions = options.apiHandler ? options : await loadDataSourceOptions(options);
  const apiHandler = options.apiHandler ?? createApiHandler(resolvedOptions);
  const handler = createStaticHandler(apiHandler, distDir);
  // A literal loopback host is intentional.  Do not accept HOST from the
  // environment because a convenient deployment setting could publish local
  // transcript-derived state to a LAN interface.
  const server = createHttpServer(handler);
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    apiHandler.close?.();
    return originalClose(callback);
  };
  server.listen(port, LOOPBACK);
  return server;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  const server = await startServer();
  server.on("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : "unknown";
    console.log(`Agentarium listening on http://${LOOPBACK}:${actualPort}`);
  });
  server.on("error", () => {
    console.error("Agentarium server failed to start");
    process.exitCode = 1;
  });
}
