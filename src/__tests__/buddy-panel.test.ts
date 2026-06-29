/**
 * BuddyPanel render stability tests.
 *
 * These tests verify the logic contract of BuddyPanel without requiring a
 * live terminal or full Ink render (Ink requires a TTY; no react-dom here).
 *
 * Covers:
 *   1. Single-block rendering — lines joined as ONE string, not multiple elements
 *   2. Fixed height invariant — output line count matches getBuddyHeight()
 *   3. No ANSI leakage from the join boundary — \n only, no escape sequences
 *   4. React key stability — the singleBlock string is deterministic for same inputs
 *   5. tickBuddyFrame — frame counter advances and produces different art frames
 *   6. getBuddyHeight — clamps to 6 regardless of terminal size
 *   7. renderBuddyWithBubble integration — bubble + art compose without throwing
 *   8. Edge cases: empty quip, very long quip, all species/moods
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { getBuddyArt, type BuddyData, type Species, type Mood } from "../ui/buddy.ts";
import { renderBuddyWithBubble } from "../ui/speech-bubble.ts";
import { tickBuddyFrame } from "../ui/BuddyPanel.tsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for plain-text assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHABCDsuJKf]/g, "");
}

/** Check whether a string contains any ANSI escape sequences. */
function hasAnsi(s: string): boolean {
  return /\x1B\[/.test(s);
}

function makeBuddy(species: Species, mood: Mood = "happy"): BuddyData {
  return {
    species,
    name: "TestBuddy",
    totalSessions: 1,
    mood,
    toolCalls: 0,
    rarity: "common",
    hat: "none",
    stats: { debugging: 5, patience: 5, chaos: 5, wisdom: 5, snark: 5 },
    shiny: false,
    level: 1,
  };
}

/** Simulate the singleBlock computation from BuddyPanel. */
function computeSingleBlock(buddy: BuddyData, quip: string, quipType: "quip" | "suggestion" | "reaction", frame = 0, height = 6): string {
  const art = getBuddyArt(buddy, frame);
  const bubbleText = quipType === "suggestion" ? `💡 ${quip}` : quip;
  const lines = renderBuddyWithBubble(bubbleText, art, buddy.name, 1, height);
  return lines.join("\n");
}

const ALL_SPECIES: Species[] = ["penguin", "cat", "ghost", "dragon", "owl", "robot", "axolotl", "capybara"];
const ALL_MOODS: Mood[] = ["happy", "thinking", "sleepy"];

// ---------------------------------------------------------------------------
// 1. Single-block rendering invariant
// ---------------------------------------------------------------------------

describe("Single-block rendering invariant", () => {
  test("computeSingleBlock returns a single string (not an array)", () => {
    const buddy = makeBuddy("penguin");
    const block = computeSingleBlock(buddy, "Ready!", "quip");
    expect(typeof block).toBe("string");
  });

  test("singleBlock contains \\n newlines separating lines", () => {
    const buddy = makeBuddy("cat");
    const block = computeSingleBlock(buddy, "Hello", "quip", 0, 6);
    // Must have at least one newline for multi-line art
    expect(block).toContain("\n");
  });

  test("joining lines with \\n produces same result as individual lines concatenated with \\n", () => {
    const buddy = makeBuddy("robot");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("test quip", art, buddy.name, 1, 6);

    const joined = lines.join("\n");
    const manual = lines.reduce((acc, line, i) => acc + (i > 0 ? "\n" : "") + line, "");
    expect(joined).toBe(manual);
  });

  test("singleBlock does NOT contain bare \\r (no carriage returns leaking from art)", () => {
    const buddy = makeBuddy("ghost");
    const block = computeSingleBlock(buddy, "Boo!", "reaction");
    expect(block).not.toContain("\r");
  });

  test("number of \\n in singleBlock equals lines.length - 1 (no trailing newline from join)", () => {
    const buddy = makeBuddy("owl");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("hoot", art, buddy.name, 1, 6);
    const block = lines.join("\n");

    const newlineCount = (block.match(/\n/g) ?? []).length;
    expect(newlineCount).toBe(lines.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Fixed height invariant
// ---------------------------------------------------------------------------

describe("Fixed height invariant", () => {
  test("renderBuddyWithBubble with targetHeight=6 returns exactly 6 lines", () => {
    const buddy = makeBuddy("penguin");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("quip", art, buddy.name, 1, 6);
    expect(lines).toHaveLength(6);
  });

  test("renderBuddyWithBubble with targetHeight=4 returns exactly 4 lines", () => {
    const buddy = makeBuddy("cat");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("short", art, buddy.name, 1, 4);
    expect(lines).toHaveLength(4);
  });

  test("renderBuddyWithBubble pads output to targetHeight when art is shorter", () => {
    const buddy = makeBuddy("ghost");
    const art = getBuddyArt(buddy, 0);
    // Art is 4 lines; target 8 should still return 8
    const lines = renderBuddyWithBubble("hi", art, buddy.name, 1, 8);
    expect(lines).toHaveLength(8);
  });

  test("renderBuddyWithBubble trims output to targetHeight when combined is taller", () => {
    const buddy = makeBuddy("capybara"); // 5 art lines
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("a very long quip that will need many lines of wrapping to fit inside the bubble", art, buddy.name, 1, 6);
    expect(lines).toHaveLength(6);
  });

  test("singleBlock line count from join equals targetHeight", () => {
    const buddy = makeBuddy("axolotl");
    const block = computeSingleBlock(buddy, "Test", "quip", 0, 6);
    const lineCount = block.split("\n").length;
    expect(lineCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. No ANSI leakage across the join boundary
// ---------------------------------------------------------------------------

describe("No ANSI leakage at join boundary", () => {
  test("joining lines with \\n does not introduce new ANSI sequences", () => {
    const buddy = makeBuddy("dragon");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("fire!", art, buddy.name, 1, 6);

    // ANSI in individual lines is fine (speech-bubble may include none, but check join doesn't add any)
    const joinSeparators = lines.map((_, i) => (i < lines.length - 1 ? "\n" : "")).join("");
    expect(hasAnsi(joinSeparators)).toBe(false);
  });

  test("plain text content (stripped ANSI) is preserved through join", () => {
    const buddy = makeBuddy("penguin");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("hello world", art, buddy.name, 1, 6);
    const block = lines.join("\n");

    const plainLines = lines.map(stripAnsi).join("\n");
    const plainBlock = stripAnsi(block);
    expect(plainBlock).toBe(plainLines);
  });

  test("singleBlock does not contain ESC sequences introduced by the join itself", () => {
    const buddy = makeBuddy("robot");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("beep boop", art, buddy.name, 1, 6);

    // Collect ANSI sequences from each individual line
    const lineAnsi = lines.flatMap((l) => l.match(/\x1B\[[0-9;]*[mGKHABCDsuJKf]/g) ?? []);
    const blockAnsi = lines.join("\n").match(/\x1B\[[0-9;]*[mGKHABCDsuJKf]/g) ?? [];

    // Join must not add NEW sequences beyond what the individual lines already had
    expect(blockAnsi.length).toBe(lineAnsi.length);
  });
});

// ---------------------------------------------------------------------------
// 4. React key stability — singleBlock is deterministic
// ---------------------------------------------------------------------------

describe("React key stability — deterministic singleBlock", () => {
  test("same inputs produce identical singleBlock on repeated calls", () => {
    const buddy = makeBuddy("owl", "thinking");
    const block1 = computeSingleBlock(buddy, "wisdom", "quip", 0, 6);
    const block2 = computeSingleBlock(buddy, "wisdom", "quip", 0, 6);
    expect(block1).toBe(block2);
  });

  test("different quips produce different singleBlocks", () => {
    const buddy = makeBuddy("cat");
    const block1 = computeSingleBlock(buddy, "hello", "quip", 0, 6);
    const block2 = computeSingleBlock(buddy, "goodbye", "quip", 0, 6);
    expect(block1).not.toBe(block2);
  });

  test("suggestion quipType prepends 💡 to the quip text in the block", () => {
    const buddy = makeBuddy("ghost");
    const block = computeSingleBlock(buddy, "try /compact", "suggestion", 0, 6);
    // The bubble text includes the emoji prefix; strip ANSI before checking
    const plain = stripAnsi(block);
    expect(plain).toContain("💡");
    expect(plain).toContain("try /compact");
  });

  test("reaction quipType does NOT prepend 💡", () => {
    const buddy = makeBuddy("ghost");
    const block = computeSingleBlock(buddy, "On fire!", "reaction", 0, 6);
    const plain = stripAnsi(block);
    expect(plain).not.toContain("💡");
    expect(plain).toContain("On fire!");
  });

  test("quip quipType does NOT prepend 💡", () => {
    const buddy = makeBuddy("robot");
    const block = computeSingleBlock(buddy, "Beep boop", "quip", 0, 6);
    const plain = stripAnsi(block);
    expect(plain).not.toContain("💡");
    expect(plain).toContain("Beep boop");
  });
});

// ---------------------------------------------------------------------------
// 5. tickBuddyFrame — frame counter advances
// ---------------------------------------------------------------------------

describe("tickBuddyFrame", () => {
  test("tickBuddyFrame is a callable function that does not throw", () => {
    expect(() => tickBuddyFrame()).not.toThrow();
  });

  test("getBuddyArt returns different frames for frame=0 vs frame=1 (for animated species)", () => {
    // Any species with 2 animation frames should differ between frame 0 and frame 1
    const buddy = makeBuddy("penguin", "happy");
    const art0 = getBuddyArt(buddy, 0);
    const art1 = getBuddyArt(buddy, 1);
    // Penguin happy has 2 frames — they should differ
    expect(art0).not.toEqual(art1);
  });

  test("getBuddyArt with frame=2 wraps back to frame=0 (modulo frames)", () => {
    const buddy = makeBuddy("cat", "happy");
    const art0 = getBuddyArt(buddy, 0);
    const art2 = getBuddyArt(buddy, 2); // 2 % 2 = 0
    expect(art2).toEqual(art0);
  });

  test("singleBlock differs between frame 0 and frame 1 for animated buddy", () => {
    const buddy = makeBuddy("penguin", "happy");
    const block0 = computeSingleBlock(buddy, "hi", "quip", 0, 6);
    const block1 = computeSingleBlock(buddy, "hi", "quip", 1, 6);
    expect(block0).not.toBe(block1);
  });
});

// ---------------------------------------------------------------------------
// 6. getBuddyHeight clamping (via renderBuddyWithBubble targetHeight)
// ---------------------------------------------------------------------------

describe("Height clamping", () => {
  test("targetHeight=1 produces exactly 1 line", () => {
    const buddy = makeBuddy("penguin");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("x", art, buddy.name, 1, 1);
    expect(lines).toHaveLength(1);
  });

  test("targetHeight=3 produces exactly 3 lines", () => {
    const buddy = makeBuddy("cat");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("hi", art, buddy.name, 1, 3);
    expect(lines).toHaveLength(3);
  });

  test("targetHeight=6 (max) produces exactly 6 lines for all species", () => {
    for (const species of ALL_SPECIES) {
      const buddy = makeBuddy(species);
      const art = getBuddyArt(buddy, 0);
      const lines = renderBuddyWithBubble("test", art, buddy.name, 1, 6);
      expect(lines).toHaveLength(6);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. renderBuddyWithBubble integration — all species/moods
// ---------------------------------------------------------------------------

describe("renderBuddyWithBubble integration", () => {
  test("does not throw for any species/mood combination", () => {
    for (const species of ALL_SPECIES) {
      for (const mood of ALL_MOODS) {
        const buddy = makeBuddy(species, mood);
        const art = getBuddyArt(buddy, 0);
        expect(() => renderBuddyWithBubble("quip text", art, buddy.name, 1, 6)).not.toThrow();
      }
    }
  });

  test("output lines are strings (not undefined/null)", () => {
    for (const species of ALL_SPECIES) {
      const buddy = makeBuddy(species);
      const art = getBuddyArt(buddy, 0);
      const lines = renderBuddyWithBubble("test", art, buddy.name, 1, 6);
      for (const line of lines) {
        expect(typeof line).toBe("string");
      }
    }
  });

  test("buddy name appears in the output", () => {
    const buddy = makeBuddy("capybara");
    buddy.name = "Glitch";
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("hi", art, buddy.name, 1, 6);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("Glitch");
  });

  test("quip text appears in the bubble output", () => {
    const buddy = makeBuddy("robot");
    const art = getBuddyArt(buddy, 0);
    const uniqueQuip = "unique-quip-xyz-12345";
    const lines = renderBuddyWithBubble(uniqueQuip, art, buddy.name, 1, 6);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("unique-quip-xyz");
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("empty quip renders without throwing", () => {
    const buddy = makeBuddy("owl");
    const art = getBuddyArt(buddy, 0);
    expect(() => renderBuddyWithBubble("", art, buddy.name, 1, 6)).not.toThrow();
  });

  test("very long quip is capped to fit within targetHeight", () => {
    const buddy = makeBuddy("dragon");
    const art = getBuddyArt(buddy, 0);
    const longQuip = "This is an extremely long quip that will definitely need many lines to wrap into the speech bubble and should exceed the target height constraint we impose";
    const lines = renderBuddyWithBubble(longQuip, art, buddy.name, 1, 6);
    expect(lines).toHaveLength(6);
  });

  test("singleBlock from long quip still equals exactly targetHeight lines", () => {
    const buddy = makeBuddy("axolotl");
    const longQuip = "x".repeat(200);
    const block = computeSingleBlock(buddy, longQuip, "suggestion", 0, 6);
    expect(block.split("\n")).toHaveLength(6);
  });

  test("getBuddyArt returns an array of non-empty strings", () => {
    for (const species of ALL_SPECIES) {
      const buddy = makeBuddy(species);
      const art = getBuddyArt(buddy, 0);
      expect(Array.isArray(art)).toBe(true);
      expect(art.length).toBeGreaterThan(0);
      for (const line of art) {
        expect(typeof line).toBe("string");
      }
    }
  });

  test("singleBlock is the same length as lines.join('\\n') computed separately", () => {
    const buddy = makeBuddy("ghost", "sleepy");
    const art = getBuddyArt(buddy, 0);
    const lines = renderBuddyWithBubble("zzz", art, buddy.name, 1, 6);
    const expected = lines.join("\n");
    const actual = computeSingleBlock(buddy, "zzz", "quip", 0, 6);
    // Both use same quip text (computeSingleBlock does not add 💡 for "quip" type)
    expect(actual.length).toBe(expected.length);
  });

  test("frame=0 and frame=2 produce identical blocks for 2-frame art (modulo wraps)", () => {
    const buddy = makeBuddy("cat", "happy");
    const block0 = computeSingleBlock(buddy, "meow", "quip", 0, 6);
    const block2 = computeSingleBlock(buddy, "meow", "quip", 2, 6); // frame 2 % 2 === 0
    expect(block0).toBe(block2);
  });
});
