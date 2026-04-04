/**
 * SendMessage tool — agent-to-agent messaging with reply support.
 *
 * Upgraded to use the mailbox system for proper request-response
 * communication between named agents during execution.
 */

import type { Tool, ToolContext } from "./types.ts";
import { mailbox, type AgentMessage } from "../agent/mailbox.ts";
import { getAgentContext } from "../agent/async-context.ts";

/**
 * Backward-compatible helpers for legacy callers.
 */
export function getMessages(agentName: string): AgentMessage[] {
  return mailbox.peek(agentName);
}

export function clearMessages(agentName: string): void {
  mailbox.receive(agentName); // Consume all messages
}

export const sendMessageTool: Tool = {
  name: "SendMessage",

  prompt() {
    return "Send a message to another agent. Use for coordination, asking questions, or sharing findings between agents working on related tasks. Set expect_reply=true to wait for a response.";
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
        expect_reply: {
          type: "boolean",
          description: "Whether to wait for a reply (default: false). Set true for questions.",
        },
        reply_to: {
          type: "string",
          description: "Message ID this is a reply to (when responding to a received message)",
        },
      },
      required: ["to", "content"],
    };
  },

  isReadOnly() { return false; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput(input) {
    if (!input.to || typeof input.to !== "string") return "to is required";
    if (!input.content || typeof input.content !== "string") return "content is required";
    return null;
  },

  async call(input, _context) {
    const ctx = getAgentContext();
    const from = ctx?.agentName ?? ctx?.agentId ?? "main";

    try {
      const reply = await mailbox.send({
        from,
        to: input.to as string,
        content: input.content as string,
        expectsReply: (input.expect_reply as boolean) ?? false,
        replyTo: input.reply_to as string | undefined,
      });

      if (reply) {
        return `Reply from ${reply.from}: ${reply.content}`;
      }
      return `Message sent to "${input.to}"`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to send message: ${msg}`;
    }
  },
};

/**
 * CheckMessages tool — read incoming messages from the mailbox.
 */
export const checkMessagesTool: Tool = {
  name: "CheckMessages",

  prompt() {
    return "Check your mailbox for messages from other agents. Messages are consumed when read unless peek=true.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        peek: {
          type: "boolean",
          description: "If true, don't mark messages as read (default: false)",
        },
      },
    };
  },

  isReadOnly() { return true; },
  isDestructive() { return false; },
  isConcurrencySafe() { return true; },

  validateInput() { return null; },

  async call(input, _context) {
    const ctx = getAgentContext();
    const agentId = ctx?.agentName ?? ctx?.agentId ?? "main";
    const peek = (input.peek as boolean) ?? false;

    const messages = peek ? mailbox.peek(agentId) : mailbox.receive(agentId);

    if (messages.length === 0) {
      return "No messages in your inbox.";
    }

    const lines = messages.map((m) =>
      `[${m.timestamp}] From ${m.from}: ${m.content}${m.expectsReply ? " (reply expected, msg_id: " + m.id + ")" : ""}`
    );

    return `${messages.length} message(s):\n${lines.join("\n")}`;
  },
};
