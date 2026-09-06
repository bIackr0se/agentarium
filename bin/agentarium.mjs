#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startServer } from "../server/index.mjs";
import { validateSnapshotFile } from "../server/validate-snapshot.mjs";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4173;
export const SUPPORTED_PROVIDERS = Object.freeze(["demo", "codex", "json", "jsonl"]);

export const USAGE = `Usage: agentarium [options]

Start the read-only Agentarium server on loopback and open it in a browser.

Options:
  --provider <demo|codex|json|jsonl>  Source to use (default: demo)
  --snapshot <path>                   JSON or JSONL source path
  --validate <path|->                 Validate a snapshot file, then exit
  --port <0-65535>                    Port to bind (default: 4173; 0 picks a free port)
  --no-open                           Do not open a browser automatically
  --help                              Show this help

Run without cloning or building (Node.js 24+):
  npx --yes agentarium-map@latest --provider demo
  npx --yes agentarium-map@latest --provider codex
  npx --yes agentarium-map@latest --provider json --snapshot ./world.json
  npx --yes agentarium-map@latest --provider jsonl --snapshot ./world.jsonl --port 4174 --no-open
  npx --yes agentarium-map@latest --validate ./world.json`;

const FILE_PROVIDERS = new Set(["json", "jsonl"]);

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

function missingValue(option) {
  throw new CliUsageError(`${option} requires a value.`);
}

function readValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== "string") {
    if (value === undefined || value === "--") missingValue(option);
    throw new TypeError("Arguments must contain only strings.");
  }
  if (value.startsWith("--")) missingValue(option);
  if (value === "") throw new CliUsageError(`${option} requires a non-empty value.`);
  return value;
}

function parseProvider(value) {
  const provider = value.trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new CliUsageError(`Unsupported provider "${value}". Choose demo, codex, json, or jsonl.`);
  }
  return provider;
}

function parsePort(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new CliUsageError(`Invalid port "${value}". Use an integer from 0 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new CliUsageError(`Invalid port "${value}". Use an integer from 0 to 65535.`);
  }
  return port;
}

function parseValueOption(token, option) {
  const prefix = `${option}=`;
  if (!token.startsWith(prefix)) return null;
  const value = token.slice(prefix.length);
  if (!value) throw new CliUsageError(`${option} requires a non-empty value.`);
  return value;
}

/**
 * Parse the launcher arguments without reading environment variables or
 * touching the filesystem. This keeps invalid invocations deterministic and
 * makes the provider choice explicit at the process boundary.
 */
export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError("Arguments must be an array.");

  const options = {
    provider: "demo",
    snapshot: null,
    port: DEFAULT_PORT,
    noOpen: false,
    validate: null,
    help: false,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string") throw new TypeError("Arguments must contain only strings.");

    if (token === "--help") {
      if (seen.has("--help")) throw new CliUsageError("Option --help may only be provided once.");
      seen.add("--help");
      options.help = true;
      continue;
    }

    if (token === "--no-open") {
      if (seen.has("--no-open")) throw new CliUsageError("Option --no-open may only be provided once.");
      seen.add("--no-open");
      options.noOpen = true;
      continue;
    }

    if (token === "--provider" || token.startsWith("--provider=")) {
      if (seen.has("--provider")) throw new CliUsageError("Option --provider may only be provided once.");
      seen.add("--provider");
      const value = token === "--provider" ? readValue(argv, index++, "--provider") : parseValueOption(token, "--provider");
      options.provider = parseProvider(value);
      continue;
    }

    if (token === "--snapshot" || token.startsWith("--snapshot=")) {
      if (seen.has("--snapshot")) throw new CliUsageError("Option --snapshot may only be provided once.");
      seen.add("--snapshot");
      const value = token === "--snapshot" ? readValue(argv, index++, "--snapshot") : parseValueOption(token, "--snapshot");
      if (value.includes("\0")) throw new CliUsageError("Snapshot path cannot contain a NUL byte.");
      options.snapshot = value;
      continue;
    }

    if (token === "--validate" || token.startsWith("--validate=")) {
      if (seen.has("--validate")) throw new CliUsageError("Option --validate may only be provided once.");
      seen.add("--validate");
      const value = token === "--validate" ? readValue(argv, index++, "--validate") : parseValueOption(token, "--validate");
      if (value.includes("\0")) throw new CliUsageError("Validation path cannot contain a NUL byte.");
      options.validate = value;
      continue;
    }

    if (token === "--port" || token.startsWith("--port=")) {
      if (seen.has("--port")) throw new CliUsageError("Option --port may only be provided once.");
      seen.add("--port");
      const value = token === "--port" ? readValue(argv, index++, "--port") : parseValueOption(token, "--port");
      options.port = parsePort(value);
      continue;
    }

    if (token.startsWith("-")) throw new CliUsageError(`Unknown option "${token}".`);
    throw new CliUsageError(`Unexpected argument "${token}".`);
  }

  if (options.validate !== null) {
    const incompatible = ["--provider", "--snapshot", "--port", "--no-open"].filter((option) => seen.has(option));
    if (incompatible.length) {
      throw new CliUsageError(`--validate cannot be combined with ${incompatible.join(", ")}.`);
    }
    return options;
  }
  if (options.snapshot !== null && !FILE_PROVIDERS.has(options.provider)) {
    throw new CliUsageError("--snapshot is only valid with --provider json or --provider jsonl.");
  }
  if (FILE_PROVIDERS.has(options.provider) && options.snapshot === null) {
    throw new CliUsageError(`--snapshot is required with --provider ${options.provider}.`);
  }

  return options;
}

/**
 * Convert parsed arguments into the existing server startup contract. Demo is
 * deliberately represented as an unconfigured snapshot source: the browser
 * still renders its local synthetic Demo route, while Live cannot silently
 * read a provider or ambient snapshot path.
 */
export function serverOptionsFor(options, cwd = process.cwd()) {
  if (!options || typeof options !== "object") throw new TypeError("Launcher options are required.");
  if (options.help || options.validate !== null) return null;
  if (typeof cwd !== "string" || !cwd) throw new TypeError("A working directory is required.");

  const serverOptions = {
    provider: options.provider === "demo" ? "snapshot" : options.provider,
    env: {},
    port: options.port,
  };
  if (options.snapshot !== null) serverOptions.snapshotPath = resolve(cwd, options.snapshot);
  return serverOptions;
}

export function browserCommand(platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "explorer.exe", args: [] };
  if (platform === "linux") return { command: "xdg-open", args: [] };
  return null;
}

/**
 * Open only a loopback URL, using argv-style child-process arguments. The
 * browser helper is best effort and never becomes a server dependency.
 */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let target;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== LOOPBACK_HOST || target.username || target.password) return false;
  } catch {
    return false;
  }

  const launcher = browserCommand(platform);
  if (!launcher || typeof spawnImpl !== "function") return false;
  try {
    const child = spawnImpl(launcher.command, [...launcher.args, target.href], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child?.once?.("error", () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function waitForListening(server) {
  if (!server || typeof server.once !== "function") {
    return Promise.reject(new Error("Server startup returned an invalid server."));
  }
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolveListening, rejectListening) => {
    const onListening = () => {
      server.off?.("error", onError);
      resolveListening(server);
    };
    const onError = (error) => {
      server.off?.("listening", onListening);
      rejectListening(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server) {
  if (!server || typeof server.close !== "function") return Promise.resolve();
  return new Promise((resolveClosed) => {
    try {
      server.close(() => resolveClosed());
    } catch {
      resolveClosed();
    }
  });
}

function startupError(error, options) {
  if (error?.code === "EADDRINUSE") {
    return new Error(`Port ${options.port} is already in use. Choose another port with --port.`);
  }
  if (error?.code === "EACCES") {
    return new Error(`Port ${options.port} cannot be opened. Choose another port with --port.`);
  }
  if (String(error?.message ?? error).includes("node:sqlite")) {
    return new Error("The Codex provider needs Node.js 24 or newer with node:sqlite available.");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Could not start Agentarium on ${LOOPBACK_HOST}:${options.port}: ${message}`);
}

