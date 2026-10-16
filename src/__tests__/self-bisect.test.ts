import { describe, test, expect } from "bun:test";
import {
  bisectEdits,
  buildSurgicalRevert,
  type Edit,
} from "../agent/self-bisect.ts";

/**
 * Build a synthetic edit sequence over a single virtual file `foo.ts`, where
 * each edit appends one line `lineN`. We can then drive a check that fails as
 * soon as a specific "poison" line is present — modeling edit #k introducing
 * the break.
 */
function makeSequence(n: number): Edit[] {
  const edits: Edit[] = [];
  let content = "";
  for (let i = 0; i < n; i++) {
    const before = content;
    const line = `line${i}`;
    content = content === "" ? line : content + "\n" + line;
    edits.push({
      filePath: "foo.ts",
      before,
      after: content,
      label: `edit#${i}`,
    });
  }
  return edits;
}

/**
 * A test harness that simulates a working tree: applying prefix k sets the tree
 * to the `after` of edit k-1 (or pristine "" for k=0). The check fails if the
 * tree content contains the poison line for the given culprit index.
 */
function makeHarness(edits: Edit[], poisonIndex: number) {
  let tree = ""; // current materialized content
  const poisonLine = `line${poisonIndex}`;
  return {
    apply(prefixLen: number) {
      tree = prefixLen === 0 ? "" : edits[prefixLen - 1]!.after;
    },
    check() {
      // "broken" once the poison line is present in the tree.
      return !tree.split("\n").includes(poisonLine);
    },
    probesShouldStayUnder(_n: number) {
      /* helper placeholder */
    },
  };
}

describe("bisectEdits", () => {
  test("pinpoints the culprit edit #k that breaks the check", async () => {
    const edits = makeSequence(8);
    const poison = 5; // edit #5 introduces the break
    const harness = makeHarness(edits, poison);

    const result = await bisectEdits({
      edits,
      check: harness.check,
      apply: harness.apply,
    });

    expect(result.reason).toBe("isolated");
    expect(result.culpritIndex).toBe(poison);
    expect(result.culprit?.label).toBe(`edit#${poison}`);
  });

  test("proposes a surgical revert that restores the culprit's before-state", async () => {
    const edits = makeSequence(8);
    const poison = 5;
    const harness = makeHarness(edits, poison);

    const result = await bisectEdits({
      edits,
      check: harness.check,
      apply: harness.apply,
    });

    expect(result.surgicalRevert).toBeDefined();
    const revert = result.surgicalRevert!;
    // The revert hunk removes the poison line (added by the culprit) and
    // references the culprit's file.
    expect(revert).toContain("foo.ts");
    expect(revert).toContain(`-line${poison}`);
  });

  test("is bounded: uses ~log2(n) check probes, not linear", async () => {
    const n = 64;
    const edits = makeSequence(n);
    const harness = makeHarness(edits, 40);

    const result = await bisectEdits({
      edits,
      check: harness.check,
      apply: harness.apply,
    });

    expect(result.culpritIndex).toBe(40);
    // Binary search over 64 edits should be far under linear.
    expect(result.probes).toBeLessThan(n);
    expect(result.probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(n + 1)) + 4);
  });

  test("works when the FIRST edit is the culprit", async () => {
    const edits = makeSequence(6);
    const harness = makeHarness(edits, 0);
    const result = await bisectEdits({ edits, check: harness.check, apply: harness.apply });
    expect(result.reason).toBe("isolated");
    expect(result.culpritIndex).toBe(0);
  });

  test("works when the LAST edit is the culprit", async () => {
    const edits = makeSequence(6);
    const harness = makeHarness(edits, 5);
    const result = await bisectEdits({ edits, check: harness.check, apply: harness.apply });
    expect(result.reason).toBe("isolated");
    expect(result.culpritIndex).toBe(5);
  });

  test("reports already-passing when nothing breaks", async () => {
    const edits = makeSequence(6);
    // Poison index 99 never appears → tree always passes.
    const harness = makeHarness(edits, 99);
    const result = await bisectEdits({ edits, check: harness.check, apply: harness.apply });
    expect(result.reason).toBe("already-passing");
    expect(result.culprit).toBeUndefined();
  });

  test("reports no-culprit when the break predates the edits (pristine already fails)", async () => {
    const edits = makeSequence(6);
    const result = await bisectEdits({
      edits,
      check: () => false, // broken from the very start
      apply: () => {},
    });
    expect(result.reason).toBe("no-culprit");
    expect(result.culprit).toBeUndefined();
  });

  test("no-edits is handled", async () => {
    const result = await bisectEdits({ edits: [], check: () => true, apply: () => {} });
    expect(result.reason).toBe("no-edits");
  });

  test("never throws when check or apply throw", async () => {
    const edits = makeSequence(4);
    const result = await bisectEdits({
      edits,
      check: () => {
        throw new Error("check exploded");
      },
      apply: () => {
        throw new Error("apply exploded");
      },
    });
    // A throwing check is treated as failure → pristine "fails" → no-culprit.
    expect(["no-culprit", "exhausted"]).toContain(result.reason);
  });

  test("respects maxProbes cap and falls back gracefully", async () => {
    const edits = makeSequence(32);
    const harness = makeHarness(edits, 20);
    const result = await bisectEdits({
      edits,
      check: harness.check,
      apply: harness.apply,
      maxProbes: 3, // far too few to fully bisect
    });
    expect(result.probes).toBeLessThanOrEqual(3);
    // Either exhausted with a best-effort culprit, or it never got past
    // preconditions — both are valid bounded outcomes.
    expect(["exhausted", "no-culprit"]).toContain(result.reason);
  });

  test("async check + async apply are supported", async () => {
    const edits = makeSequence(10);
    const harness = makeHarness(edits, 7);
    const result = await bisectEdits({
      edits,
      check: async () => harness.check(),
      apply: async (k) => harness.apply(k),
    });
    expect(result.culpritIndex).toBe(7);
  });
});

describe("buildSurgicalRevert", () => {
  test("produces a minimal inverse hunk (only the changed lines)", () => {
    const edit: Edit = {
      filePath: "src/x.ts",
      before: "a\nb\nc",
      after: "a\nb\nBROKEN\nc",
      label: "introduce BROKEN",
    };
    const revert = buildSurgicalRevert(edit);
    expect(revert).toContain("--- a/src/x.ts");
    expect(revert).toContain("+++ b/src/x.ts");
    // Removes the inserted BROKEN line, keeps common context out of the hunk.
    expect(revert).toContain("-BROKEN");
    expect(revert).not.toContain("-a");
    expect(revert).not.toContain("-c");
  });

  test("handles pure deletion revert (after removed a line)", () => {
    const edit: Edit = {
      filePath: "f.ts",
      before: "keep\ndeleted\nkeep2",
      after: "keep\nkeep2",
    };
    const revert = buildSurgicalRevert(edit);
    // Reverting should re-add the deleted line.
    expect(revert).toContain("+deleted");
  });
});
