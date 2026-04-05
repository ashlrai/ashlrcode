/**
 * Vision persistence — stores and manages a project's autonomous vision.
 *
 * Persists to `.ashlrcode/vision.md` in the project root as YAML frontmatter + markdown body.
 * No external YAML dependency — parses manually.
 */

import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { ProviderRouter } from "../providers/router.ts";

export interface VisionProgress {
  timestamp: string;
  summary: string;
  itemsCompleted: number;
  itemsFailed: number;
}

export interface Vision {
  goal: string;
  successCriteria: string[];
  focusAreas: string[];
  avoidAreas: string[];
  progress: VisionProgress[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

const VISION_DIR = ".ashlrcode";
const VISION_FILE = "vision.md";

function visionPath(cwd: string): string {
  return join(cwd, VISION_DIR, VISION_FILE);
}

// --- YAML frontmatter parsing (no library) ---

function parseFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1]!, body: match[2]!.trim() };
}

function parseYamlValue(raw: string): string {
  // Strip surrounding quotes and unescape
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseVisionFrontmatter(frontmatter: string): Omit<Vision, "notes"> {
  const lines = frontmatter.split("\n");

  let goal = "";
  let createdAt = "";
  let updatedAt = "";
  const successCriteria: string[] = [];
  const focusAreas: string[] = [];
  const avoidAreas: string[] = [];
  const progress: VisionProgress[] = [];

  let currentKey = "";
  let currentProgress: Partial<VisionProgress> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Top-level key: value
    const kvMatch = line.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const val = kvMatch[2]!;
      currentKey = key;
      currentProgress = null;

      switch (key) {
        case "goal": goal = parseYamlValue(val); break;
        case "createdAt": createdAt = parseYamlValue(val); break;
        case "updatedAt": updatedAt = parseYamlValue(val); break;
      }
      continue;
    }

    // Top-level key with no inline value (array or object start)
    const keyOnlyMatch = line.match(/^(\w+):$/);
    if (keyOnlyMatch) {
      // Flush any in-progress progress entry
      if (currentProgress && currentProgress.timestamp) {
        progress.push(currentProgress as VisionProgress);
      }
      currentKey = keyOnlyMatch[1]!;
      currentProgress = null;
      continue;
    }

    // Array item: "  - value" or "  - key: value" (for progress entries)
    const arrayMatch = line.match(/^  - (.+)$/);
    if (arrayMatch) {
      const itemContent = arrayMatch[1]!;

      if (currentKey === "progress") {
        // Flush previous progress entry
        if (currentProgress && currentProgress.timestamp) {
          progress.push(currentProgress as VisionProgress);
        }
        // Start new progress entry — first field is always timestamp
        const fieldMatch = itemContent.match(/^(\w+):\s*(.+)$/);
        if (fieldMatch) {
          currentProgress = {};
          applyProgressField(currentProgress, fieldMatch[1]!, fieldMatch[2]!);
        }
      } else {
        const value = parseYamlValue(itemContent);
        switch (currentKey) {
          case "successCriteria": successCriteria.push(value); break;
          case "focusAreas": focusAreas.push(value); break;
          case "avoidAreas": avoidAreas.push(value); break;
        }
      }
      continue;
    }

    // Continuation field in a progress entry: "    key: value"
    const nestedMatch = line.match(/^    (\w+):\s*(.+)$/);
    if (nestedMatch && currentProgress) {
      applyProgressField(currentProgress, nestedMatch[1]!, nestedMatch[2]!);
      continue;
    }
  }

  // Flush last progress entry
  if (currentProgress && currentProgress.timestamp) {
    progress.push(currentProgress as VisionProgress);
  }

  return {
    goal,
    successCriteria,
    focusAreas,
    avoidAreas,
    progress,
    createdAt,
    updatedAt,
  };
}

function applyProgressField(entry: Partial<VisionProgress>, key: string, rawVal: string): void {
  const val = parseYamlValue(rawVal);
  switch (key) {
    case "timestamp": entry.timestamp = val; break;
    case "summary": entry.summary = val; break;
    case "itemsCompleted": entry.itemsCompleted = parseInt(val, 10) || 0; break;
    case "itemsFailed": entry.itemsFailed = parseInt(val, 10) || 0; break;
  }
}

// --- YAML serialization ---

function serializeVision(vision: Vision): string {
  const lines: string[] = ["---"];

  lines.push(`goal: "${escapeYaml(vision.goal)}"`);
  lines.push(`createdAt: "${vision.createdAt}"`);
  lines.push(`updatedAt: "${vision.updatedAt}"`);

  lines.push("successCriteria:");
  for (const c of vision.successCriteria) {
    lines.push(`  - "${escapeYaml(c)}"`);
  }

  lines.push("focusAreas:");
  for (const f of vision.focusAreas) {
    lines.push(`  - "${escapeYaml(f)}"`);
  }

  lines.push("avoidAreas:");
  for (const a of vision.avoidAreas) {
    lines.push(`  - "${escapeYaml(a)}"`);
  }

  lines.push("progress:");
  for (const p of vision.progress) {
    lines.push(`  - timestamp: "${p.timestamp}"`);
    lines.push(`    summary: "${escapeYaml(p.summary)}"`);
    lines.push(`    itemsCompleted: ${p.itemsCompleted}`);
    lines.push(`    itemsFailed: ${p.itemsFailed}`);
  }

  lines.push("---");

  if (vision.notes) {
    lines.push(vision.notes);
  }

  return lines.join("\n") + "\n";
}

