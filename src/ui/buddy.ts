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

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

const RARITY_TABLE: Record<Species, Rarity> = {
  penguin: "common",     // 60%
  cat: "common",
  ghost: "uncommon",     // 25%
  owl: "uncommon",
  robot: "rare",         // 10%
  dragon: "rare",
  axolotl: "epic",       // 4%
  capybara: "legendary", // 1%
};

export const RARITY_COLORS: Record<Rarity, string> = {
  common: "white",
  uncommon: "green",
  rare: "blue",
  epic: "magenta",
  legendary: "yellow",
};

export type Hat = "none" | "crown" | "tophat" | "propeller" | "halo" | "wizard" | "beanie";

const HAT_ART: Record<Hat, string> = {
  none: "",
  crown: "  👑  ",
  tophat: "  🎩  ",
  propeller: "  🧢  ",
  halo: "  ✨  ",
  wizard: "  🧙  ",
  beanie: "  🎿  ",
};

export interface BuddyStats {
  debugging: number;   // 1-10
  patience: number;
  chaos: number;
  wisdom: number;
  snark: number;
}

function generateStats(hash: number): BuddyStats {
  return {
    debugging: ((hash >>> 0) % 10) + 1,
    patience: ((hash >>> 4) % 10) + 1,
    chaos: ((hash >>> 8) % 10) + 1,
    wisdom: ((hash >>> 12) % 10) + 1,
    snark: ((hash >>> 16) % 10) + 1,
  };
}

function isShiny(hash: number): boolean {
  return (hash % 100) === 0; // 1% chance
}

export interface BuddyData {
  species: Species;
  name: string;
  totalSessions: number;
  mood: Mood;
  /** Cumulative successful tool calls across sessions. */
  toolCalls: number;
  rarity: Rarity;
  hat: Hat;
  stats: BuddyStats;
  shiny: boolean;
  /** Level based on totalSessions. */
  level: number;
}

// ---------------------------------------------------------------------------
// ASCII art — 3-4 lines, ~12-15 chars wide
// ---------------------------------------------------------------------------

// All art lines are padded to exactly 10 chars wide for alignment.
// 2 animation frames per mood, cycles every 1.5s.
const W = 10; // art width
function pad(lines: string[]): string[] {
  return lines.map(l => l.padEnd(W));
}

