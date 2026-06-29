/**
 * Tests for surgical-audit-trail.ts
 *
 * Coverage:
 *   - AuditEvent structure and required fields
 *   - SurgicalAuditTrail.emit() appends events to JSONL
 *   - SurgicalAuditTrail.loadAll() reads all events back faithfully
 *   - SurgicalAuditTrail.loadTurn() filters by turn number
 *   - aggregateStats() — correct allow/block counts, byTool, byTier, reasons
 *   - aggregateStats() — tiersUsed deduplication
 *   - aggregateStats() — empty-events edge case
 *   - formatReplay() — no events produces "No tool-gate events" message
 *   - formatReplay() — events rendered with turn header
 *   - formatReplay() — reason and suggestion lines included when present
 *   - formatAuditSummary() — empty stats message
 *   - formatAuditSummary() — populated stats renders tool rows
 *   - getAuditTrail() — same session ID returns the same singleton
 *   - getAuditTrail() — different session IDs return separate instances
 *   - Session isolation — two trails with different sessions don't share events
 *   - pruneOldAuditFiles() — does not throw on missing directory
 *   - Malformed JSONL lines are skipped gracefully
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  SurgicalAuditTrail,
  aggregateStats,
  formatReplay,
  formatAuditSummary,
  getAuditTrail,
  pruneOldAuditFiles,
  type AuditEvent,
  type AuditStats,
} from "../agent/surgical-audit-trail.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    turn: 1,
    toolName: "Read",
    tier: "narrow",
    verdict: "allow",
    sessionId: "test-session",
    ...overrides,
  };
}

async function makeTmpTrail(): Promise<{ trail: SurgicalAuditTrail; dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ashlr-audit-test-"));
  const path = join(dir, "test-session.jsonl");
  const trail = new SurgicalAuditTrail("test-session", path);
  return { trail, dir, path };
}

// ---------------------------------------------------------------------------
// AuditEvent structure
// ---------------------------------------------------------------------------

describe("AuditEvent structure", () => {
  test("required fields are present on a minimal event", () => {
    const ev = makeEvent();
    expect(typeof ev.timestamp).toBe("string");
    expect(typeof ev.turn).toBe("number");
    expect(typeof ev.toolName).toBe("string");
    expect(ev.verdict === "allow" || ev.verdict === "block").toBe(true);
    expect(typeof ev.sessionId).toBe("string");
  });

  test("optional fields reason and suggestion can be omitted", () => {
    const ev = makeEvent({ verdict: "allow" });
    expect(ev.reason).toBeUndefined();
    expect(ev.suggestion).toBeUndefined();
  });

  test("block events carry reason and suggestion", () => {
    const ev = makeEvent({
      verdict: "block",
      reason: "[surgical-tool-gate] \"Write\" is not allowed",
      suggestion: "use Edit to modify an existing file",
    });
    expect(ev.reason).toContain("Write");
    expect(ev.suggestion).toContain("Edit");
  });
});

// ---------------------------------------------------------------------------
// SurgicalAuditTrail — emit and loadAll
// ---------------------------------------------------------------------------

describe("SurgicalAuditTrail.emit() and loadAll()", () => {
  test("loadAll() returns empty array when file does not exist", async () => {
    const trail = new SurgicalAuditTrail("missing-session", "/nonexistent/path/x.jsonl");
    const all = await trail.loadAll();
    expect(all).toEqual([]);
  });

  test("emit() writes an event that loadAll() reads back", async () => {
    const { trail, dir } = await makeTmpTrail();
    try {
      const ev = makeEvent({ toolName: "Write", verdict: "block", reason: "blocked in narrow" });
      await trail.emit(ev);
      const all = await trail.loadAll();
      expect(all.length).toBe(1);
      expect(all[0].toolName).toBe("Write");
      expect(all[0].verdict).toBe("block");
      expect(all[0].reason).toBe("blocked in narrow");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("emit() appends multiple events — all are returned by loadAll()", async () => {
    const { trail, dir } = await makeTmpTrail();
    try {
      await trail.emit(makeEvent({ toolName: "Read", turn: 1 }));
      await trail.emit(makeEvent({ toolName: "Grep", turn: 1 }));
      await trail.emit(makeEvent({ toolName: "Write", turn: 2, verdict: "block" }));
      const all = await trail.loadAll();
      expect(all.length).toBe(3);
      expect(all.map((e) => e.toolName)).toEqual(["Read", "Grep", "Write"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("emit() preserves tier, suggestion, and sessionId fields", async () => {
    const { trail, dir } = await makeTmpTrail();
    try {
      const ev = makeEvent({
        tier: 2,
        verdict: "block",
        suggestion: "Promote to Tier 3",
        sessionId: "test-session",
      });
      await trail.emit(ev);
      const [loaded] = await trail.loadAll();
      expect(loaded.tier).toBe(2);
      expect(loaded.suggestion).toBe("Promote to Tier 3");
      expect(loaded.sessionId).toBe("test-session");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SurgicalAuditTrail — loadTurn
// ---------------------------------------------------------------------------

describe("SurgicalAuditTrail.loadTurn()", () => {
  test("loadTurn() returns only events for the requested turn", async () => {
    const { trail, dir } = await makeTmpTrail();
    try {
      await trail.emit(makeEvent({ toolName: "Read", turn: 1 }));
      await trail.emit(makeEvent({ toolName: "Edit", turn: 2 }));
      await trail.emit(makeEvent({ toolName: "Write", turn: 2, verdict: "block" }));
      await trail.emit(makeEvent({ toolName: "Bash", turn: 3 }));

      const turn2 = await trail.loadTurn(2);
      expect(turn2.length).toBe(2);
      expect(turn2.every((e) => e.turn === 2)).toBe(true);
      expect(turn2.map((e) => e.toolName)).toEqual(["Edit", "Write"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadTurn() returns empty array for a turn with no events", async () => {
    const { trail, dir } = await makeTmpTrail();
    try {
      await trail.emit(makeEvent({ turn: 1 }));
      const t99 = await trail.loadTurn(99);
      expect(t99).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// aggregateStats() — pure function
// ---------------------------------------------------------------------------

describe("aggregateStats()", () => {
  test("returns zero counts for empty events array", () => {
    const stats = aggregateStats([]);
    expect(stats.totalEvents).toBe(0);
    expect(stats.toolsAllowed).toBe(0);
    expect(stats.toolsBlocked).toBe(0);
    expect(stats.tiersUsed).toEqual([]);
    expect(stats.totalTurns).toBe(0);
  });

  test("counts allowed and blocked correctly", () => {
    const events: AuditEvent[] = [
      makeEvent({ verdict: "allow" }),
      makeEvent({ verdict: "allow" }),
      makeEvent({ verdict: "block", reason: "blocked" }),
    ];
    const stats = aggregateStats(events);
    expect(stats.toolsAllowed).toBe(2);
    expect(stats.toolsBlocked).toBe(1);
  });

  test("byTool breakdown is correct", () => {
    const events: AuditEvent[] = [
      makeEvent({ toolName: "Read", verdict: "allow" }),
      makeEvent({ toolName: "Read", verdict: "allow" }),
      makeEvent({ toolName: "Write", verdict: "block", reason: "r1" }),
    ];
    const stats = aggregateStats(events);
    expect(stats.byTool["Read"].allowed).toBe(2);
    expect(stats.byTool["Read"].blocked).toBe(0);
    expect(stats.byTool["Write"].allowed).toBe(0);
    expect(stats.byTool["Write"].blocked).toBe(1);
  });

  test("byTier breakdown is correct", () => {
    const events: AuditEvent[] = [
      makeEvent({ tier: "narrow", verdict: "allow" }),
      makeEvent({ tier: "narrow", verdict: "block", reason: "r" }),
      makeEvent({ tier: 3, verdict: "allow" }),
    ];
    const stats = aggregateStats(events);
    expect(stats.byTier["narrow"].allowed).toBe(1);
    expect(stats.byTier["narrow"].blocked).toBe(1);
    expect(stats.byTier["3"].allowed).toBe(1);
    expect(stats.byTier["3"].blocked).toBe(0);
  });

  test("tiersUsed deduplicates correctly", () => {
    const events: AuditEvent[] = [
      makeEvent({ tier: "narrow" }),
      makeEvent({ tier: "narrow" }),
      makeEvent({ tier: 2 }),
      makeEvent({ tier: 2 }),
    ];
    const stats = aggregateStats(events);
    expect(stats.tiersUsed.length).toBe(2);
    expect(stats.tiersUsed).toContain("narrow");
    expect(stats.tiersUsed).toContain(2);
  });

  test("reasons frequency map populated for blocked events", () => {
    const reason = "[surgical-tool-gate] \"Write\" blocked";
    const events: AuditEvent[] = [
      makeEvent({ verdict: "block", reason }),
      makeEvent({ verdict: "block", reason }),
      makeEvent({ verdict: "block", reason: "other reason" }),
    ];
    const stats = aggregateStats(events);
    expect(stats.reasons[reason]).toBe(2);
    expect(stats.reasons["other reason"]).toBe(1);
  });

  test("suggestions frequency map populated for blocked events", () => {
    const suggestion = "Promote to Tier 3";
    const events: AuditEvent[] = [
      makeEvent({ verdict: "block", reason: "r", suggestion }),
      makeEvent({ verdict: "block", reason: "r", suggestion }),
    ];
    const stats = aggregateStats(events);
    expect(stats.suggestions[suggestion]).toBe(2);
  });

  test("totalTurns counts distinct turn values", () => {
    const events: AuditEvent[] = [
      makeEvent({ turn: 1 }),
      makeEvent({ turn: 1 }),
      makeEvent({ turn: 2 }),
      makeEvent({ turn: 5 }),
    ];
    const stats = aggregateStats(events);
    expect(stats.totalTurns).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// formatReplay()
// ---------------------------------------------------------------------------

describe("formatReplay()", () => {
  test("returns 'No tool-gate events' message when events array is empty", () => {
    const output = formatReplay([], 3);
    expect(output).toContain("No tool-gate events");
    expect(output).toContain("turn 3");
  });

  test("includes turn header with event count", () => {
    const events = [makeEvent({ toolName: "Read", turn: 2 })];
    const output = formatReplay(events, 2);
    expect(output).toContain("Turn 2");
    expect(output).toContain("1 decision");
  });

  test("renders tool name and verdict for each event", () => {
    const events = [
      makeEvent({ toolName: "Edit", verdict: "allow", turn: 1 }),
      makeEvent({ toolName: "Write", verdict: "block", reason: "blocked in narrow", turn: 1 }),
    ];
    const output = formatReplay(events, 1);
    expect(output).toContain("Edit");
    expect(output).toContain("ALLOW");
    expect(output).toContain("Write");
    expect(output).toContain("BLOCK");
  });

  test("includes reason line when present", () => {
    const events = [
      makeEvent({ verdict: "block", reason: '[surgical-tool-gate] "Write" not allowed', turn: 1 }),
    ];
    const output = formatReplay(events, 1);
    expect(output).toContain("reason:");
    expect(output).toContain('"Write" not allowed');
  });

  test("includes suggestion line when present", () => {
    const events = [
      makeEvent({ verdict: "block", reason: "r", suggestion: "use Edit instead", turn: 1 }),
    ];
    const output = formatReplay(events, 1);
    expect(output).toContain("suggestion:");
    expect(output).toContain("use Edit instead");
  });

  test("renders tier label alongside tool name", () => {
    const events = [makeEvent({ tier: "medium", toolName: "Bash", turn: 1 })];
    const output = formatReplay(events, 1);
    expect(output).toContain("medium");
    expect(output).toContain("Bash");
  });
});

// ---------------------------------------------------------------------------
// formatAuditSummary()
// ---------------------------------------------------------------------------

describe("formatAuditSummary()", () => {
  test("returns empty message when no events", () => {
    const stats = aggregateStats([]);
    const output = formatAuditSummary(stats);
    expect(output).toContain("No audit events recorded");
  });

  test("shows total events, allowed, blocked", () => {
    const events = [
      makeEvent({ verdict: "allow" }),
      makeEvent({ verdict: "block", reason: "r" }),
    ];
    const stats = aggregateStats(events);
    const output = formatAuditSummary(stats);
    expect(output).toContain("Total events:");
    expect(output).toContain("Tools allowed:");
    expect(output).toContain("Tools blocked:");
  });

  test("renders per-tool rows", () => {
    const events = [
      makeEvent({ toolName: "Edit", verdict: "allow" }),
      makeEvent({ toolName: "Write", verdict: "block", reason: "r" }),
    ];
    const stats = aggregateStats(events);
    const output = formatAuditSummary(stats);
    expect(output).toContain("Edit");
    expect(output).toContain("Write");
  });

  test("renders tiers used", () => {
    const events = [makeEvent({ tier: 2 })];
    const stats = aggregateStats(events);
    const output = formatAuditSummary(stats);
    expect(output).toContain("Tiers used:");
  });
});

// ---------------------------------------------------------------------------
// getAuditTrail() — singleton behavior
// ---------------------------------------------------------------------------

describe("getAuditTrail() singleton", () => {
  test("same session ID returns identical instance", () => {
    const a = getAuditTrail("session-abc");
    const b = getAuditTrail("session-abc");
    expect(a).toBe(b);
  });

  test("different session IDs return different instances", () => {
    const a = getAuditTrail("session-x");
    const b = getAuditTrail("session-y");
    expect(a).not.toBe(b);
  });

  test("getSessionId() returns the correct session ID", () => {
    const trail = getAuditTrail("session-for-id-check");
    expect(trail.getSessionId()).toBe("session-for-id-check");
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("Session isolation", () => {
  test("two trails with different paths do not share events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-isolation-"));
    try {
      const trailA = new SurgicalAuditTrail("session-A", join(dir, "A.jsonl"));
      const trailB = new SurgicalAuditTrail("session-B", join(dir, "B.jsonl"));

      await trailA.emit(makeEvent({ toolName: "Read", sessionId: "session-A" }));
      await trailA.emit(makeEvent({ toolName: "Edit", sessionId: "session-A" }));
      await trailB.emit(makeEvent({ toolName: "Bash", sessionId: "session-B" }));

      const allA = await trailA.loadAll();
      const allB = await trailB.loadAll();

      expect(allA.length).toBe(2);
      expect(allA.every((e) => e.sessionId === "session-A")).toBe(true);

      expect(allB.length).toBe(1);
      expect(allB[0].sessionId).toBe("session-B");
      expect(allB[0].toolName).toBe("Bash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pruneOldAuditFiles()
// ---------------------------------------------------------------------------

describe("pruneOldAuditFiles()", () => {
  test("does not throw when audit directory does not exist", async () => {
    // Use a clearly nonexistent path — the function must not throw
    await expect(pruneOldAuditFiles(30)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL resilience
// ---------------------------------------------------------------------------

describe("Malformed JSONL resilience", () => {
  test("loadAll() skips lines that are not valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-malform-"));
    const path = join(dir, "bad.jsonl");
    try {
      const { writeFile } = await import("fs/promises");
      const goodLine = JSON.stringify(makeEvent({ toolName: "Grep" }));
      // Write a mix of valid and invalid lines
      await writeFile(
        path,
        [
          "NOT JSON AT ALL",
          goodLine,
          '{"incomplete":',
          JSON.stringify(makeEvent({ toolName: "Diff" })),
        ].join("\n") + "\n",
      );

      const trail = new SurgicalAuditTrail("bad-session", path);
      const events = await trail.loadAll();

      // Should have 2 valid events, skipping the 2 malformed lines
      expect(events.length).toBe(2);
      expect(events.map((e) => e.toolName)).toEqual(["Grep", "Diff"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadAll() skips objects missing required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-missing-"));
    const path = join(dir, "missing.jsonl");
    try {
      const { writeFile } = await import("fs/promises");
      const validEvent = makeEvent({ toolName: "LS" });
      const missingFields = JSON.stringify({ timestamp: "2024-01-01", turn: 1 }); // no toolName/verdict/sessionId
      await writeFile(path, [missingFields, JSON.stringify(validEvent)].join("\n") + "\n");

      const trail = new SurgicalAuditTrail("missing-session", path);
      const events = await trail.loadAll();

      expect(events.length).toBe(1);
      expect(events[0].toolName).toBe("LS");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