function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// --- Public API ---

/**
 * Load a project vision from `.ashlrcode/vision.md`.
 * Returns null if the file doesn't exist.
 */
export async function loadVision(cwd: string): Promise<Vision | null> {
  const path = visionPath(cwd);
  if (!existsSync(path)) return null;

  const content = await readFile(path, "utf-8");
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;

  const data = parseVisionFrontmatter(parsed.frontmatter);
  return { ...data, notes: parsed.body };
}

/**
 * Save a vision to `.ashlrcode/vision.md`.
 */
export async function saveVision(cwd: string, vision: Vision): Promise<void> {
  const dir = join(cwd, VISION_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = serializeVision(vision);
  await writeFile(visionPath(cwd), content, "utf-8");
}

/**
 * Create a new vision with the given goal.
 */
export async function createVision(cwd: string, goal: string): Promise<Vision> {
  const now = new Date().toISOString();
  const vision: Vision = {
    goal,
    successCriteria: [],
    focusAreas: [],
    avoidAreas: [],
    progress: [],
    notes: "",
    createdAt: now,
    updatedAt: now,
  };

  await saveVision(cwd, vision);
  return vision;
}

/**
 * Append a progress entry to the existing vision.
 */
export async function updateProgress(
  cwd: string,
  summary: string,
  completed: number,
  failed: number
): Promise<void> {
  const vision = await loadVision(cwd);
  if (!vision) {
    throw new Error("No vision found. Create one first with createVision().");
  }

  vision.progress.push({
    timestamp: new Date().toISOString(),
    summary,
    itemsCompleted: completed,
    itemsFailed: failed,
  });
  vision.updatedAt = new Date().toISOString();

  await saveVision(cwd, vision);
}

/**
 * Use the LLM to assess how close the project is to its vision.
 */
export async function assessVision(
  vision: Vision,
  router: ProviderRouter
): Promise<{ focusAreas: string[]; assessment: string; isComplete: boolean }> {
  const recentProgress = vision.progress.slice(-10);
  const progressText = recentProgress.length > 0
    ? recentProgress.map(p =>
        `[${p.timestamp}] ${p.summary} (${p.itemsCompleted} done, ${p.itemsFailed} failed)`
      ).join("\n")
    : "No progress recorded yet.";

  const prompt = `You are assessing a project's progress toward its vision.

**Goal:** ${vision.goal}

**Success Criteria:**
${vision.successCriteria.length > 0 ? vision.successCriteria.map(c => `- ${c}`).join("\n") : "- None defined yet"}

**Current Focus Areas:**
${vision.focusAreas.length > 0 ? vision.focusAreas.map(f => `- ${f}`).join("\n") : "- None defined yet"}

**Areas to Avoid:**
${vision.avoidAreas.length > 0 ? vision.avoidAreas.map(a => `- ${a}`).join("\n") : "- None defined"}

**Recent Progress:**
${progressText}

Answer in this exact JSON format (no markdown, no code fences):
{"focusAreas": ["area1", "area2"], "assessment": "1-3 sentence assessment", "isComplete": true/false}`;

  let response = "";
  const stream = router.stream({
    systemPrompt: "You are a project assessment assistant. Respond only with the requested JSON.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  for await (const event of stream) {
    if (event.type === "text_delta" && event.text) {
      response += event.text;
    }
  }

  // Parse JSON response
  try {
    const cleaned = response.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const result = JSON.parse(cleaned);
    return {
      focusAreas: Array.isArray(result.focusAreas) ? result.focusAreas : [],
      assessment: typeof result.assessment === "string" ? result.assessment : "Unable to assess.",
      isComplete: result.isComplete === true,
    };
  } catch {
    return {
      focusAreas: vision.focusAreas,
      assessment: response.trim() || "Unable to assess — no response from LLM.",
      isComplete: false,
    };
  }
}

/**
 * Format the vision status for display in the REPL.
 */
export function formatVisionStatus(vision: Vision): string {
  const lines: string[] = [];

  lines.push(`Vision: ${vision.goal}`);
  lines.push("");

  if (vision.successCriteria.length > 0) {
    lines.push("Success Criteria:");
    for (const c of vision.successCriteria) {
      lines.push(`  - ${c}`);
    }
    lines.push("");
  }

  if (vision.focusAreas.length > 0) {
    lines.push("Focus Areas:");
    for (const f of vision.focusAreas) {
      lines.push(`  - ${f}`);
    }
    lines.push("");
  }

  if (vision.avoidAreas.length > 0) {
    lines.push("Avoid:");
    for (const a of vision.avoidAreas) {
      lines.push(`  - ${a}`);
    }
    lines.push("");
  }

  if (vision.progress.length > 0) {
    const recent = vision.progress.slice(-5);
    lines.push(`Progress (${vision.progress.length} entries, last ${recent.length}):`);
    for (const p of recent) {
      const date = p.timestamp.split("T")[0];
      lines.push(`  [${date}] ${p.summary} (+${p.itemsCompleted}, -${p.itemsFailed})`);
    }
    lines.push("");
  }

  lines.push(`Created: ${vision.createdAt.split("T")[0]} | Updated: ${vision.updatedAt.split("T")[0]}`);

  return lines.join("\n");
}
