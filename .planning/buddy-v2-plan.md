# Buddy V2: Pixel-Perfect Multi-Line ASCII Art in Ink

## Problem
Glitch's multi-line ASCII art causes duplication/flicker when rendered in Ink's live area. Currently reduced to single-line joined text as a workaround. We want the full multi-line art in the bottom-right corner like Claude Code's Velum.

## Root Cause
Ink re-renders the entire live area on every state change. When the buddy is multiple `<Text>` elements, the terminal can't always clear the previous render cleanly — especially in Claude Code's terminal emulator, which handles ANSI differently than standard terminals.

## Solution: Dedicated Ink Component with Fixed Height

### Architecture
Create a `<BuddyPanel>` Ink component that:
1. Uses `<Box height={6}>` to reserve a FIXED height region
2. Renders buddy art as a single pre-computed string with `\n` newlines
3. Uses `flexShrink={0}` to prevent the layout engine from collapsing it
4. Positions right-aligned using `<Box justifyContent="flex-end">`

### Key Insight from Claude Code
Claude Code's Velum works because:
- It's a **single React component** that owns its own height
- It uses `<Box>` with fixed dimensions so Ink knows exactly how many lines to clear
- The speech bubble is rendered as part of the SAME component, not a separate element
- Ink's cursor management knows the exact terminal region to repaint

### Implementation

#### 1. Create `src/ui/BuddyPanel.tsx`
```tsx
import React from "react";
import { Box, Text } from "ink";

interface Props {
  art: string[];    // buddy ASCII art lines
  name: string;
  quip: string;
  quipType: "quip" | "suggestion" | "reaction";
}

export function BuddyPanel({ art, name, quip, quipType }: Props) {
  // Fixed height = art lines + name + quip = consistent terminal region
  const height = art.length + 2;
  
  return (
    <Box flexDirection="column" alignItems="flex-end" height={height} flexShrink={0}>
      {/* All art as single Text with newlines */}
      <Text color="cyan">{art.join("\n")}</Text>
      <Text color="cyan" bold>{name}</Text>
      {quipType === "suggestion" ? (
        <Text color="green">💡 {quip}</Text>
      ) : quipType === "reaction" ? (
        <Text color="yellow">{quip}</Text>
      ) : (
        <Text dimColor italic>"{quip}"</Text>
      )}
    </Box>
  );
}
```

#### 2. Layout in App.tsx
```tsx
// Bottom area: input box on left, buddy panel on right
<Box>
  {/* Left: full input area */}
  <Box flexDirection="column" flexGrow={1}>
    <Text dimColor>{"-".repeat(inputWidth)}</Text>
    <Box>
      <Text color={modeColor} bold>❯ </Text>
      <TextInput ... />
    </Box>
    <Text dimColor>{"-".repeat(inputWidth)}</Text>
    {/* Status line */}
    <Box>
      <Text>❯❯ {mode}</Text>
      <Text>████░░ 12% · 240K/2M</Text>
    </Box>
  </Box>
  
  {/* Right: buddy panel — fixed width, fixed height */}
  <Box width={20} flexShrink={0}>
    <BuddyPanel art={buddyArt} name={buddyName} quip={buddyQuip} quipType={buddyQuipType} />
  </Box>
</Box>
```

The key difference from our previous attempt:
- `flexShrink={0}` on the buddy panel prevents Ink from collapsing it
- `height={N}` tells Ink exactly how many terminal lines to reserve
- `flexGrow={1}` on the input area takes remaining space
- Buddy is a SIBLING of the input, not a child or separate element

#### 3. Speech Bubble (optional enhancement)
Render the speech bubble ABOVE the buddy panel as a Static item (one-time render):
```tsx
// On each turn end, push a new Static item with the bubble
addOutput(renderBuddyWithBubble(quip, art, name).join("\n"));
```
This way the bubble scrolls up with the output (like chat history) while the live buddy stays fixed at the bottom.

#### 4. AI-Powered Quips Integration
The existing `buddy-ai.ts` works perfectly with this — just pass the quip and type to `<BuddyPanel>`.

## Testing Plan
1. Run `ac --yolo` — buddy appears in bottom-right with full art
2. Submit a task — buddy art stays stable during streaming (no flicker)
3. Every 5th turn — AI quip appears in green/yellow
4. Ctrl+C — clean exit, no orphaned buddy art
5. Resize terminal — buddy repositions correctly

## Effort Estimate
- BuddyPanel component: 1 hour
- App.tsx layout refactor: 2 hours  
- Speech bubble as Static items: 1 hour
- Testing + polish: 1 hour
- Total: ~5 hours

## Files to Create/Modify
- `src/ui/BuddyPanel.tsx` — NEW
- `src/ui/App.tsx` — refactor layout to use BuddyPanel
- `src/repl.tsx` — speech bubbles as Static items on turn end

## Dependencies
- None new — uses existing Ink, buddy.ts, buddy-ai.ts, speech-bubble.ts