const ASCII_ART: Record<Species, Record<Mood, string[][]>> = {
  capybara: {
    happy: [
      pad(["  c\\  /c  ", " ( .  . ) ", " ( _nn_ ) ", " (______) ", "  ||  ||  "]),
      pad(["  c\\  /C  ", " (  . .)  ", " ( _nn_ ) ", " (______) ", "  || ||   "]),
    ],
    thinking: [
      pad(["  c\\  /c  ", " ( o  . ) ", " ( _nn_ ) ", " (__?___) ", "  ||  ||  "]),
      pad(["  c\\  /c  ", " ( .  o ) ", " ( _nn_ ) ", " (___?__) ", "  ||  ||  "]),
    ],
    sleepy: [
      pad(["  c\\  /c  ", " ( -  - ) ", " ( _nn_ )z", " (______) ", "  ||  ||  "]),
      pad(["  c\\  /c  ", " ( -  - ) ", " ( _nn_ ) ", " (______)z", "  ||  ||  "]),
    ],
  },
  penguin: {
    happy: [
      pad(["   .-.   ", "  (·>·)  ", "  /| |\\  ", "   \" \"   "]),
      pad(["   .-.   ", "  (·>·)/ ", "  /|  |  ", "   \" \"   "]),
    ],
    thinking: [
      pad(["   .-.   ", "  (·.·)  ", "  /| |\\  ", "   \" \"   "]),
      pad(["   .-. ? ", "  (·.·)  ", "  /| |\\  ", "   \" \"   "]),
    ],
    sleepy: [
      pad(["   .-.   ", "  (-.-) z", "  /| |\\  ", "   \" \"   "]),
      pad(["   .-. zZ", "  (-.-)  ", "  /| |\\  ", "   \" \"   "]),
    ],
  },
  cat: {
    happy: [
      pad(["  /\\_/\\  ", " ( ^.^ ) ", "  > ~ <  ", "         "]),
      pad(["  /\\_/\\  ", " ( ^.^ )/", "  >   <  ", "         "]),
    ],
    thinking: [
      pad(["  /\\_/\\  ", " ( o.o ) ", "  > . <  ", "         "]),
      pad(["  /\\_/\\ ?", " ( o.o ) ", "  > . <  ", "         "]),
    ],
    sleepy: [
      pad(["  /\\_/\\  ", " ( -.- ) ", "  > _ < z", "         "]),
      pad(["  /\\_/\\ z", " ( -.- )Z", "  > _ <  ", "         "]),
    ],
  },
  ghost: {
    happy: [
      pad(["   .-.   ", "  (^ ^)  ", "  | | |  ", "  '~~~'  "]),
      pad(["   .-.   ", "  (^ ^)/ ", "  |   |  ", "  '~~~'  "]),
    ],
    thinking: [
      pad(["   .-.   ", "  (o o)  ", "  | ? |  ", "  '~~~'  "]),
      pad(["   .-. ? ", "  (o o)  ", "  |   |  ", "  '~~~'  "]),
    ],
    sleepy: [
      pad(["   .-.   ", "  (- -)  ", "  | z |  ", "  '~~~'  "]),
      pad(["   .-. z ", "  (- -)Z ", "  |   |  ", "  '~~~'  "]),
    ],
  },
  dragon: {
    happy: [
      pad([" /\\_/\\ ~ ", " (^.^ )> ", "  |)_(|  ", "         "]),
      pad([" /\\_/\\~~ ", " (^.^ )>>", "  |)_(|  ", "         "]),
    ],
    thinking: [
      pad([" /\\_/\\   ", " (o.o )  ", "  |)_(|  ", "         "]),
      pad([" /\\_/\\ ? ", " (o.o )  ", "  |)_(|  ", "         "]),
    ],
    sleepy: [
      pad([" /\\_/\\   ", " (-.- ) z", "  |)_(|  ", "         "]),
      pad([" /\\_/\\ zZ", " (-.- )  ", "  |)_(|  ", "         "]),
    ],
  },
  owl: {
    happy: [
      pad(["  (\\,/)  ", "  {^,^}  ", "  /| |\\  ", "         "]),
      pad(["  (\\,/)  ", "  {^,^}/ ", "  /|  |  ", "         "]),
    ],
    thinking: [
      pad(["  (\\,/)  ", "  {o,o}  ", "  /| |\\  ", "         "]),
      pad(["  (\\,/) ?", "  {o,o}  ", "  /| |\\  ", "         "]),
    ],
    sleepy: [
      pad(["  (\\,/)  ", "  {-,-} z", "  /| |\\  ", "         "]),
      pad(["  (\\,/) z", "  {-,-}Z ", "  /| |\\  ", "         "]),
    ],
  },
  robot: {
    happy: [
      pad(["  ┌───┐  ", "  [^_^]  ", "  /|=|\\  ", "   d b   "]),
      pad(["  ┌───┐  ", "  [^_^]/ ", "  /|=|   ", "   d b   "]),
    ],
    thinking: [
      pad(["  ┌───┐  ", "  [o_o]  ", "  /|=|\\  ", "   d b   "]),
      pad(["  ┌───┐ ?", "  [o_o]  ", "  /|=|\\  ", "   d b   "]),
    ],
    sleepy: [
      pad(["  ┌───┐  ", "  [-_-] z", "  /|=|\\  ", "   d b   "]),
      pad(["  ┌───┐ z", "  [-_-]Z ", "  /|=|\\  ", "   d b   "]),
    ],
  },
  axolotl: {
    happy: [
      pad([" \\(^u^)/ ", "  | _ |  ", "  ~---~  ", "         "]),
      pad([" \\(^u^)~ ", "  | _ |  ", "  ~---~  ", "         "]),
    ],
    thinking: [
      pad([" \\(·u·)  ", "  | _ | ?", "  ~---~  ", "         "]),
      pad([" \\(·u·)? ", "  | _ |  ", "  ~---~  ", "         "]),
    ],
    sleepy: [
      pad([" \\(-u-)  ", "  | _ | z", "  ~---~  ", "         "]),
      pad([" \\(-u-) z", "  | _ |Z ", "  ~---~  ", "         "]),
    ],
  },
};

// Animation frame counter — started/stopped explicitly to avoid leaked handles
let animFrame = 0;
let animInterval: ReturnType<typeof setInterval> | null = null;

export function startBuddyAnimation(): void {
  if (animInterval) return;
  animInterval = setInterval(() => { animFrame++; }, 1500);
}

