import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startServer } from "../server/index.mjs";

test("production shell stays loopback-only and permits its bounded inline layout styles", async (t) => {
  const distDir = mkdtempSync(join(tmpdir(), "agentarium-static-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Agentarium</title>", "utf8");
  const apiHandler = (_req, res) => {
    res.writeHead(404);
    res.end();
  };
  apiHandler.close = () => {};
  const server = await startServer({ port: 0, distDir, apiHandler });
  t.after(() => {
    server.close();
    rmSync(distDir, { recursive: true, force: true });
  });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));

  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  const policy = response.headers.get("content-security-policy") ?? "";
  assert.match(policy, /style-src 'self'/);
  assert.match(policy, /style-src-attr 'unsafe-inline'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(await response.text(), "<!doctype html><title>Agentarium</title>");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const artPath = join(distDir, "world.svg");
  writeFileSync(artPath, '<svg xmlns="http://www.w3.org/2000/svg"><title>First world</title></svg>');
  const assetUrl = `http://127.0.0.1:${address.port}/world.svg`;
  const first = await fetch(assetUrl);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  assert.match(await first.text(), /First world/);
  writeFileSync(artPath, '<svg xmlns="http://www.w3.org/2000/svg"><title>Updated world</title></svg>');
  const updated = await fetch(assetUrl);
  assert.equal(updated.headers.get("cache-control"), "no-cache");
  assert.match(await updated.text(), /Updated world/);
});
