/**
 * Markdown-lite renderer — transforms streaming text with chalk formatting.
 *
 * Handles: **bold**, *italic*, ~~strikethrough~~, `inline code`, ```code blocks```,
 * # headers, - lists, > blockquotes, [links](url), --- horizontal rules, | tables |
 * Works with streaming text (processes complete lines).
 */

import chalk from "chalk";

interface RenderState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockLines: string[];
  buffer: string;
  tableRows: string[][];
  inTable: boolean;
}

function createState(): RenderState {
  return {
    inCodeBlock: false,
    codeBlockLang: "",
    codeBlockLines: [],
    buffer: "",
    tableRows: [],
    inTable: false,
  };
}

/**
 * Per-instance markdown renderer. Holds its own state so concurrent
 * sub-agents don't corrupt each other's code-block / buffer tracking.
 */
export class MarkdownRenderer {
  private state: RenderState = createState();

  /** Process a text delta from the stream. */
  renderDelta(delta: string): string {
    this.state.buffer += delta;

    const lastNewline = this.state.buffer.lastIndexOf("\n");
    if (lastNewline === -1) {
      return "";
    }

    const complete = this.state.buffer.slice(0, lastNewline);
    this.state.buffer = this.state.buffer.slice(lastNewline + 1);

    const lines = complete.split("\n");
    const renderedParts = lines.map((l) => this.renderLine(l)).filter((l) => l !== "");
    if (renderedParts.length === 0) return "";
    const rendered = renderedParts.join("\n");

    return rendered + "\n";
  }

  /** Flush any remaining buffered content. */
  flush(): string {
    let result = "";
    if (this.state.buffer) {
      result += this.renderLine(this.state.buffer);
      this.state.buffer = "";
    }
    // Flush any pending table
    result += this.flushTable();
    return result;
  }

  /** Reset renderer state (call between turns). */
  reset(): void {
    this.state = createState();
  }

  private renderLine(line: string): string {
    if (line.trimStart().startsWith("```")) {
      // Flush any pending table before entering code block
      const tablePre = this.flushTable();
      if (this.state.inCodeBlock) {
        this.state.inCodeBlock = false;
        this.state.codeBlockLang = "";
        this.state.codeBlockLines = [];
        // Bottom border
        return tablePre + chalk.dim("  └" + "─".repeat(59));
      } else {
        this.state.inCodeBlock = true;
        this.state.codeBlockLang = line.trim().slice(3).trim();
        this.state.codeBlockLines = [];
        // Top border with language label
        const langLabel = this.state.codeBlockLang
          ? ` ${this.state.codeBlockLang} `
          : "";
        const remaining = Math.max(0, 59 - langLabel.length - 1);
        return tablePre + chalk.dim("  ┌─") + (langLabel ? chalk.hex("#94A3B8")(langLabel) : "") + chalk.dim("─".repeat(remaining));
      }
    }

    if (this.state.inCodeBlock) {
      this.state.codeBlockLines.push(line);
      const lineNum = this.state.codeBlockLines.length;
      const highlighted = highlightCode(line, this.state.codeBlockLang);
      const numStr = chalk.hex("#616161")(`  │ ${String(lineNum).padStart(3)} │ `);
      return numStr + highlighted;
    }

    // Table detection: lines starting with | and containing at least one more |
    if (isTableRow(line)) {
      // Skip separator rows (e.g., |---|---|) but use them to confirm table
      if (isTableSeparator(line)) {
        this.state.inTable = true;
        return ""; // separator consumed, will be rendered as border
      }
      this.state.inTable = true;
      const cells = parseTableCells(line);
      this.state.tableRows.push(cells);
      return ""; // buffered, will be rendered when table ends
    }

    // If we were in a table and hit a non-table line, flush the table
    const tablePre = this.flushTable();
    return tablePre + renderMarkdownLine(line);
  }

  /** Flush buffered table rows and render as formatted table. */
  private flushTable(): string {
    if (this.state.tableRows.length === 0) {
      this.state.inTable = false;
      return "";
    }

    const rendered = renderTable(this.state.tableRows);
    this.state.tableRows = [];
    this.state.inTable = false;
    return rendered + "\n";
  }
}

/**
 * Create an isolated markdown renderer instance.
 * Use this for sub-agents so they don't share state with the main REPL.
 */
export function createMarkdownRenderer(): MarkdownRenderer {
  return new MarkdownRenderer();
}

// Default singleton instance for backward compatibility
const defaultRenderer = new MarkdownRenderer();

/**
 * Process a text delta from the stream.
 * Buffers until complete lines, then renders with formatting.
 */
export function renderMarkdownDelta(delta: string): string {
  return defaultRenderer.renderDelta(delta);
}

/**
 * Flush any remaining buffered content.
 */
export function flushMarkdown(): string {
  return defaultRenderer.flush();
}

/**
 * Reset renderer state (call between turns).
 */
export function resetMarkdown(): void {
  defaultRenderer.reset();
}

