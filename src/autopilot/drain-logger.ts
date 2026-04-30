/**
 * Drain logger — TTY-aware live progress for `runUntilEmpty`.
 *
 * When stdout is a TTY, `progress()` writes a single carriage-return-refreshed
 * status line. Otherwise it emits plain log lines. `info`/`error` always write
 * their own lines (clearing any pending progress line first).
 */

export interface DrainProgressState {
  index: number;
  total: number;
  slug: string;
  phase: string;
  spentUsd: number;
  elapsedMs: number;
}

export interface DrainLogger {
  progress(state: DrainProgressState): void;
  info(line: string): void;
  error(line: string): void;
  close(): void;
}

export interface DrainLoggerOpts {
  /** Override TTY detection — tests pass `false` to force non-TTY mode. */
  tty?: boolean;
  /** Override stdout sink — tests pass a collector. */
  write?: (chunk: string) => void;
}

export function createDrainLogger(opts: DrainLoggerOpts = {}): DrainLogger {
  const isTTY = opts.tty ?? Boolean(process.stdout.isTTY);
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  let lastLineLen = 0;
  // Number of lines painted by the most-recent multi-line progress refresh.
  // Used in TTY mode when a phase string like "3/5 parallel" is detected so we
  // can clear the whole block on the next refresh.
  let lastBlockLines = 0;

  function clearLine(): void {
    if (isTTY && lastLineLen > 0) {
      write("\r" + " ".repeat(lastLineLen) + "\r");
      lastLineLen = 0;
    }
    if (isTTY && lastBlockLines > 0) {
      // Move up N lines and clear each — standard ANSI sequence.
      for (let i = 0; i < lastBlockLines; i++) {
        write("\x1b[1A\x1b[2K");
      }
      lastBlockLines = 0;
    }
  }

  function format(state: DrainProgressState): string {
    const elapsedS = (state.elapsedMs / 1000).toFixed(0);
    const spent = state.spentUsd.toFixed(2);
    return `[${state.index}/${state.total}] processing ${state.slug} — phase: ${state.phase} — spent: $${spent} — elapsed: ${elapsedS}s`;
  }

  return {
    progress(state) {
      // Multi-worker summaries arrive with slug=comma-separated and
      // phase="<N>/<M> parallel". Print them as a cleared block on TTY so
      // per-worker slugs stay visible without corrupting prior output.
      const parallel = /^\d+\/\d+ parallel$/.test(state.phase);
      if (parallel && isTTY) {
        clearLine();
        const slugs = state.slug.split(",").map((s) => s.trim()).filter(Boolean);
        const header = `[${state.index}/${state.total}] ${state.phase} — ${slugs.length} in flight`;
        write(header + "\n");
        for (const s of slugs) write(`  · ${s}\n`);
        lastBlockLines = 1 + slugs.length;
        return;
      }

      const line = format(state);
      if (isTTY) {
        clearLine();
        write("\r" + line);
        lastLineLen = line.length;
      } else {
        write(line + "\n");
      }
    },
    info(line) {
      clearLine();
      write(line + "\n");
    },
    error(line) {
      clearLine();
      write(line + "\n");
    },
    close() {
      if (isTTY && (lastLineLen > 0 || lastBlockLines > 0)) {
        clearLine();
      }
    },
  };
}
