/**
 * Agent Mailbox — async message passing between agents.
 *
 * Pattern from Claude Code's SendMessageTool: agents can send
 * request-response messages to each other during execution.
 * Each agent has an inbox; messages are delivered asynchronously.
 */

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  /** If true, sender is waiting for a reply */
  expectsReply: boolean;
  /** Reply to a specific message */
  replyTo?: string;
  timestamp: string;
}

type MessageHandler = (msg: AgentMessage) => void;

class MailboxSystem {
  private inboxes = new Map<string, AgentMessage[]>();
  private handlers = new Map<string, MessageHandler>();
  private pendingReplies = new Map<string, {
    resolve: (reply: AgentMessage) => void;
    timer: ReturnType<typeof setTimeout>;
    from: string;
  }>();

  /**
   * Send a message to an agent. If expectsReply is true, returns a
   * Promise that resolves when the recipient replies.
   */
  async send(msg: Omit<AgentMessage, "id" | "timestamp">): Promise<AgentMessage | void> {
    const fullMsg: AgentMessage = {
      ...msg,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };

    // Deliver to inbox
    const inbox = this.inboxes.get(msg.to) ?? [];
    inbox.push(fullMsg);
    this.inboxes.set(msg.to, inbox);

    // Notify handler if registered
    this.handlers.get(msg.to)?.(fullMsg);

    // Register pending reply BEFORE resolving any prior promise,
    // so that if the recipient replies synchronously within the same
    // microtask tick, the pending entry already exists.
    let replyPromise: Promise<AgentMessage> | undefined;
    if (msg.expectsReply) {
      replyPromise = new Promise<AgentMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingReplies.delete(fullMsg.id);
          reject(new Error(`Reply timeout: no response from "${msg.to}" within 60s`));
        }, 60_000);

        this.pendingReplies.set(fullMsg.id, { resolve, timer, from: msg.from });
      });
    }

    // If this is a reply, resolve the pending promise
    if (msg.replyTo) {
      const pending = this.pendingReplies.get(msg.replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(fullMsg);
        this.pendingReplies.delete(msg.replyTo);
      }
    }

    if (replyPromise) return replyPromise;
  }

  /**
   * Check inbox for unread messages.
   */
  receive(agentId: string): AgentMessage[] {
    const msgs = this.inboxes.get(agentId) ?? [];
    this.inboxes.set(agentId, []);
    return msgs;
  }

  /**
   * Peek at inbox without clearing.
   */
  peek(agentId: string): AgentMessage[] {
    return this.inboxes.get(agentId) ?? [];
  }

  /**
   * Register a handler for incoming messages (for reactive agents).
   */
  onMessage(agentId: string, handler: MessageHandler): void {
    this.handlers.set(agentId, handler);
  }

  /**
   * Unregister handler.
   */
  offMessage(agentId: string): void {
    this.handlers.delete(agentId);
  }

  /**
   * Clean up agent's inbox, handlers, and pending reply timers.
   */
  cleanup(agentId: string): void {
    this.inboxes.delete(agentId);
    this.handlers.delete(agentId);
    // Cancel pending reply timers owned by this agent
    for (const [msgId, pending] of this.pendingReplies) {
      if (pending.from === agentId) {
        clearTimeout(pending.timer);
        this.pendingReplies.delete(msgId);
      }
    }
  }

  /**
   * Clear all mailboxes (session cleanup).
   */
  clear(): void {
    this.inboxes.clear();
    this.handlers.clear();
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
    }
    this.pendingReplies.clear();
  }

  /**
   * List all agents with pending messages.
   */
  getActiveInboxes(): Array<{ agentId: string; count: number }> {
    const result: Array<{ agentId: string; count: number }> = [];
    for (const [agentId, msgs] of this.inboxes) {
      if (msgs.length > 0) {
        result.push({ agentId, count: msgs.length });
      }
    }
    return result;
  }
}

// Singleton instance — shared across all agents in the process
export const mailbox = new MailboxSystem();
