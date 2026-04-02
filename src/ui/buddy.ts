/**
 * Virtual pet buddy — a persistent companion that lives in your terminal.
 *
 * Species is deterministically chosen by hashing the user's home directory,
 * so you always get the same pet. The pet reacts to session activity with
 * a simple mood system.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { theme } from "./theme.ts";
import { getConfigDir } from "../config/settings.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Species =
  | "penguin"
  | "cat"
  | "ghost"
  | "dragon"
  | "owl"
  | "robot"
  | "axolotl"
  | "capybara";

export type Mood = "happy" | "thinking" | "sleepy";

export interface BuddyData {
  species: Species;
  name: string;
  totalSessions: number;
  mood: Mood;
  /** Cumulative successful tool calls across sessions. */
  toolCalls: number;
}

// ---------------------------------------------------------------------------
// ASCII art — 3-4 lines, ~12-15 chars wide
// ---------------------------------------------------------------------------

const ASCII_ART: Record<Species, string[]> = {
  penguin: [
    "  (·>·)  ",
    "  /| |\\  ",
    "  _/ \\_  ",
  ],
  cat: [
    " /\\_/\\  ",
    "( o.o ) ",
    " > ^ <  ",
  ],
  ghost: [
    "  .-.   ",
    " (o o)  ",
    " | O |  ",
    " '~~~'  ",
  ],
  dragon: [
    " /\\_/\\ ~",
    "( o.o )>",
    " |)_(|  ",
  ],
  owl: [
    " {o,o}  ",
    " /)  )  ",
    " \" \" \"  ",
  ],
  robot: [
    " [o_o]  ",
    " /|=|\\  ",
    "  d b   ",
  ],
  axolotl: [
    " \\(·u·)/ ",
    "  |   |  ",
    "  ~---~  ",
  ],
  capybara: [
    "  (•ᴗ•)  ",
    "  /|  |\\  ",
    "  ~~--~~  ",
  ],
};

// ---------------------------------------------------------------------------
// Name pool
// ---------------------------------------------------------------------------

const NAMES = [
  "Pixel", "Byte", "Chip", "Spark", "Nova", "Echo", "Zen", "Dot",
  "Flux", "Nyx", "Orbit", "Glitch", "Rune", "Wren", "Maple", "Qubit",
  "Fern", "Mochi", "Comet", "Nimbus", "Pebble", "Blink", "Cosmo", "Drift",
];

// ---------------------------------------------------------------------------
// Deterministic generation helpers
// ---------------------------------------------------------------------------

const SPECIES_LIST: Species[] = [
  "penguin", "cat", "ghost", "dragon", "owl", "robot", "axolotl", "capybara",
];

/**
 * Simple 32-bit hash of a string, used to deterministically pick species/name.
 */
function hashString(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  // Read first 4 bytes as unsigned 32-bit int
  return digest.readUInt32BE(0);
}

function pickSpecies(hash: number): Species {
  return SPECIES_LIST[hash % SPECIES_LIST.length]!;
}

function pickName(hash: number): string {
  // Use a different portion of the hash so name != species index
  const nameIndex = (hash >>> 8) % NAMES.length;
  return NAMES[nameIndex]!;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getBuddyPath(): string {
  return join(getConfigDir(), "buddy.json");
}

export async function loadBuddy(): Promise<BuddyData> {
  const path = getBuddyPath();

  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as BuddyData;
    } catch {
      // Corrupted file — regenerate below
    }
  }

  // First run: generate deterministically from home directory
  const hash = hashString(homedir());
  const buddy: BuddyData = {
    species: pickSpecies(hash),
    name: pickName(hash),
    totalSessions: 0,
    mood: "sleepy",
    toolCalls: 0,
  };

  await saveBuddy(buddy);
  return buddy;
}

export async function saveBuddy(buddy: BuddyData): Promise<void> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getBuddyPath(), JSON.stringify(buddy, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Print the buddy's ASCII art with its name and mood.
 * Designed to sit neatly under the startup banner.
 */
export function printBuddy(buddy: BuddyData): void {
  const art = ASCII_ART[buddy.species];
  if (!art) return;

  const moodEmoji = buddy.mood === "happy"
    ? theme.success("♥")
    : buddy.mood === "thinking"
      ? theme.warning("…")
      : theme.muted("z");

  // Print each art line in accent color
  for (const line of art) {
    console.log(`   ${theme.accentDim(line)}`);
  }

  // Name + mood on the line after art
  console.log(
    `   ${theme.accent(buddy.name)} ${moodEmoji}  ${theme.tertiary(`(${buddy.species})`)}`
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Mood tracking
// ---------------------------------------------------------------------------

/**
 * Simple in-memory mood tracker. Mutates the buddy object directly.
 * Call `saveBuddy()` when the session ends to persist final state.
 */
export function recordToolCallSuccess(buddy: BuddyData): void {
  buddy.toolCalls++;
  buddy.mood = "happy";
}

export function recordThinking(buddy: BuddyData): void {
  buddy.mood = "thinking";
}

export function recordIdle(buddy: BuddyData): void {
  buddy.mood = "sleepy";
}

/**
 * Bump session count and reset mood to sleepy for a fresh session.
 */
export async function startSession(buddy: BuddyData): Promise<void> {
  buddy.totalSessions++;
  buddy.mood = "sleepy";
  await saveBuddy(buddy);
}
