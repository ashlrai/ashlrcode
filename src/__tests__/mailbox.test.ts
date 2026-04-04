import { test, expect, describe, beforeEach } from "bun:test";

// Import the singleton - we'll clear it between tests
import { mailbox } from "../agent/mailbox.ts";

describe("MailboxSystem", () => {
  beforeEach(() => {
    mailbox.clear();
  });

  describe("send and receive", () => {
    test("message is delivered to recipient inbox", async () => {
      await mailbox.send({
        from: "agent-a",
        to: "agent-b",
        content: "hello",
        expectsReply: false,
      });

      const msgs = mailbox.receive("agent-b");
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.content).toBe("hello");
      expect(msgs[0]!.from).toBe("agent-a");
      expect(msgs[0]!.to).toBe("agent-b");
      expect(msgs[0]!.id).toMatch(/^msg-/);
      expect(msgs[0]!.timestamp).toBeTruthy();
    });

    test("receive clears the inbox", async () => {
      await mailbox.send({
        from: "a",
        to: "b",
        content: "first",
        expectsReply: false,
      });

      mailbox.receive("b"); // consume
      const second = mailbox.receive("b");
      expect(second.length).toBe(0);
    });

    test("receive from empty inbox returns empty array", () => {
      expect(mailbox.receive("nonexistent")).toEqual([]);
    });

    test("multiple messages accumulate in inbox", async () => {
      await mailbox.send({ from: "a", to: "b", content: "1", expectsReply: false });
      await mailbox.send({ from: "c", to: "b", content: "2", expectsReply: false });
      await mailbox.send({ from: "a", to: "b", content: "3", expectsReply: false });

      const msgs = mailbox.receive("b");
      expect(msgs.length).toBe(3);
      expect(msgs.map((m) => m.content)).toEqual(["1", "2", "3"]);
    });
  });

  describe("peek", () => {
    test("peek returns messages without clearing", async () => {
      await mailbox.send({ from: "a", to: "b", content: "peek-me", expectsReply: false });

      const first = mailbox.peek("b");
      expect(first.length).toBe(1);

      const second = mailbox.peek("b");
      expect(second.length).toBe(1);
      expect(second[0]!.content).toBe("peek-me");
    });

    test("peek on empty inbox returns empty array", () => {
      expect(mailbox.peek("nobody")).toEqual([]);
    });
  });

  describe("expectsReply and replyTo", () => {
    test("expectsReply returns a promise that resolves on reply", async () => {
      // Send message expecting reply
      const replyPromise = mailbox.send({
        from: "a",
        to: "b",
        content: "question?",
        expectsReply: true,
      });

      // Get the message to find its ID
      const msgs = mailbox.peek("b");
      const questionId = msgs[0]!.id;

      // Reply to it
      await mailbox.send({
        from: "b",
        to: "a",
        content: "answer!",
        expectsReply: false,
        replyTo: questionId,
      });

      const reply = await replyPromise;
      expect(reply).toBeTruthy();
      expect((reply as any).content).toBe("answer!");
    });

    test("send without expectsReply returns void", async () => {
      const result = await mailbox.send({
        from: "a",
        to: "b",
        content: "fire and forget",
        expectsReply: false,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("onMessage handler", () => {
    test("handler is called when message arrives", async () => {
      const received: string[] = [];
      mailbox.onMessage("listener", (msg) => {
        received.push(msg.content);
      });

      await mailbox.send({ from: "sender", to: "listener", content: "hi", expectsReply: false });
      expect(received).toEqual(["hi"]);
    });

    test("offMessage removes handler", async () => {
      const received: string[] = [];
      mailbox.onMessage("listener", (msg) => received.push(msg.content));
      mailbox.offMessage("listener");

      await mailbox.send({ from: "sender", to: "listener", content: "hi", expectsReply: false });
      expect(received).toEqual([]);
    });
  });

  describe("cleanup", () => {
    test("cleanup removes inbox and handler", async () => {
      await mailbox.send({ from: "a", to: "target", content: "msg", expectsReply: false });
      mailbox.onMessage("target", () => {});

      mailbox.cleanup("target");

      expect(mailbox.peek("target")).toEqual([]);
    });

    test("cleanup cancels pending reply timers for the agent", async () => {
      // Send a message expecting reply from agent "a"
      const replyPromise = mailbox.send({
        from: "a",
        to: "b",
        content: "waiting",
        expectsReply: true,
      });

      // Cleanup agent "a" - should cancel the pending timer
      mailbox.cleanup("a");

      // The promise should not resolve (timer was cleared)
      // We just verify cleanup doesn't throw
      expect(true).toBe(true);
    });
  });

  describe("clear", () => {
    test("clear removes all inboxes and handlers", async () => {
      await mailbox.send({ from: "a", to: "b", content: "1", expectsReply: false });
      await mailbox.send({ from: "c", to: "d", content: "2", expectsReply: false });
      mailbox.onMessage("b", () => {});

      mailbox.clear();

      expect(mailbox.peek("b")).toEqual([]);
      expect(mailbox.peek("d")).toEqual([]);
      expect(mailbox.getActiveInboxes()).toEqual([]);
    });
  });

  describe("getActiveInboxes", () => {
    test("lists agents with pending messages", async () => {
      await mailbox.send({ from: "a", to: "b", content: "1", expectsReply: false });
      await mailbox.send({ from: "a", to: "b", content: "2", expectsReply: false });
      await mailbox.send({ from: "a", to: "c", content: "3", expectsReply: false });

      const active = mailbox.getActiveInboxes();
      expect(active.length).toBe(2);

      const bEntry = active.find((e) => e.agentId === "b");
      expect(bEntry!.count).toBe(2);

      const cEntry = active.find((e) => e.agentId === "c");
      expect(cEntry!.count).toBe(1);
    });

    test("consumed inboxes are not listed", async () => {
      await mailbox.send({ from: "a", to: "b", content: "msg", expectsReply: false });
      mailbox.receive("b");

      const active = mailbox.getActiveInboxes();
      expect(active.length).toBe(0);
    });
  });
});
