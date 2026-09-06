import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFixture } from "./fixture";

const layoutProbe = readFileSync(new URL("../../scripts/browser-layout-probe.js", import.meta.url), "utf8");

declare global {
  interface Window { sceneTransitions: string[] }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sceneTransitions = [];
    document.addEventListener("animationstart", event => {
      if (event.animationName === "surface-enter" && event.target instanceof Element) {
        window.sceneTransitions.push(event.target.className);
      }
    });
  });
});

async function inspectSurface(page: Page, info: TestInfo, name: string) {
  await page.waitForFunction(() => !document.getAnimations().some(animation =>
    animation instanceof CSSAnimation && animation.animationName === "surface-enter" && animation.playState === "running"));
  const geometry = await page.evaluate(layoutProbe) as { failures: unknown[] };
  expect(geometry.failures, `${name}: rendered geometry`).toEqual([]);
  const contrast = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  await info.attach(`${name}-contrast`, {
    body: JSON.stringify({ violations: contrast.violations, incomplete: contrast.incomplete }, null, 2),
    contentType: "application/json",
  });
  expect(contrast.violations, `${name}: rendered text contrast`).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

test("screens and interactive states stay readable and within the viewport", async ({ page }, info) => {
  await page.goto("/?hour=12");
  await expect(page.getByRole("heading", { name: "Your team, in view." })).toBeVisible();
  await inspectSurface(page, info, "overview");

  const review = page.getByRole("button", { name: "Review task Approve interface direction in map", exact: true });
  await review.hover();
  await inspectSurface(page, info, "review-hover");
  await page.mouse.move(0, 0);
  await review.focus();
  await expect(review).toBeFocused();
  expect(await review.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await inspectSurface(page, info, "review-focus");

  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await inspectSurface(page, info, "replay");
  await page.getByRole("button", { name: "Close replay", exact: true }).click();
  await page.getByRole("button", { name: /^Mission board,/ }).click();
  await inspectSurface(page, info, "missions");
  await page.getByRole("button", { name: "Close mission board", exact: true }).click();

  await page.getByRole("button", { name: "Connect", exact: true }).hover();
  await inspectSurface(page, info, "connect-hover");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "JSONL", exact: true }).click();
  await inspectSurface(page, info, "connect-jsonl");
  await page.getByRole("button", { name: "Close connection guide", exact: true }).click();

  await page.getByRole("button", { name: "Open project Release Readiness", exact: true }).click();
  await inspectSurface(page, info, "project");
  await page.getByRole("button", { name: "Open task Verify release candidate", exact: true }).click();
  await inspectSurface(page, info, "task");
  const inspect = page.getByRole("button", { name: "Inspect Verify release candidate", exact: true });
  await inspect.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await inspectSurface(page, info, "inspector");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(inspect).toBeFocused();
});

test("navigation fades do not replay on incoming source updates and honor reduced motion", async ({ page }) => {
  writeFixture();
  await page.goto("/?hour=12");
  const sceneStarts = () => page.evaluate(() => window.sceneTransitions.filter(name => name === "world-stage").length);
  await expect.poll(sceneStarts).toBe(1);
  await page.getByRole("button", { name: "Use live workspace source", exact: true }).click();
  await page.getByRole("button", { name: "Open project Release Readiness", exact: true }).click();
  await expect.poll(sceneStarts).toBe(2);
  await page.getByRole("button", { name: "Open task Verify release candidate", exact: true }).click();
  await expect.poll(sceneStarts).toBe(3);
  const stage = await page.locator(".world-stage").elementHandle();
  const inspect = page.getByRole("button", { name: "Inspect Verify release candidate", exact: true });
  await inspect.click();
  await expect.poll(() => page.evaluate(() => window.sceneTransitions.includes("inspector"))).toBe(true);
  const transitions = await page.evaluate(() => window.sceneTransitions.length);
  const close = page.getByRole("button", { name: "Close agent inspector", exact: true });
  await expect(close).toBeFocused();
  writeFixture("Browser update received");
  await expect(page.locator(".inspector .current-action")).toHaveText("Browser update received", { timeout: 10_000 });
  expect(await stage!.evaluate(element => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => window.sceneTransitions.length)).toBe(transitions);
  await expect(close).toBeFocused();
  await close.click();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Project map", exact: true }).click();
  await expect(page.locator(".world-stage")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.locator(".utility-dock__panel")).toHaveCSS("animation-name", "none");
});

test("the tab and header use the same loaded, cache-versioned village mark", async ({ page }) => {
  await page.goto("/?hour=12");
  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(icon).toMatch(/^\/assets\/brand-mark-[\w-]+\.svg$/);
  const brand = page.locator(".brand-mark img");
  await expect(brand).toHaveAttribute("src", icon!);
  await expect.poll(() => brand.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  const response = await page.request.get(icon!);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  expect(await response.text()).toBe(readFileSync(new URL("../../src/assets/brand-mark.svg", import.meta.url), "utf8"));
  await expect(page).toHaveTitle("Agentarium · Project map");
});
