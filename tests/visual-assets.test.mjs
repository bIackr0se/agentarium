import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function readableType(css) {
  for (const match of css.matchAll(/font-size:\s*([0-9.]+)(px|rem)\b/g)) {
    const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
    assert.ok(px >= 12, `Text below the 12px floor: ${match[0]}`);
  }
}

test("the type floor rejects a planted small label and accepts boundary and empty input", () => {
  assert.throws(() => readableType("font-size:11px"), /below/);
  assert.throws(() => readableType("font-size:0.5rem"), /below/);
  assert.doesNotThrow(() => readableType("font-size:12px; font-size:0.75rem"));
  assert.doesNotThrow(() => readableType(""));
});

test("the interface keeps readable typography and a reduced-motion path", async () => {
  for (const file of ["styles.css", "shell.css"]) {
    const css = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    readableType(css);
    assert.match(css, /prefers-reduced-motion/);
  }
});

test("every sculpted scene and robot ships as a real WebP with generation provenance", async () => {
  for (const name of ["reference-world", "workshop", "observatory", "garden", "village", "robot"]) {
    const file = new URL(`../public/assets/sculpted/${name}.webp`, import.meta.url);
    const bytes = await readFile(file);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    assert.ok(bytes.length > 10_000, `${name} is unexpectedly empty`);
    const provenance = await readFile(new URL(`${file.href}.json`), "utf8");
    assert.ok(provenance.includes("prompt"), `${name} is missing provenance`);
  }
});
