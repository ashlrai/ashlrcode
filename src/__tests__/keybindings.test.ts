import { test, expect, describe, beforeEach } from "bun:test";
import {
  getAction,
  getBindings,
  setBinding,
  resetBindings,
  InputHistory,
} from "../ui/keybindings.ts";

beforeEach(() => {
  resetBindings();
});

describe("default bindings", () => {
  test("default bindings are loaded", () => {
    const bindings = getBindings();
    expect(bindings.length).toBeGreaterThan(0);

    const actions = bindings.map((b) => b.action);
    expect(actions).toContain("exit");
    expect(actions).toContain("mode-switch");
    expect(actions).toContain("autocomplete");
    expect(actions).toContain("clear-screen");
    expect(actions).toContain("undo");
  });
});

describe("getAction", () => {
  test("matches ctrl+c to exit", () => {
    // ctrl+c: key="c", ctrl=true, shift=false, meta=false
    const action = getAction("c", true, false, false);
    expect(action).toBe("exit");
  });

  test("matches shift+tab to mode-switch", () => {
    // shift+tab: key="tab", ctrl=false, shift=true, meta=false
    const action = getAction("tab", false, true, false);
    expect(action).toBe("mode-switch");
  });

  test("matches ctrl+l to clear-screen", () => {
    const action = getAction("l", true, false, false);
    expect(action).toBe("clear-screen");
  });

  test("returns null for unbound key", () => {
    const action = getAction("q", true, true, true);
    expect(action).toBeNull();
  });

  test("matches plain arrow keys", () => {
    expect(getAction("up", false, false, false)).toBe("history-prev");
    expect(getAction("down", false, false, false)).toBe("history-next");
  });
});

describe("setBinding", () => {
  test("overrides an existing binding", () => {
    // Change exit from ctrl+c to ctrl+q
    setBinding("exit", "ctrl+q");

    // Old combo should not match
    expect(getAction("c", true, false, false)).toBeNull();
    // New combo should match
    expect(getAction("q", true, false, false)).toBe("exit");
  });

  test("adds a new binding", () => {
    setBinding("custom-action", "ctrl+shift+x");
    const action = getAction("x", true, true, false);
    expect(action).toBe("custom-action");
  });
});

describe("InputHistory", () => {
  test("push and prev navigation", () => {
    const history = new InputHistory();
    history.push("first");
    history.push("second");
    history.push("third");

    // prev goes from most recent backwards
    expect(history.prev("")).toBe("third");
    expect(history.prev("")).toBe("second");
    expect(history.prev("")).toBe("first");
  });

  test("prev returns null on empty history", () => {
    const history = new InputHistory();
    expect(history.prev("")).toBeNull();
  });

  test("next navigates forward", () => {
    const history = new InputHistory();
    history.push("first");
    history.push("second");
    history.push("third");

    // Navigate to the beginning
    history.prev("");
    history.prev("");
    history.prev("");

    // Navigate forward
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("third");
  });

  test("next returns empty string when past end (clears input)", () => {
    const history = new InputHistory();
    history.push("hello");

    history.prev(""); // go to "hello"
    expect(history.next()).toBe(""); // past the end clears input
  });

  test("next returns null when not navigating", () => {
    const history = new InputHistory();
    history.push("hello");
    // Without calling prev first, index is -1
    expect(history.next()).toBeNull();
  });

  test("push resets navigation index", () => {
    const history = new InputHistory();
    history.push("first");
    history.push("second");

    // Navigate back
    history.prev("");
    expect(history.prev("")).toBe("first");

    // Push new entry resets index
    history.push("third");
    expect(history.prev("")).toBe("third");
  });

  test("does not push duplicate consecutive entries", () => {
    const history = new InputHistory();
    history.push("same");
    history.push("same");
    history.push("same");

    // Only one entry should exist
    expect(history.prev("")).toBe("same");
    // Going further back returns null (stays at index 0)
    const second = history.prev("");
    expect(second).toBe("same"); // stays at same since it's the only entry
  });

  test("wraps at beginning (stays at first entry)", () => {
    const history = new InputHistory();
    history.push("only");

    expect(history.prev("")).toBe("only");
    // Calling prev again stays at the first entry
    expect(history.prev("")).toBe("only");
  });
});
