import { test, expect, describe, afterEach } from "bun:test";
import { feature, setFeature, listFeatures } from "../config/features.ts";

// Track features we modify so we can reset them
const modified: Array<{ name: string; original: boolean }> = [];

function setAndTrack(name: string, value: boolean) {
  const features = listFeatures();
  if (name in features) {
    modified.push({ name, original: features[name]! });
  } else {
    modified.push({ name, original: false });
  }
  setFeature(name, value);
}

afterEach(() => {
  for (const { name, original } of modified) {
    setFeature(name, original);
  }
  modified.length = 0;
});

describe("feature", () => {
  test("returns default values for known flags", () => {
    const features = listFeatures();
    // DREAM_TASK defaults to true
    expect(feature("DREAM_TASK")).toBe(features["DREAM_TASK"]!);
    // VOICE_MODE defaults to false
    expect(feature("VOICE_MODE")).toBe(features["VOICE_MODE"]!);
  });

  test("returns false for unknown feature", () => {
    expect(feature("TOTALLY_FAKE_FEATURE_" + Date.now())).toBe(false);
  });
});

describe("setFeature", () => {
  test("overrides a feature value", () => {
    setAndTrack("VOICE_MODE", true);
    expect(feature("VOICE_MODE")).toBe(true);

    setAndTrack("VOICE_MODE", false);
    expect(feature("VOICE_MODE")).toBe(false);
  });

  test("can set a new feature that did not exist", () => {
    const name = "TEST_FEATURE_" + Date.now();
    setAndTrack(name, true);
    expect(feature(name)).toBe(true);
  });
});

describe("listFeatures", () => {
  test("returns all flags as a plain object", () => {
    const features = listFeatures();
    expect(typeof features).toBe("object");
    expect("DREAM_TASK" in features).toBe(true);
    expect("VOICE_MODE" in features).toBe(true);
    expect("TEAM_MODE" in features).toBe(true);
  });

  test("returns a copy (mutations do not affect internal state)", () => {
    const features = listFeatures();
    features["DREAM_TASK"] = false;
    // Internal state should be unchanged
    expect(feature("DREAM_TASK")).toBe(listFeatures()["DREAM_TASK"]!);
  });
});
