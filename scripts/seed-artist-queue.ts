#!/usr/bin/env bun
/**
 * Seed the autopilot work queue with artist-build tasks.
 *
 * Usage:
 *   bun run scripts/seed-artist-queue.ts                  # default roster
 *   bun run scripts/seed-artist-queue.ts drake weeknd     # explicit slugs
 *   bun run scripts/seed-artist-queue.ts --cwd /path/to/artist-encyclopedia-factory
 *
 * The queue is persisted under ~/.ashlrcode/autopilot/<project-hash>.json,
 * hashed from the cwd passed to WorkQueue. Default cwd is the sibling
 * ../artist-encyclopedia-factory so the queue lives alongside the factory
 * project, not ashlrcode itself.
 *
 * Dedup is handled by WorkQueue.addItems() — same (file, line, type) won't
 * be re-enqueued unless the previous item completed or was rejected.
 */

import { resolve } from "path";
import { WorkQueue } from "../src/autopilot/queue.ts";
import type { WorkItem } from "../src/autopilot/types.ts";

const DEFAULT_ROSTER = [
  "drake",
  "beatles",
  "rihanna",
  "weeknd",
  "kendrick",
  "sabrina-carpenter",
  "bad-bunny",
  "olivia-rodrigo",
  "tyler-the-creator",
  "billie-eilish",
];

function parseArgs(argv: string[]): { cwd: string; slugs: string[] } {
  let cwd = resolve(process.cwd(), "..", "artist-encyclopedia-factory");
  const slugs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cwd") {
      cwd = resolve(argv[++i] ?? cwd);
    } else if (a.startsWith("--cwd=")) {
      cwd = resolve(a.slice("--cwd=".length));
    } else if (!a.startsWith("--")) {
      slugs.push(a);
    }
  }

  return { cwd, slugs: slugs.length > 0 ? slugs : DEFAULT_ROSTER };
}

function buildItem(slug: string): WorkItem {
  return {
    id: `artist-build:${slug}`,
    type: "artist_build",
    priority: "high",
    title: `build-artist: ${slug}`,
    description:
      `Run the 6-phase artist encyclopedia factory for ${slug}. ` +
      `Dispatched via ashlrcode-config/coordinator/build-artist.json ` +
      `(see prompts/skills/build-artist.md). Bundle: artists/${slug}.json.`,
    // file/line are used for dedup; pin to the bundle path so re-seeding
    // the same roster is a no-op as long as the prior item is still open.
    file: `artists/${slug}.json`,
    line: 1,
    status: "discovered",
    discoveredAt: new Date().toISOString(),
    slug,
  };
}

async function main() {
  const { cwd, slugs } = parseArgs(process.argv.slice(2));

  console.log(`[seed-artist-queue] cwd=${cwd}`);
  console.log(`[seed-artist-queue] roster (${slugs.length}): ${slugs.join(", ")}`);

  const queue = new WorkQueue(cwd);
  await queue.load();

  const items = slugs.map(buildItem);
  const added = queue.addItems(items);
  await queue.save();

  const stats = queue.getStats();
  console.log(`[seed-artist-queue] added ${added} new items (${items.length - added} already queued)`);
  console.log(`[seed-artist-queue] queue stats:`, stats);
  console.log(`[seed-artist-queue] total items in queue: ${queue.length}`);
}

main().catch((err) => {
  console.error("[seed-artist-queue] failed:", err);
  process.exit(1);
});