/**
 * Apply regex-based syntax highlighting to a code line.
 * Supports JS/TS, Python, Bash, Go, Rust, JSON, and diff.
 */
export function highlightCode(line: string, lang: string): string {
  // Diff highlighting — applied by lang or line prefix
  if (lang === "diff" || (lang === "" && /^[+\-@]/.test(line))) {
    if (line.startsWith("+")) return chalk.hex("#00E676")(line);
    if (line.startsWith("-")) return chalk.hex("#FF1744")(line);
    if (line.startsWith("@")) return chalk.hex("#82B1FF")(line);
    return chalk.dim(line);
  }

  // JSON — minimal highlighting (strings, numbers, booleans/null)
  if (lang === "json") {
    let result = line;
    // String values (keys and values)
    result = result.replace(/"(?:[^"\\]|\\.)*"/g, (m) => chalk.hex("#00E676")(m));
    // Numbers
    result = result.replace(/\b(\d+\.?\d*)\b/g, (m) => chalk.hex("#FFD54F")(m));
    // Booleans and null
    result = result.replace(/\b(true|false|null)\b/g, (m) => chalk.hex("#00E5FF")(m));
    return result;
  }

  // Use a token-based approach to avoid highlighting inside strings/comments
  const tokens: { start: number; end: number; styled: string }[] = [];

  // Collect string spans first (they take priority)
  const strings = /(["'`])(?:(?!\1|\\).|\\.)*\1/g;
  let match: RegExpExecArray | null;
  while ((match = strings.exec(line)) !== null) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      styled: chalk.hex("#00E676")(match[0]),
    });
  }

  // Collect comment spans
  const commentPattern =
    lang === "python" || lang === "bash" || lang === "sh"
      ? /#.*$/gm
      : /\/\/.*$/gm;
  while ((match = commentPattern.exec(line)) !== null) {
    // Only add if not overlapping with a string token
    const s = match.index;
    const e = match.index + match[0].length;
    if (!tokens.some((t) => s >= t.start && s < t.end)) {
      tokens.push({ start: s, end: e, styled: chalk.hex("#546E7A")(match[0]) });
    }
  }

  // Pick keyword set based on language
  let keywordPattern: RegExp | null = null;
  const jsLangs = ["typescript", "ts", "javascript", "js", "jsx", "tsx"];
  const pyLangs = ["python", "py"];
  const bashLangs = ["bash", "sh", "shell", "zsh"];
  const goLangs = ["go", "golang"];
  const rustLangs = ["rust", "rs"];

  if (jsLangs.includes(lang)) {
    keywordPattern =
      /\b(const|let|var|function|class|if|else|for|while|return|import|export|from|async|await|new|this|typeof|interface|type|enum|extends|implements|try|catch|throw|switch|case|default|break|continue|of|in|yield|void|delete|instanceof)\b/g;
  } else if (pyLangs.includes(lang)) {
    keywordPattern =
      /\b(def|class|if|elif|else|for|while|return|import|from|as|try|except|raise|with|yield|lambda|pass|break|continue|and|or|not|in|is|True|False|None|async|await)\b/g;
  } else if (bashLangs.includes(lang)) {
    keywordPattern =
      /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|local|export|source|echo|exit|in|select|until)\b/g;
  } else if (goLangs.includes(lang)) {
    keywordPattern =
      /\b(func|package|import|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|select|fallthrough)\b/g;
  } else if (rustLangs.includes(lang)) {
    keywordPattern =
      /\b(fn|let|mut|const|pub|mod|use|struct|enum|impl|trait|where|match|if|else|for|while|loop|return|break|continue|move|async|await|unsafe|extern|crate|self|super|type|as|in|ref|dyn)\b/g;
  }

  // Collect keyword spans
  if (keywordPattern) {
    while ((match = keywordPattern.exec(line)) !== null) {
      const s = match.index;
      const e = match.index + match[0].length;
      if (!tokens.some((t) => s >= t.start && s < t.end)) {
        tokens.push({
          start: s,
          end: e,
          styled: chalk.hex("#00E5FF")(match[0]),
        });
      }
    }
  }

  // Type/class names (PascalCase identifiers)
  const typePattern = /\b([A-Z][a-zA-Z0-9]*)\b/g;
  while ((match = typePattern.exec(line)) !== null) {
    const s = match.index;
    const e = match.index + match[0].length;
    if (!tokens.some((t) => s >= t.start && s < t.end)) {
      tokens.push({
        start: s,
        end: e,
        styled: chalk.hex("#E040FB")(match[0]),
      });
    }
  }

  // Numbers
  const numbers = /\b(\d+\.?\d*)\b/g;
  while ((match = numbers.exec(line)) !== null) {
    const s = match.index;
    const e = match.index + match[0].length;
    if (!tokens.some((t) => s >= t.start && s < t.end)) {
      tokens.push({
        start: s,
        end: e,
        styled: chalk.hex("#FFD54F")(match[0]),
      });
    }
  }

  // If no tokens matched, return line as-is
  if (tokens.length === 0) return line;

  // Sort tokens by start position and reconstruct the line
  tokens.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      result += line.slice(cursor, token.start);
    }
    result += token.styled;
    cursor = token.end;
  }
  if (cursor < line.length) {
    result += line.slice(cursor);
  }
  return result;
}

