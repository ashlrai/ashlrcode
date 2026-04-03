/**
 * Ink component for tool permission prompts.
 *
 * Renders a styled permission request inline in the REPL output,
 * showing the tool name, description, and available key options.
 */

import React from "react";
import { Box, Text } from "ink";

interface Props {
  toolName: string;
  description: string;
}

export function PermissionPrompt({ toolName, description }: Props) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="yellow" bold>⚡ Permission: </Text>
        <Text bold>{toolName}</Text>
      </Box>
      <Text dimColor>  {description}</Text>
      <Box marginTop={1}>
        <Text dimColor>  [y] allow  [a] always  [n] deny  [d] always deny</Text>
      </Box>
    </Box>
  );
}
