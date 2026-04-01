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
  buffer: string;
}

const state: RenderState = {
  inCodeBlock: false,
  codeBlockLang: "",
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
  state.buffer = "";
}

function renderLine(line: string): string {
  // Code block toggles
  if (line.trimStart().startsWith("```")) {
    if (state.inCodeBlock) {
      state.inCodeBlock = false;
      state.codeBlockLang = "";
      return chalk.dim("```");
    } else {
      state.inCodeBlock = true;
      state.codeBlockLang = line.trim().slice(3).trim();
      const langLabel = state.codeBlockLang
        ? chalk.dim(`\`\`\`${state.codeBlockLang}`)
        : chalk.dim("```");
      return langLabel;
    }
  }

  // Inside code block — dim it slightly
  if (state.inCodeBlock) {
    return chalk.dim("  ") + line;
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

function renderInline(text: string): string {
  // Bold: **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"));

  // Inline code: `text`
  text = text.replace(/`([^`]+)`/g, chalk.cyan("`$1`"));

  return text;
}
