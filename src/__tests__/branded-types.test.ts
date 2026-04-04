import { test, expect, describe } from "bun:test";
import {
  asSystemPrompt,
  asSessionId,
  asAgentId,
  asToolName,
} from "../types/branded.ts";

describe("Branded Types", () => {
  test("asSystemPrompt returns the string", () => {
    const result = asSystemPrompt("You are a helpful assistant.");
    expect(result as string).toBe("You are a helpful assistant.");
    expect(typeof result).toBe("string");
  });

  test("asSessionId returns the string", () => {
    const result = asSessionId("sess-abc-123");
    expect(result as string).toBe("sess-abc-123");
    expect(typeof result).toBe("string");
  });

  test("asAgentId returns the string", () => {
    const result = asAgentId("agent-007");
    expect(result as string).toBe("agent-007");
    expect(typeof result).toBe("string");
  });

  test("asToolName returns the string", () => {
    const result = asToolName("Bash");
    expect(result as string).toBe("Bash");
    expect(typeof result).toBe("string");
  });

  test("all branded type functions exist and are callable", () => {
    expect(typeof asSystemPrompt).toBe("function");
    expect(typeof asSessionId).toBe("function");
    expect(typeof asAgentId).toBe("function");
    expect(typeof asToolName).toBe("function");
  });

  test("branded values work with string operations", () => {
    const prompt = asSystemPrompt("hello world");
    expect(prompt.toUpperCase()).toBe("HELLO WORLD");
    expect(prompt.length).toBe(11);
    expect(prompt.includes("world")).toBe(true);
  });
});
