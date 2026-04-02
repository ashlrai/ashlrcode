/**
 * SendMessage tool — send messages between agents.
 *
 * Enables agent-to-agent communication for team coordination.
 */

import type { Tool, ToolContext } from "./types.ts";

// Simple in-memory message inbox
interface Message {
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

const inbox: Message[] = [];

export function getMessages(agentName: string): Message[] {
  return inbox.filter((m) => m.to === agentName);
}

export function clearMessages(agentName: string): void {
  const toRemove = inbox.filter((m) => m.to === agentName);
  for (const msg of toRemove) {
    const idx = inbox.indexOf(msg);
    if (idx >= 0) inbox.splice(idx, 1);
  }
}

export const sendMessageTool: Tool = {
  name: "SendMessage",

  prompt() {
    return "Send a message to another agent. Used for agent-to-agent communication when coordinating work across sub-agents.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Name or ID of the recipient agent",
        },
        content: {
          type: "string",
          description: "Message content",
        },
      },
      required: ["to", "content"],
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    if (!input.to) return "to is required";
    if (!input.content) return "content is required";
    return null;
  },

  async call(input, _context) {
    const msg: Message = {
      from: "main",
      to: input.to as string,
      content: input.content as string,
      timestamp: new Date().toISOString(),
    };
    inbox.push(msg);
    return `Message sent to ${msg.to}`;
  },
};