export function stopBuddyAnimation(): void {
  if (animInterval) {
    clearInterval(animInterval);
    animInterval = null;
  }
}

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

  const hash = hashString(homedir());

  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf-8");
      const buddy = JSON.parse(raw) as BuddyData;

      // Backfill new fields for buddies saved before the evolution update
      if (!buddy.rarity) buddy.rarity = RARITY_TABLE[buddy.species] ?? "common";
      if (!buddy.hat) buddy.hat = "none";
      if (!buddy.stats) buddy.stats = generateStats(hash);
      if (buddy.shiny === undefined) buddy.shiny = isShiny(hash);
      if (!buddy.level) buddy.level = Math.floor(buddy.totalSessions / 5) + 1;

      return buddy;
    } catch {
      // Corrupted file — regenerate below
    }
  }

  // First run: generate deterministically from home directory
  const buddy: BuddyData = {
    species: pickSpecies(hash),
    name: pickName(hash),
    totalSessions: 0,
    mood: "sleepy",
    toolCalls: 0,
    rarity: RARITY_TABLE[pickSpecies(hash)] ?? "common",
    hat: "none",
    stats: generateStats(hash),
    shiny: isShiny(hash),
    level: 1,
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
 * Get the buddy's ASCII art lines for current mood + animation frame.
 */
export function getBuddyArt(buddy: BuddyData, frame?: number): string[] {
  const moodArt = ASCII_ART[buddy.species]?.[buddy.mood];
  if (!moodArt) return pad(["  (?)     "]);
  const frameIndex = (frame ?? animFrame) % moodArt.length;
  const artLines = [...moodArt[frameIndex]!];

  // Prepend hat art if the buddy has one equipped
  const hat = HAT_ART[buddy.hat];
  if (hat) {
    artLines.unshift(hat.padEnd(W));
  }

  return artLines;
}

/**
 * Print the buddy's ASCII art with its name and mood.
 * Designed to sit neatly under the startup banner.
 */
export function printBuddy(buddy: BuddyData): void {
  const art = getBuddyArt(buddy);

  const moodEmoji = buddy.mood === "happy"
    ? theme.success("♥")
    : buddy.mood === "thinking"
      ? theme.warning("…")
      : theme.muted("z");

  // Print each art line in accent color
  for (const line of art) {
    console.log(`   ${theme.accentDim(line)}`);
  }

  // Name + mood + rarity on the line after art
  const shinyTag = buddy.shiny ? " ✨" : "";
  const rarityTag = buddy.rarity !== "common" ? ` [${buddy.rarity.toUpperCase()}]` : "";
  console.log(
    `   ${theme.accent(buddy.name)} ${moodEmoji}  ${theme.tertiary(`(${buddy.species}${rarityTag})${shinyTag}`)} ${theme.tertiary(`Lv.${buddy.level}`)}`
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
let consecutiveSuccesses = 0;
let totalToolCallsThisSession = 0;

export function recordToolCallSuccess(buddy: BuddyData): void {
  buddy.toolCalls++;
  buddy.mood = "happy";
  consecutiveSuccesses++;
  totalToolCallsThisSession++;
}

export function recordThinking(buddy: BuddyData): void {
  buddy.mood = "thinking";
}

export function recordError(buddy: BuddyData): void {
  buddy.mood = "sleepy";
  consecutiveSuccesses = 0;
}

export function recordIdle(buddy: BuddyData): void {
  buddy.mood = "sleepy";
}

// ---------------------------------------------------------------------------
// Speech bubbles — small reactions to major events
// ---------------------------------------------------------------------------

type BuddyEvent = "first_tool" | "success" | "error" | "streak" | "compact" | "exit" | "mode_switch";

const REACTIONS: Record<BuddyEvent, string[]> = {
  first_tool: ["Let's go!", "Here we go!", "Time to code!", "On it!"],
  success: ["Nice!", "Got it!", "Done!", "Easy!"],
  error: ["Oops...", "Hmm...", "Let me think...", "We'll fix it!"],
  streak: ["On fire!", "Unstoppable!", "Crushing it!", "Flow state!"],
  compact: ["Getting cozy...", "Tidying up!", "Making room!", "Spring cleaning!"],
  exit: ["See you!", "Bye for now!", "Until next time!", "Sweet dreams!"],
  mode_switch: ["Switching gears!", "New vibes!", "Mode changed!", "Let's try this!"],
};

/**
 * Get a buddy reaction for an event. Returns a formatted speech bubble.
 */
export function getBuddyReaction(buddy: BuddyData, event: BuddyEvent): string {
  // Streak detection
  if (event === "success" && consecutiveSuccesses >= 5) {
    event = "streak";
  }

  const phrases = REACTIONS[event];
  if (!phrases) return "";
  const phrase = phrases[Math.floor(Math.random() * phrases.length)]!;

  const moodIcon = buddy.mood === "happy" ? "♥" : buddy.mood === "thinking" ? "…" : "z";
  return theme.accentDim(`  ${buddy.name} ${moodIcon} "${phrase}"`);
}

/**
 * Check if this is the first tool call of the session.
 */
export function isFirstToolCall(): boolean {
  return totalToolCallsThisSession === 0; // Called in onToolStart, before recordToolCallSuccess increments
}

/**
 * Bump session count. Don't reset mood — let it carry from last session.
 */
export async function startSession(buddy: BuddyData): Promise<void> {
  buddy.totalSessions++;
  buddy.level = Math.floor(buddy.totalSessions / 5) + 1;
  consecutiveSuccesses = 0;
  totalToolCallsThisSession = 0;
  await saveBuddy(buddy);
}