function sourceDescription(provider) {
  if (provider === "demo") return "Demo (synthetic, read-only)";
  if (provider === "codex") return "Codex SQLite (read-only)";
  if (provider === "json") return "JSON snapshot (read-only)";
  return "JSONL snapshot (read-only)";
}

function installSignalHandlers(server) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeServer(server);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseArgs(argv);
  const config = runtime && typeof runtime === "object" ? runtime : {};
  const log = typeof config.log === "function" ? config.log : console.log;
  const report = typeof config.error === "function" ? config.error : console.error;
  if (options.help) {
    log(USAGE);
    return { options, server: null, url: null };
  }

  if (options.validate !== null) {
    const fileName = options.validate === "-" ? "-" : resolve(config.cwd ?? process.cwd(), options.validate);
    const snapshots = validateSnapshotFile(fileName);
    const last = snapshots.at(-1);
    const events = last.agents.reduce((sum, agent) => sum + agent.events.length, 0);
    log(`Valid Agentarium snapshot: ${last.projects.length} projects, ${last.agents.length} agents, ${events} events${snapshots.length > 1 ? `, ${snapshots.length} records` : ""}.`);
    return { options, server: null, url: null };
  }

  const startServerImpl = typeof config.startServerImpl === "function" ? config.startServerImpl : startServer;
  const openBrowserImpl = typeof config.openBrowserImpl === "function" ? config.openBrowserImpl : openBrowser;
  const serverOptions = serverOptionsFor(options, config.cwd ?? process.cwd());
  let server = null;
  try {
    server = await startServerImpl(serverOptions);
    await waitForListening(server);
    const address = server.address?.();
    if (!address || typeof address !== "object" || address.address !== LOOPBACK_HOST) {
      throw new Error("Refusing to expose Agentarium outside loopback.");
    }
    const actualPort = address.port;
    const url = `http://${LOOPBACK_HOST}:${actualPort}`;
    log(`Agentarium listening on ${url}`);
    log(`Source: ${sourceDescription(options.provider)}. Select Live in the browser when you are ready.`);
    if (!options.noOpen && !openBrowserImpl(url)) {
      report(`Could not open a browser automatically. Open ${url} manually.`);
    }
    if (config.installSignals !== false) installSignalHandlers(server);
    return { options, server, url };
  } catch (error) {
    await closeServer(server);
    throw startupError(error, options);
  }
}

let entrypoint = "";
try {
  entrypoint = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : "";
} catch {
  entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
}
if (import.meta.url === entrypoint) {
  try {
    await main();
  } catch (error) {
    console.error(`Agentarium launcher: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 1;
  }
}
