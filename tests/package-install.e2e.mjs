#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name;
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const COMMAND_TIMEOUT_MS = 180_000;
const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 24_000;

function appendOutput(current, chunk) {
  if (current.length >= OUTPUT_LIMIT) return current;
  return `${current}${chunk}`.slice(0, OUTPUT_LIMIT);
}

function runCommand(command, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, envOverrides = {} } = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, npm_config_update_notifier: "false", ...envOverrides },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectCommand(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceTimer = null;
    let timeoutTimer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) rejectCommand(error);
      else resolveCommand({ ...result, stdout, stderr });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(null, { code, signal });
        return;
      }
      finish(new Error(`${command} exited with ${code ?? signal ?? "an unknown status"}.\n${stderr || stdout}`));
    });
    timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`${command} timed out after ${timeoutMs}ms.`));
      }, 2_000);
    }, timeoutMs);
  });
}

function waitForStartup(child, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolveStartup, rejectStartup) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Installed launcher did not start within ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectStartup(error);
      else resolveStartup({ ...result, stdout, stderr });
    };
    const check = () => {
      const match = stdout.match(/Agentarium listening on (http:\/\/127\.0\.0\.1:(\d+))/);
      if (!match) return;
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        finish(new Error("Installed launcher reported an invalid loopback port."));
        return;
      }
      finish(null, { url: match[1], port });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
      check();
    });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Installed launcher exited before startup (${code ?? signal ?? "unknown"}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error("Installed launcher did not terminate in time.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function stopLauncher(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000).catch(() => {});
    throw error;
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonResponse(url) {
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON from ${url}, received ${response.status}: ${error.message}`);
  }
  return { response, body, text };
}

function assertHashedAsset(path, extension) {
  assert.match(path, new RegExp(`^/assets/[^/]+-[A-Za-z0-9_-]{6,}\\.${extension}$`), `expected hashed ${extension} asset: ${path}`);
}

function assertNoAbsolutePathLeak(label, payload, paths) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const path of paths) assert.equal(text.includes(path), false, `${label} leaked a configured path`);
  const absolutePathPattern = process.platform === "win32"
    ? /[A-Za-z]:[\\/](?:Users|temp|tmp|private|var|home|opt|workspace)[^"\s]*/i
    : /(?:^|["\s])\/(?:Users|private|tmp|var|home|opt|workspace)\//;
  assert.doesNotMatch(text, absolutePathPattern, `${label} leaked an absolute path`);
}

function relativeTree(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      paths.push(relative(root, absolute));
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
    }
  };
  visit(root);
  return paths.sort();
}

async function main() {
  assert.ok(existsSync(join(REPO_ROOT, "dist", "index.html")), "dist/index.html is required; build before running this e2e script");
  const tempRoot = mkdtempSync(join(tmpdir(), "agentarium-package-install-"));
  const packDirectory = join(tempRoot, "pack");
  const consumerDirectory = join(tempRoot, "consumer");
  const inputDirectory = join(tempRoot, "input");
  const npmCacheDirectory = join(tempRoot, "npm-cache");
  const emptyHomeDirectory = join(tempRoot, "empty-home");
  let launcher = null;
  try {
    for (const directory of [packDirectory, consumerDirectory, inputDirectory, emptyHomeDirectory]) {
      // npm creates its consumer node_modules tree; the other directories are
      // created explicitly so every path remains inside the one cleanup root.
      mkdirSync(directory, { recursive: true });
    }

    const fixturePath = join(inputDirectory, "world.json");
    const repoFixturePath = join(REPO_ROOT, "docs", "world-snapshot.example.json");
    copyFileSync(repoFixturePath, fixturePath);
    assert.equal(fixturePath.startsWith(`${REPO_ROOT}${sep}`), false, "fixture must be copied outside the repository");

    const npmEnvOverrides = { npm_config_cache: npmCacheDirectory };
    await runCommand(NPM_COMMAND, ["pack", "--ignore-scripts", "--pack-destination", packDirectory], {
      cwd: REPO_ROOT,
      envOverrides: npmEnvOverrides,
    });
    const tarballs = readdirSync(packDirectory).filter((entry) => entry.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "npm pack should produce exactly one tarball");
    const tarballPath = join(packDirectory, tarballs[0]);

    writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({
      name: "agentarium-package-e2e-consumer",
      private: true,
      version: "1.0.0",
    }, null, 2));
    await runCommand(NPM_COMMAND, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", tarballPath], {
      cwd: consumerDirectory,
      timeoutMs: COMMAND_TIMEOUT_MS,
      envOverrides: npmEnvOverrides,
    });

    const installedPackageDirectory = join(consumerDirectory, "node_modules", ...PACKAGE_NAME.split("/"));
    const installedLauncher = join(installedPackageDirectory, "bin", "agentarium.mjs");
    const installedBinary = join(consumerDirectory, "node_modules", ".bin", process.platform === "win32" ? "agentarium.cmd" : "agentarium");
    assert.ok(existsSync(installedLauncher), "packed launcher source is installed");
    assert.ok(existsSync(installedBinary), "npm installed the agentarium binary link");

    const cliArguments = ["--provider", "json", "--snapshot", fixturePath, "--port", "0", "--no-open"];
    const command = process.platform === "win32" ? process.execPath : installedBinary;
    const args = process.platform === "win32" ? [installedLauncher, ...cliArguments] : cliArguments;
    launcher = spawn(command, args, {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        AGENTARIUM_PROVIDER: "codex",
        AGENTARIUM_SNAPSHOT_PATH: "/ambient/private/world.json",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const startup = await waitForStartup(launcher);
    const startupUrl = new URL(startup.url);
    assert.equal(startupUrl.protocol, "http:");
    assert.equal(startupUrl.hostname, "127.0.0.1");
    assert.ok(startup.port, "launcher must report the ephemeral port it received");
    assert.equal(startup.stdout.includes("0.0.0.0"), false);
    assert.equal(startup.stdout.includes("[::]"), false);

    const homeResponse = await fetchWithTimeout(startup.url);
    assert.equal(homeResponse.status, 200);
    const html = await homeResponse.text();
    assert.match(html, /<html[^>]+>/i);
    const scriptPath = html.match(/<script[^>]+src=["']([^"']+\.js)["']/i)?.[1];
    const stylePath = html.match(/<link[^>]+href=["']([^"']+\.css)["']/i)?.[1];
    assert.ok(scriptPath, "packed HTML should reference its JavaScript bundle");
    assert.ok(stylePath, "packed HTML should reference its CSS bundle");
    assertHashedAsset(scriptPath, "js");
    assertHashedAsset(stylePath, "css");

    const scriptResponse = await fetchWithTimeout(new URL(scriptPath, startup.url));
    assert.equal(scriptResponse.status, 200);
    assert.ok((await scriptResponse.arrayBuffer()).byteLength > 0);
    const styleResponse = await fetchWithTimeout(new URL(stylePath, startup.url));
    assert.equal(styleResponse.status, 200);
    const css = await styleResponse.text();
    assert.ok(css.length > 0);
    const fontPaths = [...css.matchAll(/url\(\s*["']?(\/assets\/[^"')\s]+\.woff2)["']?\s*\)/g)].map((match) => match[1]);
    assert.ok(fontPaths.length > 0, "packed CSS should reference at least one font asset");
    for (const fontPath of [...new Set(fontPaths)]) {
      assertHashedAsset(fontPath, "woff2");
      const fontResponse = await fetchWithTimeout(new URL(fontPath, startup.url));
      assert.equal(fontResponse.status, 200, `font asset should be served: ${fontPath}`);
      assert.ok((await fontResponse.arrayBuffer()).byteLength > 0);
    }

    const live = await jsonResponse(`${startup.url}/api/snapshot?mode=live`);
    assert.equal(live.response.status, 200);
    assert.equal(live.body.mode, "live");
    assert.equal(live.body.sourceLabel, "Example harness");
    assert.equal(live.body.privacy.rawContentExposed, false);
    assert.equal(live.body.agents.length, 2);
    assertNoAbsolutePathLeak("live snapshot", live.body, [fixturePath, tempRoot, "/ambient/private/world.json"]);

    const health = await jsonResponse(`${startup.url}/api/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.mode, "live");
    assert.equal(health.body.readOnly, true);
    assert.equal(health.body.configured, true);
    assert.equal(health.body.provider, "snapshot-json");
    assert.equal(health.body.format, "json");
    assert.equal(health.body.source, "snapshot-json");
    assert.equal(health.body.ready, true);
    assertNoAbsolutePathLeak("health response", health.body, [fixturePath, tempRoot, "/ambient/private/world.json"]);

    const demo = await jsonResponse(`${startup.url}/api/snapshot?mode=demo`);
    assert.equal(demo.response.status, 200);
    assert.equal(demo.body.mode, "demo");
    assert.equal(demo.body.sourceLabel, "Demo world");
    assert.ok(demo.body.agents.length > 0);
    assert.equal(demo.body.privacy.rawContentExposed, false);
    assertNoAbsolutePathLeak("Demo snapshot", demo.body, [fixturePath, tempRoot, "/ambient/private/world.json"]);

    await stopLauncher(launcher);
    launcher = null;

    const jsonlFixturePath = join(inputDirectory, "world.jsonl");
    writeFileSync(jsonlFixturePath, `${JSON.stringify(JSON.parse(readFileSync(fixturePath, "utf8")))}\n`);
    launcher = spawn(command, process.platform === "win32"
      ? [installedLauncher, "--provider", "jsonl", "--snapshot", jsonlFixturePath, "--port", "0", "--no-open"]
      : ["--provider", "jsonl", "--snapshot", jsonlFixturePath, "--port", "0", "--no-open"], {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        AGENTARIUM_PROVIDER: "codex",
        AGENTARIUM_SNAPSHOT_PATH: "/ambient/private/world.jsonl",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const jsonlStartup = await waitForStartup(launcher);
    const jsonlUrl = new URL(jsonlStartup.url);
    assert.equal(jsonlUrl.protocol, "http:");
    assert.equal(jsonlUrl.hostname, "127.0.0.1");
    assert.ok(jsonlUrl.port);
    const jsonlLive = await jsonResponse(`${jsonlStartup.url}/api/snapshot?mode=live`);
    assert.equal(jsonlLive.response.status, 200);
    assert.equal(jsonlLive.body.mode, "live");
    assert.equal(jsonlLive.body.sourceLabel, "Example harness");
    assert.equal(jsonlLive.body.privacy.rawContentExposed, false);
    assert.equal(jsonlLive.body.agents.length, 2);
    assertNoAbsolutePathLeak("JSONL live snapshot", jsonlLive.body, [jsonlFixturePath, tempRoot, "/ambient/private/world.jsonl"]);
    const jsonlHealth = await jsonResponse(`${jsonlStartup.url}/api/health`);
    assert.equal(jsonlHealth.response.status, 200);
    assert.equal(jsonlHealth.body.ok, true);
    assert.equal(jsonlHealth.body.readOnly, true);
    assert.equal(jsonlHealth.body.configured, true);
    assert.equal(jsonlHealth.body.provider, "snapshot-jsonl");
    assert.equal(jsonlHealth.body.format, "jsonl");
    assert.equal(jsonlHealth.body.source, "snapshot-jsonl");
    assert.equal(jsonlHealth.body.ready, true);
    assertNoAbsolutePathLeak("JSONL health response", jsonlHealth.body, [jsonlFixturePath, tempRoot, "/ambient/private/world.jsonl"]);

    await stopLauncher(launcher);
    launcher = null;

    const emptyHomeBefore = relativeTree(emptyHomeDirectory);
    launcher = spawn(command, process.platform === "win32"
      ? [installedLauncher, "--provider", "codex", "--port", "0", "--no-open"]
      : ["--provider", "codex", "--port", "0", "--no-open"], {
      cwd: consumerDirectory,
      env: {
        ...process.env,
        HOME: emptyHomeDirectory,
        USERPROFILE: emptyHomeDirectory,
        AGENTARIUM_PROVIDER: "json",
        AGENTARIUM_SNAPSHOT_PATH: join(emptyHomeDirectory, "ambient.json"),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const codexStartup = await waitForStartup(launcher);
    const codexUrl = new URL(codexStartup.url);
    assert.equal(codexUrl.protocol, "http:");
    assert.equal(codexUrl.hostname, "127.0.0.1");
    assert.ok(codexUrl.port);
    const codexLive = await jsonResponse(`${codexStartup.url}/api/snapshot?mode=live`);
    assert.equal(codexLive.response.status, 200);
    assert.equal(codexLive.body.mode, "live");
    assert.deepEqual(codexLive.body.projects, []);
    assert.deepEqual(codexLive.body.agents, []);
    assert.ok(codexLive.body.warnings.length > 0);
    assert.equal(codexLive.body.privacy.rawContentExposed, false);
    assertNoAbsolutePathLeak("Codex live snapshot", codexLive.body, [fixturePath, jsonlFixturePath, emptyHomeDirectory, tempRoot, "/ambient/private/world.json"]);
    const codexHealth = await jsonResponse(`${codexStartup.url}/api/health`);
    assert.equal(codexHealth.response.status, 200);
    assert.equal(codexHealth.body.ok, true);
    assert.equal(codexHealth.body.provider, "codex-sqlite");
    assert.equal(codexHealth.body.readOnly, true);
    assertNoAbsolutePathLeak("Codex health response", codexHealth.body, [fixturePath, jsonlFixturePath, emptyHomeDirectory, tempRoot, "/ambient/private/world.json"]);

    await stopLauncher(launcher);
    launcher = null;
    assert.deepEqual(relativeTree(emptyHomeDirectory), emptyHomeBefore, "Codex startup must not create files under HOME");
  } finally {
    await stopLauncher(launcher).catch((error) => {
      console.error(`launcher cleanup warning: ${error.message}`);
    });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log("package install e2e: pass");
} catch (error) {
  console.error(`package install e2e: fail: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
