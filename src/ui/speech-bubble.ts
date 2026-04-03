/**
 * ASCII speech bubble renderer.
 * Creates a speech bubble to the left with a tail pointing at the buddy.
 */

/**
 * Wrap text into lines of max width.
 */
function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Render a speech bubble + buddy art side by side.
 *
 * Output:
 * ```
 *  .------------------------.
 *  | ship it, no tests      |   .---.
 *  | needed                 |  (•ᴗ•)>
 *  '--------.               '  /| |\
 *            \                  " " "
 *             `--              Glitch
 * ```
 */
export function renderBuddyWithBubble(
  quip: string,
  buddyArt: string[],
  buddyName: string,
  gap: number = 3,
  targetHeight?: number
): string[] {
  const maxBubbleWidth = 26;
  const textLines = wrapText(quip, maxBubbleWidth - 4); // 4 for "| " and " |"
  const innerWidth = textLines.reduce((a, l) => Math.max(a, l.length), 8);
  const bubbleWidth = innerWidth + 4; // "| " + text + " |"

  // Build bubble lines
  const bubbleLines: string[] = [];

  // Top border
  bubbleLines.push(" ." + "-".repeat(bubbleWidth - 2) + ".");

  // Content lines
  for (const line of textLines) {
    bubbleLines.push(" | " + line.padEnd(innerWidth) + " |");
  }

  // Bottom border with tail
  const tailPos = Math.min(10, bubbleWidth - 3);
  bubbleLines.push(" '" + "-".repeat(tailPos) + "." + " ".repeat(Math.max(0, bubbleWidth - tailPos - 3)) + "'");

  // Tail lines
  bubbleLines.push(" ".repeat(tailPos + 3) + "\\");

  // Now compose: bubble on left, buddy art on right
  // The buddy should start at the same height as the bottom of the bubble
  const buddyStartLine = Math.max(0, bubbleLines.length - buddyArt.length - 1);
  const totalLines = Math.max(bubbleLines.length, buddyStartLine + buddyArt.length + 1); // +1 for name

  const result: string[] = [];
  const gapStr = " ".repeat(gap);

  for (let i = 0; i < totalLines; i++) {
    const bubblePart = i < bubbleLines.length
      ? bubbleLines[i]!.padEnd(bubbleWidth + 1)
      : " ".repeat(bubbleWidth + 1);

    const artIndex = i - buddyStartLine;
    let buddyPart = "";
    if (artIndex >= 0 && artIndex < buddyArt.length) {
      buddyPart = buddyArt[artIndex]!;
    } else if (artIndex === buddyArt.length) {
      const artWidth = buddyArt[0]?.length ?? 0;
      const leftPad = Math.floor((artWidth - buddyName.length) / 2);
      buddyPart = " ".repeat(Math.max(0, leftPad)) + buddyName;
    }

    result.push(bubblePart + gapStr + buddyPart);
  }

  // Pad or trim to targetHeight if specified
  if (targetHeight !== undefined) {
    const lineWidth = result[0]?.length ?? 0;
    while (result.length < targetHeight) {
      result.push(" ".repeat(lineWidth));
    }
    if (result.length > targetHeight) {
      result.splice(0, result.length - targetHeight);
    }
  }

  return result;
}
