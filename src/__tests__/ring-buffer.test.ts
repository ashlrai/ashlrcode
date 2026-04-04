import { test, expect, describe, beforeEach } from "bun:test";
import {
  RingBuffer,
  logError,
  getRecentErrors,
  getErrorLog,
  clearErrorLog,
} from "../utils/ring-buffer.ts";

describe("RingBuffer", () => {
  let buf: RingBuffer<number>;

  beforeEach(() => {
    buf = new RingBuffer<number>(5);
  });

  describe("push and toArray", () => {
    test("empty buffer returns empty array", () => {
      expect(buf.toArray()).toEqual([]);
    });

    test("push items and retrieve in insertion order", () => {
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    test("overflow discards oldest items", () => {
      for (let i = 1; i <= 7; i++) buf.push(i);
      expect(buf.toArray()).toEqual([3, 4, 5, 6, 7]);
    });

    test("exactly at capacity", () => {
      for (let i = 1; i <= 5; i++) buf.push(i);
      expect(buf.toArray()).toEqual([1, 2, 3, 4, 5]);
    });

    test("double overflow wraps correctly", () => {
      for (let i = 1; i <= 12; i++) buf.push(i);
      expect(buf.toArray()).toEqual([8, 9, 10, 11, 12]);
    });
  });

  describe("size and isFull", () => {
    test("size starts at 0", () => {
      expect(buf.size).toBe(0);
    });

    test("size grows with pushes", () => {
      buf.push(1);
      expect(buf.size).toBe(1);
      buf.push(2);
      expect(buf.size).toBe(2);
    });

    test("size caps at capacity", () => {
      for (let i = 0; i < 10; i++) buf.push(i);
      expect(buf.size).toBe(5);
    });

    test("isFull is false before capacity", () => {
      buf.push(1);
      expect(buf.isFull).toBe(false);
    });

    test("isFull is true at capacity", () => {
      for (let i = 0; i < 5; i++) buf.push(i);
      expect(buf.isFull).toBe(true);
    });
  });

  describe("recent", () => {
    test("returns all items when n >= size", () => {
      buf.push(1);
      buf.push(2);
      expect(buf.recent(5)).toEqual([1, 2]);
    });

    test("returns last n items", () => {
      for (let i = 1; i <= 5; i++) buf.push(i);
      expect(buf.recent(3)).toEqual([3, 4, 5]);
    });

    test("returns last n items after overflow", () => {
      for (let i = 1; i <= 8; i++) buf.push(i);
      expect(buf.recent(2)).toEqual([7, 8]);
    });

    test("recent(0) returns all items (slice(-0) returns full array)", () => {
      buf.push(1);
      // slice(-0) === slice(0) which returns full array
      expect(buf.recent(0)).toEqual([1]);
    });
  });

  describe("last", () => {
    test("returns undefined when empty", () => {
      expect(buf.last()).toBeUndefined();
    });

    test("returns most recent item", () => {
      buf.push(10);
      buf.push(20);
      expect(buf.last()).toBe(20);
    });

    test("returns most recent after overflow", () => {
      for (let i = 1; i <= 7; i++) buf.push(i);
      expect(buf.last()).toBe(7);
    });
  });

  describe("clear", () => {
    test("resets buffer to empty", () => {
      for (let i = 0; i < 5; i++) buf.push(i);
      buf.clear();
      expect(buf.size).toBe(0);
      expect(buf.toArray()).toEqual([]);
      expect(buf.isFull).toBe(false);
      expect(buf.last()).toBeUndefined();
    });

    test("buffer works correctly after clear", () => {
      for (let i = 0; i < 5; i++) buf.push(i);
      buf.clear();
      buf.push(99);
      expect(buf.toArray()).toEqual([99]);
      expect(buf.size).toBe(1);
    });
  });

  describe("capacity 1", () => {
    test("only holds one item", () => {
      const tiny = new RingBuffer<string>(1);
      tiny.push("a");
      tiny.push("b");
      expect(tiny.toArray()).toEqual(["b"]);
      expect(tiny.size).toBe(1);
      expect(tiny.isFull).toBe(true);
    });
  });
});

describe("Error log singleton", () => {
  beforeEach(() => {
    clearErrorLog();
  });

  test("logError adds entries", () => {
    logError("test", "something went wrong");
    const errors = getErrorLog();
    expect(errors.length).toBe(1);
    expect(errors[0]!.category).toBe("test");
    expect(errors[0]!.message).toBe("something went wrong");
    expect(errors[0]!.timestamp).toBeTruthy();
  });

  test("logError with context", () => {
    logError("network", "timeout", "fetching /api/data");
    const errors = getErrorLog();
    expect(errors[0]!.context).toBe("fetching /api/data");
  });

  test("getRecentErrors returns last N", () => {
    for (let i = 0; i < 10; i++) {
      logError("cat", `error-${i}`);
    }
    const recent = getRecentErrors(3);
    expect(recent.length).toBe(3);
    expect(recent[0]!.message).toBe("error-7");
    expect(recent[2]!.message).toBe("error-9");
  });

  test("getRecentErrors defaults to 50", () => {
    for (let i = 0; i < 100; i++) {
      logError("cat", `error-${i}`);
    }
    const recent = getRecentErrors();
    expect(recent.length).toBe(50);
  });

  test("clearErrorLog empties the log", () => {
    logError("x", "y");
    clearErrorLog();
    expect(getErrorLog().length).toBe(0);
  });
});
