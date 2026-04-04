/**
 * Markdown-lite renderer — transforms streaming text with chalk formatting.
 *
 * Handles: **bold**, `inline code`, ```code blocks```, # headers, - lists
 * Works with streaming text (processes complete lines).
 */

import chalk from "chalk";

interface RenderState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockLines: string[];
  buffer: string;
}

const state: RenderState = {
  inCodeBlock: false,
  codeBlockLang: "",
  codeBlockLines: [],
  buffer: "",
};

/**
 * Process a text delta from the stream.
 * Buffers until complete lines, then renders with formatting.
 */
export function renderMarkdownDelta(delta: string): string {
  state.buffer += delta;

  // Only process complete lines (wait for \n)
  const lastNewline = state.buffer.lastIndexOf("\n");
  if (lastNewline === -1) {
    return ""; // Buffer until we have a complete line
  }

  // Process complete lines, keep remainder in buffer
  const complete = state.buffer.slice(0, lastNewline);
  state.buffer = state.buffer.slice(lastNewline + 1);

  const lines = complete.split("\n");
  const rendered = lines.map(renderLine).join("\n");

  return rendered + "\n";
}

/**
 * Flush any remaining buffered content.
 */
export function flushMarkdown(): string {
  if (state.buffer) {
    const result = renderLine(state.buffer);
    state.buffer = "";
    return result;
  }
  return "";
}

/**
 * Reset renderer state (call between turns).
 */
export function resetMarkdown(): void {
  state.inCodeBlock = false;
  state.codeBlockLang = "";
  state.codeBlockLines = [];
  state.buffer = "";
}

function renderLine(line: string): string {
  // Code block toggles
  if (line.trimStart().startsWith("```")) {
    if (state.inCodeBlock) {
      state.inCodeBlock = false;
      state.codeBlockLang = "";
      state.codeBlockLines = [];
      return chalk.dim("```");
    } else {
      state.inCodeBlock = true;
      state.codeBlockLang = line.trim().slice(3).trim();
      state.codeBlockLines = [];
      const langLabel = state.codeBlockLang
        ? chalk.dim(`\`\`\`${state.codeBlockLang}`)
        : chalk.dim("```");
      return langLabel;
    }
  }

  // Inside code block — syntax highlight
  if (state.inCodeBlock) {
    state.codeBlockLines.push(line);
    const lineNum = state.codeBlockLines.length;
    const highlighted = highlightCode(line, state.codeBlockLang);
    const numStr = chalk.hex("#616161")(`${String(lineNum).padStart(3)} │ `);
    return numStr + highlighted;
  }

  // Headers
  if (line.startsWith("### ")) {
    return chalk.bold(line.slice(4));
  }
  if (line.startsWith("## ")) {
    return chalk.bold.underline(line.slice(3));
  }
  if (line.startsWith("# ")) {
    return chalk.bold.underline(line.slice(2));
  }

  // Bullet lists
  if (line.match(/^\s*[-*]\s/)) {
    return line.replace(/^(\s*)([-*])(\s)/, "$1" + chalk.cyan("•") + "$3");
  }

  // Numbered lists
  if (line.match(/^\s*\d+\.\s/)) {
    return line.replace(/^(\s*)(\d+\.)(\s)/, "$1" + chalk.cyan("$2") + "$3");
  }

  // Inline formatting
  return renderInline(line);
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
 * Render a single line of markdown (headers, bold, code, lists).
 * Stateless — does not track code block state.
 */
export function renderMarkdownLine(line: string): string {
  // Headers
  if (line.startsWith("### ")) return chalk.bold(line.slice(4));
  if (line.startsWith("## ")) return chalk.bold.underline(line.slice(3));
  if (line.startsWith("# ")) return chalk.bold.underline(line.slice(2));
  // Bullet lists
  if (line.match(/^\s*[-*]\s/)) return line.replace(/^(\s*)([-*])(\s)/, "$1" + chalk.cyan("•") + "$3");
  // Numbered lists
  if (line.match(/^\s*\d+\.\s/)) return line.replace(/^(\s*)(\d+\.)(\s)/, "$1" + chalk.cyan("$2") + "$3");
  return renderInline(line);
}

function renderInline(text: string): string {
  // Bold: **text** — use replacer function so chalk wraps the captured group
  text = text.replace(/\*\*([^*]+)\*\*/g, (_match, g1) => chalk.bold(g1));

  // Inline code: `text`
  text = text.replace(/`([^`]+)`/g, (_match, g1) => chalk.cyan(`\`${g1}\``));

  return text;
}
