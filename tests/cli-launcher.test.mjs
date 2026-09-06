import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CliUsageError,
  DEFAULT_PORT,
  main,
  openBrowser,
  parseArgs,
  serverOptionsFor,
} from "../bin/agentarium.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPO_ROOT, "bin", "agentarium.mjs");

test("launcher parser has an explicit, provider-neutral Demo default", () => {
  assert.deepEqual(parseArgs([]), {
    provider: "demo",
    snapshot: null,
    port: DEFAULT_PORT,
    noOpen: false,
    validate: null,
    help: false,
  });
  assert.deepEqual(parseArgs(["--provider", "codex", "--no-open"]), {
    provider: "codex",
    snapshot: null,
    port: DEFAULT_PORT,
    noOpen: true,
    validate: null,
    help: false,
  });
  assert.deepEqual(parseArgs([
    "--provider=jsonl",
    "--snapshot=./world.jsonl",
    "--port=4317",
    "--no-open",
  ]), {
    provider: "jsonl",
    snapshot: "./world.jsonl",
    port: 4317,
    noOpen: true,
    validate: null,
    help: false,
  });
});

test("launcher parser requires snapshots only for file providers", () => {
  assert.deepEqual(parseArgs(["--provider", "json", "--snapshot", "/tmp/world.json"]), {
    provider: "json",
    snapshot: "/tmp/world.json",
    port: DEFAULT_PORT,
    noOpen: false,
    validate: null,
    help: false,
  });
  assert.throws(() => parseArgs(["--provider", "json"]), {
    name: "CliUsageError",
    message: "--snapshot is required with --provider json.",
  });
  assert.throws(() => parseArgs(["--provider", "demo", "--snapshot", "/tmp/world.json"]), {
    name: "CliUsageError",
    message: "--snapshot is only valid with --provider json or --provider jsonl.",
  });
  assert.deepEqual(parseArgs(["--validate", "/tmp/world.json"]), {
    provider: "demo",
    snapshot: null,
    port: DEFAULT_PORT,
    noOpen: false,
    validate: "/tmp/world.json",
    help: false,
  });
  assert.throws(() => parseArgs(["--validate", "/tmp/world.json", "--provider", "json"]), /cannot be combined/);
});

test("launcher parser rejects null, unknown, malformed, and ambiguous input", () => {
  assert.deepEqual(parseArgs(undefined), parseArgs([]));
  assert.throws(() => parseArgs(null), { name: "TypeError" });
  assert.throws(() => parseArgs(["--provider", "unknown"]), /Unsupported provider/);
  assert.throws(() => parseArgs(["--provider"]), /--provider requires a value/);
  assert.throws(() => parseArgs(["--snapshot"]), /--snapshot requires a value/);
  assert.throws(() => parseArgs(["--validate"]), /--validate requires a value/);
  assert.throws(() => parseArgs(["--port", "12.5"]), /Invalid port/);
  assert.throws(() => parseArgs(["--port", "65536"]), /Invalid port/);
  assert.throws(() => parseArgs(["--no-open", "--no-open"]), /may only be provided once/);
  assert.throws(() => parseArgs(["--provider", "demo", "--port", "4173", "extra"]), /Unexpected argument/);
  assert.throws(() => parseArgs(["--host", "0.0.0.0"]), /Unknown option/);
});

test("server options resolve file paths and isolate ambient provider settings", () => {
  assert.deepEqual(serverOptionsFor(parseArgs([]), "/tmp/agentarium"), {
    provider: "snapshot",
    env: {},
    port: DEFAULT_PORT,
  });
  assert.deepEqual(serverOptionsFor(
    parseArgs(["--provider", "json", "--snapshot", "./world.json"]),
    "/tmp/agentarium",
  ), {
    provider: "json",
    env: {},
    port: DEFAULT_PORT,
    snapshotPath: "/tmp/agentarium/world.json",
  });
});

test("browser launch uses a fixed command and argv, never a shell string", () => {
  let invocation = null;
  const child = {
    once() { return this; },
    unref() {},
  };
  assert.equal(openBrowser("http://127.0.0.1:4317", {
    platform: "linux",
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  }), true);
  assert.deepEqual(invocation, {
    command: "xdg-open",
    args: ["http://127.0.0.1:4317/"],
    options: { detached: true, shell: false, stdio: "ignore" },
  });

  let unsafeInvocation = false;
  assert.equal(openBrowser("https://example.com/?next=http://127.0.0.1:4317", {
    platform: "linux",
    spawnImpl() { unsafeInvocation = true; return child; },
  }), false);
  assert.equal(unsafeInvocation, false);
});

test("package metadata exposes the launcher and its packed runtime", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.bin.agentarium, "./bin/agentarium.mjs");
  assert.ok(packageJson.files.includes("bin"));
  assert.ok(packageJson.files.includes("dist"));
  assert.ok(packageJson.files.includes("server"));
  assert.ok(packageJson.files.includes("src/lib/demo-fixture.mjs"));
  assert.equal(packageJson.scripts.prepare, "npm run build");
});

test("launcher validates a provider snapshot without starting a server", async () => {
  const messages = [];
  const result = await main(["--validate", "docs/world-snapshot.example.json"], {
    cwd: REPO_ROOT,
    log(message) { messages.push(message); },
    installSignals: false,
    startServerImpl() { throw new Error("validation must not start the server"); },
  });
  assert.equal(result.server, null);
  assert.equal(result.url, null);
  assert.deepEqual(messages, ["Valid Agentarium snapshot: 1 projects, 2 agents, 1 events."]);
});

function waitForStartup(child) {
  return new Promise((resolveStartup, rejectStartup) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectStartup(new Error(`launcher did not start\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);
    const check = () => {
      const match = stdout.match(/Agentarium listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match || !/Source:/.test(stdout)) return;
      clearTimeout(timeout);
      resolveStartup({ url: match[1], stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      check();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectStartup(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") return;
      clearTimeout(timeout);
      rejectStartup(new Error(`launcher exited before startup (${code ?? signal})\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStopped) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      resolveStopped();
    };
    const forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 3_000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

test("launcher smoke starts Demo on an ephemeral loopback port without network access", async (t) => {
  const child = spawn(process.execPath, [LAUNCHER, "--provider", "demo", "--port", "0", "--no-open"], {
    cwd: REPO_ROOT,
    env: { ...process.env, AGENTARIUM_PROVIDER: "codex", AGENTARIUM_SNAPSHOT_PATH: "/not-read-by-demo" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));

  const startup = await waitForStartup(child);
  assert.match(startup.stdout, /Source: Demo \(synthetic, read-only\)/);
  const healthResponse = await fetch(`${startup.url}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.readOnly, true);
  assert.equal(health.configured, false);
  assert.equal(health.provider, "snapshot-json");

  const demoResponse = await fetch(`${startup.url}/api/snapshot?mode=demo`);
  assert.equal(demoResponse.status, 200);
  const demo = await demoResponse.json();
  assert.equal(demo.mode, "demo");
  assert.equal(demo.sourceLabel, "Demo world");
});
