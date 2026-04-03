/**
 * ListPeers tool — discover and communicate with other running AshlrCode instances.
 *
 * Actions:
 *   list  — show all active peers (pid, cwd, session)
 *   send  — send a message to a peer by ID
 *   inbox — read received messages
 */

import type { Tool } from "./types.ts";
import { listPeers, sendToPeer, readInbox, getPeerId } from "../agent/ipc.ts";

export const listPeersTool: Tool = {
  name: "ListPeers",

  prompt() {
    return (
      "List other running AshlrCode instances and communicate with them via IPC. " +
      "Use action 'list' to discover peers, 'send' to message a peer, 'inbox' to read received messages."
    );
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "send", "inbox"],
          description: "Action to perform: list peers, send a message, or check inbox",
        },
        peerId: {
          type: "string",
          description: "Target peer ID (required for 'send')",
        },
        message: {
          type: "string",
          description: "Message content (required for 'send')",
        },
      },
      required: ["action"],
    };
  },

  isReadOnly() {
    return true;
  },

  isDestructive() {
    return false;
  },

  isConcurrencySafe() {
    return true;
  },

  validateInput(input) {
    const action = input.action as string | undefined;
    if (!action || !["list", "send", "inbox"].includes(action)) {
      return "action must be one of: list, send, inbox";
    }
    if (action === "send") {
      if (!input.peerId || typeof input.peerId !== "string") {
        return "peerId is required for send action";
      }
      if (!input.message || typeof input.message !== "string") {
        return "message is required for send action";
      }
    }
    return null;
  },

  async call(input) {
    const action = input.action as string;

    if (action === "list") {
      const peers = await listPeers();
      const myId = getPeerId();
      if (peers.length === 0) {
        return "No AshlrCode instances running (IPC server may not be started).";
      }
      const lines = peers.map((p) => {
        const self = p.id === myId ? " (self)" : "";
        return `  ${p.id}${self}  pid=${p.pid}  cwd=${p.cwd}  session=${p.sessionId}  started=${p.startedAt}`;
      });
      return `Active peers (${peers.length}):\n${lines.join("\n")}`;
    }

    if (action === "inbox") {
      const msgs = readInbox();
      if (msgs.length === 0) {
        return "Inbox is empty — no messages received.";
      }
      const lines = msgs.map(
        (m) => `  [${m.timestamp}] from=${m.from} type=${m.type}: ${m.payload}`,
      );
      return `${msgs.length} message(s):\n${lines.join("\n")}`;
    }

    if (action === "send") {
      const ok = await sendToPeer(
        input.peerId as string,
        "message",
        input.message as string,
      );
      return ok
        ? "Message sent successfully."
        : "Failed to send — peer not found or unreachable.";
    }

    return "Unknown action.";
  },
};
