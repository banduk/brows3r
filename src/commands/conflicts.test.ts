/**
 * Tests for the pure detectConflicts function in conflicts.ts.
 */

import { describe, expect, it } from "vitest";

import { detectConflicts } from "./conflicts";
import { createRegistry } from "./registry";

function noop() {}

describe("detectConflicts (pure function)", () => {
  it("returns no conflicts for a clean registry", () => {
    const reg = createRegistry();
    reg.register({
      id: "a",
      title: "A",
      group: "G",
      defaultShortcut: { key: "F1" },
      run: noop,
    });
    const report = detectConflicts(reg, "mac");
    expect(report.conflicts).toHaveLength(0);
  });

  it("reports a conflict when two commands share a shortcut", () => {
    const reg = createRegistry();
    reg.register({
      id: "x",
      title: "X",
      group: "G",
      defaultShortcut: { mod: ["ctrl"], key: "k" },
      run: noop,
    });
    reg.register({
      id: "y",
      title: "Y",
      group: "G",
      defaultShortcut: { mod: ["ctrl"], key: "k" },
      run: noop,
    });

    const report = detectConflicts(reg, "linux");
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.commandIds).toEqual(
      expect.arrayContaining(["x", "y"]),
    );
  });

  it("platform-specific: conflict on mac only when both use cmd+k on mac", () => {
    const reg = createRegistry();
    reg.register({
      id: "alpha",
      title: "Alpha",
      group: "G",
      defaultShortcut: {
        mac: { mod: ["cmd"], key: "k" },
        default: { mod: ["ctrl"], key: "j" },
      },
      run: noop,
    });
    reg.register({
      id: "beta",
      title: "Beta",
      group: "G",
      defaultShortcut: {
        mac: { mod: ["cmd"], key: "k" },
        default: { mod: ["ctrl"], key: "k" },
      },
      run: noop,
    });

    const macReport = detectConflicts(reg, "mac");
    const winReport = detectConflicts(reg, "win");

    expect(macReport.conflicts).toHaveLength(1);
    expect(winReport.conflicts).toHaveLength(0);
  });

  it("does not mutate the registry", () => {
    const reg = createRegistry();
    reg.register({ id: "z", title: "Z", group: "G", run: noop });

    const before = reg.all().length;
    detectConflicts(reg, "mac");
    expect(reg.all()).toHaveLength(before);
  });
});
