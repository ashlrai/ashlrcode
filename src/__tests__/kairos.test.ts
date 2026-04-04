import { describe, test, expect } from "bun:test";
import { detectTerminalFocus, type FocusState } from "../agent/kairos.ts";

describe("KAIROS", () => {
  describe("detectTerminalFocus", () => {
    test("returns a valid FocusState", async () => {
      const result = await detectTerminalFocus();
      expect(["focused", "unfocused", "unknown"]).toContain(result);
    });

    test("returns string type", async () => {
      const result = await detectTerminalFocus();
      expect(typeof result).toBe("string");
    });
  });
});
