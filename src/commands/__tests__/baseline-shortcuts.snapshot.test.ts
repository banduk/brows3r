/**
 * Cross-layer snapshot test — round-2 finding #1.
 *
 * Asserts that BASELINE_SHORTCUTS exported from `shortcuts.ts` deeply equals
 * the fixture at `../__fixtures__/baseline-shortcuts.proposal.json`.
 *
 * This test is the enforcement layer that makes any drift between the
 * fixture (proposal.md lines 175-176) and the runtime code surface as a
 * build break.
 *
 * Future task 56 (settings persistence) will also import this fixture to
 * assert the default settings shortcut map equals the baseline.
 */

import { describe, expect, it } from "vitest";

import baseline from "../__fixtures__/baseline-shortcuts.proposal.json";
import { BASELINE_SHORTCUTS } from "../shortcuts";

describe("BASELINE_SHORTCUTS cross-layer snapshot", () => {
  it("matches the fixture verbatim from proposal.md lines 175-176", () => {
    expect(BASELINE_SHORTCUTS).toEqual(baseline.shortcuts);
  });

  it("fixture source annotation points to proposal.md lines 175-176", () => {
    expect(baseline._source).toBe("proposal.md lines 175-176");
  });
});