/**
 * Render a single line of markdown (headers, bold, code, lists, blockquotes, hr, tables).
 * Stateless — does not track code block state.
 */
export function renderMarkdownLine(line: string): string {
  // Horizontal rules: ---, ***, ___
  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return chalk.dim("─".repeat(40));
  // Headers
  if (line.startsWith("### ")) return chalk.bold(line.slice(4));
  if (line.startsWith("## ")) return chalk.bold.underline(line.slice(3));
  if (line.startsWith("# ")) return chalk.bold.underline(line.slice(2));
  // Blockquotes
  if (line.match(/^\s*>\s?/)) {
    const content = line.replace(/^\s*>\s?/, "");
    return chalk.dim("│ ") + chalk.italic(renderInline(content));
  }
  // Bullet lists
  if (line.match(/^\s*[-*]\s/)) return line.replace(/^(\s*)([-*])(\s)/, "$1" + chalk.cyan("•") + "$3");
  // Numbered lists
  if (line.match(/^\s*\d+\.\s/)) return line.replace(/^(\s*)(\d+\.)(\s)/, "$1" + chalk.cyan("$2") + "$3");
  return renderInline(line);
}

function renderInline(text: string): string {
  // Inline code: `text` — process first to protect code from other formatting
  text = text.replace(/`([^`]+)`/g, (_match, g1) => chalk.cyan(`\`${g1}\``));

  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) =>
    chalk.underline(linkText) + chalk.dim(` (${url})`));

  // Bold + italic: ***text*** or ___text___
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, (_match, g1) => chalk.bold.italic(g1));

  // Bold: **text** or __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, (_match, g1) => chalk.bold(g1));
  text = text.replace(/__([^_]+)__/g, (_match, g1) => chalk.bold(g1));

  // Italic: *text* or _text_ (but not inside words for underscore)
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, (_match, g1) => chalk.italic(g1));
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, (_match, g1) => chalk.italic(g1));

  // Strikethrough: ~~text~~
  text = text.replace(/~~([^~]+)~~/g, (_match, g1) => chalk.strikethrough(g1));

  return text;
}

// ── Table helpers ─────────────────────────────────────────────────────────

/** Check if a line looks like a pipe-delimited table row. */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.indexOf("|", 1) > 0;
}

/** Check if a line is a table separator (e.g., |---|---|). */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  // Must be a table row and contain only |, -, :, and spaces
  return isTableRow(trimmed) && /^[|\-:\s]+$/.test(trimmed);
}

/** Parse a pipe-delimited row into trimmed cell values. */
function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  // Remove leading and trailing pipes, then split on remaining pipes
  const inner = trimmed.slice(1, -1);
  return inner.split("|").map((cell) => cell.trim());
}

/** Measure visible string width (strips ANSI escape sequences). */
function visibleLength(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "").length;
}

/** Render a table from parsed rows with box-drawing borders. */
function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";

  // Determine column count from the widest row
  const colCount = Math.max(...rows.map((r) => r.length));

  // Normalize rows to have consistent column count
  const normalized = rows.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push("");
    return padded;
  });

  // Apply inline formatting to each cell
  const formatted = normalized.map((row) => row.map((cell) => renderInline(cell)));

  // Calculate column widths based on visible (non-ANSI) content
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = 0;
    for (const row of formatted) {
      const w = visibleLength(row[c]!);
      if (w > max) max = w;
    }
    colWidths.push(Math.max(max, 1));
  }

  // Build the table
  const lines: string[] = [];

  // Top border: ┌───┬───┐
  lines.push(
    chalk.dim("┌") +
      colWidths.map((w) => chalk.dim("─".repeat(w + 2))).join(chalk.dim("┬")) +
      chalk.dim("┐"),
  );

  for (let r = 0; r < formatted.length; r++) {
    const row = formatted[r]!;
    // Data row: │ cell │ cell │
    const cells = row.map((cell, c) => {
      const visible = visibleLength(cell);
      const pad = colWidths[c]! - visible;
      return " " + cell + " ".repeat(pad + 1);
    });
    lines.push(chalk.dim("│") + cells.join(chalk.dim("│")) + chalk.dim("│"));

    // After first row (header), add separator: ├───┼───┤
    if (r === 0 && formatted.length > 1) {
      lines.push(
        chalk.dim("├") +
          colWidths.map((w) => chalk.dim("─".repeat(w + 2))).join(chalk.dim("┼")) +
          chalk.dim("┤"),
      );
    }
  }

  // Bottom border: └───┴───┘
  lines.push(
    chalk.dim("└") +
      colWidths.map((w) => chalk.dim("─".repeat(w + 2))).join(chalk.dim("┴")) +
      chalk.dim("┘"),
  );

  return lines.join("\n");
}
