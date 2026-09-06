import { describe, expect, it } from "vitest";
import { normalizeClientSnapshot } from "./snapshot-contract";

function fixture(value: string) {
  return {
    schemaVersion: 1,
    mode: "live",
    generatedAt: "2026-08-30T12:00:00.000Z",
    sourceFreshness: "2026-08-30T12:00:00.000Z",
    projects: [{ id: "project-test", name: "Example project", color: "#7ee7d1", agentIds: ["agent-test"] }],
    agents: [{
      id: "agent-test",
      title: value,
      projectId: "project-test",
      projectName: "Example project",
      state: "running",
      evidence: "observed",
      lastSeen: "2026-08-30T12:00:00.000Z",
      ageMs: 0,
      currentAction: value,
      childCount: 0,
      events: [{
        id: "event-test",
        agentId: "agent-test",
        timestamp: "2026-08-30T12:00:00.000Z",
        kind: "command",
        label: value,
        state: "running",
        source: "fixture",
        evidence: "observed",
      }],
    }],
    attention: [],
    privacy: { rawContentExposed: false, redactionsApplied: 0 },
    warnings: [],
  };
}

describe("browser snapshot privacy boundary", () => {
  it("redacts underscore secrets, generic POSIX paths, and compressed IPv6", () => {
    for (const value of [
      "sk_live_12345678901234567890",
      "token_12345678901234567890",
      "/repo/worktree",
      "/run/user/501/socket",
      "/tmp",
      "/Users/José/code",
      "/home/dev+ops/work",
      "/repo/José/code",
      "/Users/José Rahman/O'Brien/code",
      "/repo/My Project/O'Brien/file",
      "/TMP",
      "C:\\Users\\José Rahman\\code",
      "file:///Users/José Rahman/code",
      "fe80::1",
      "2001:db8::dead:beef",
      "::ffff:192.0.2.1",
    ]) {
      const normalized = normalizeClientSnapshot(fixture(value));
      expect(normalized).not.toBeNull();
      expect(JSON.stringify(normalized)).not.toContain(value);
      expect(JSON.stringify(normalized)).toContain("[redacted]");
      if (value === "/Users/José/code") expect(JSON.stringify(normalized)).not.toContain("José");
      if (value === "/home/dev+ops/work") expect(JSON.stringify(normalized)).not.toContain("dev+ops");
      if (value === "/repo/José/code") expect(JSON.stringify(normalized)).not.toContain("José");
      if (value.includes("José Rahman")) expect(JSON.stringify(normalized)).not.toContain("José Rahman");
      if (value.includes("O'Brien")) expect(JSON.stringify(normalized)).not.toContain("O'Brien");
    }
  });

  it("preserves ordinary prose, URLs, relative slashes, and non-IPv6 colons", () => {
    for (const value of ["ordinary project note", "https://example.com/docs", "read/write", "1:2:3", "token_1234"]) {
      const normalized = normalizeClientSnapshot(fixture(value));
      expect(normalized?.agents[0]?.title).toBe(value);
      expect(normalized?.agents[0]?.currentAction).toBe(value);
      expect(normalized?.agents[0]?.events[0]?.label).toBe(value);
    }
  });

  it("preserves structured fields that follow a redacted path", () => {
    const normalized = normalizeClientSnapshot(fixture("cwd=/Users/José Rahman/code action=running"));
    expect(normalized?.agents[0]?.title).toBe("cwd=[redacted] action=running");
    expect(JSON.stringify(normalized)).not.toContain("José Rahman");
  });

  it("fails closed for null and malformed ingress", () => {
    expect(normalizeClientSnapshot(null)).toBeNull();
    expect(normalizeClientSnapshot(undefined)).toBeNull();
    expect(normalizeClientSnapshot({ schemaVersion: 1 })).toBeNull();
  });
});
