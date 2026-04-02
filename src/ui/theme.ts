/**
 * Premium color theme for AshlrCode CLI.
 *
 * Vibrant, warm palette with high contrast and visual hierarchy.
 * Inspired by modern terminal apps (Warp, Fig, Ghostty).
 */

import chalk from "chalk";

export const theme = {
  // ── Brand accent (vibrant cyan-blue gradient) ──
  accent: chalk.hex("#38BDF8"),       // sky-400 — bright, inviting
  accentBold: chalk.hex("#38BDF8").bold,
  accentDim: chalk.hex("#0EA5E9"),    // sky-500

  // ── Success (emerald green) ──
  success: chalk.hex("#34D399"),      // emerald-400
  successDim: chalk.hex("#059669"),

  // ── Warning (amber) ──
  warning: chalk.hex("#FBBF24"),      // amber-400
  warningDim: chalk.hex("#D97706"),

  // ── Error (rose) ──
  error: chalk.hex("#FB7185"),        // rose-400
  errorDim: chalk.hex("#E11D48"),

  // ── Info (violet) ──
  info: chalk.hex("#A78BFA"),         // violet-400
  infoDim: chalk.hex("#7C3AED"),

  // ── Plan mode (fuchsia) ──
  plan: chalk.hex("#E879F9"),         // fuchsia-400
  planDim: chalk.hex("#C026D3"),

  // ── Text hierarchy ──
  primary: chalk.hex("#F1F5F9"),      // slate-100 — bright, readable
  secondary: chalk.hex("#94A3B8"),    // slate-400 — secondary info
  tertiary: chalk.hex("#64748B"),     // slate-500 — de-emphasized
  muted: chalk.hex("#475569"),        // slate-600 — very dim
  ghost: chalk.hex("#334155"),        // slate-700 — barely visible

  // ── Semantic colors ──
  cost: chalk.hex("#FCD34D"),         // amber-300
  tokens: chalk.hex("#67E8F9"),       // cyan-300
  path: chalk.hex("#86EFAC"),         // green-300
  keyword: chalk.hex("#38BDF8"),      // sky-400 — code keywords
  string: chalk.hex("#34D399"),       // emerald-400 — strings
  comment: chalk.hex("#64748B"),      // slate-500

  // ── Tool display ──
  toolName: chalk.hex("#38BDF8").bold, // sky-400 bold
  toolIcon: chalk.hex("#67E8F9"),      // cyan-300
  toolResult: chalk.hex("#CBD5E1"),    // slate-300

  // ── Separators & borders ──
  border: chalk.hex("#334155"),        // slate-700
  borderBright: chalk.hex("#475569"),  // slate-600

  // ── Prompt (colored ❯ per mode) ──
  prompt: {
    normal: chalk.hex("#34D399")("❯ "),    // emerald
    plan: chalk.hex("#E879F9")("❯ "),      // fuchsia
    edits: chalk.hex("#FBBF24")("❯ "),     // amber
    yolo: chalk.hex("#FB7185")("❯ "),      // rose
  },
} as const;

// ── Helper formatters ──

export function stylePath(p: string): string {
  return theme.path(p);
}

export function styleCost(usd: number): string {
  return theme.cost(`$${usd < 0.01 ? usd.toFixed(6) : usd.toFixed(4)}`);
}

export function styleTokens(count: number): string {
  if (count >= 1_000_000) return theme.tokens(`${(count / 1_000_000).toFixed(1)}M`);
  if (count >= 1_000) return theme.tokens(`${(count / 1_000).toFixed(0)}K`);
  return theme.tokens(`${count}`);
}

/**
 * Style a label with a colored badge background.
 */
export function badge(text: string, color: "accent" | "success" | "warning" | "error" | "plan"): string {
  const colors: Record<string, [string, string]> = {
    accent: ["#0EA5E9", "#F1F5F9"],
    success: ["#059669", "#F1F5F9"],
    warning: ["#D97706", "#1C1917"],
    error: ["#E11D48", "#F1F5F9"],
    plan: ["#C026D3", "#F1F5F9"],
  };
  const [bg, fg] = colors[color] ?? ["#334155", "#F1F5F9"];
  return chalk.bgHex(bg!).hex(fg!).bold(` ${text} `);
}
