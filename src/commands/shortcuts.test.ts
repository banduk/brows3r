/**
 * Tests for shortcut helpers: platformShortcut, formatShortcut, parseShortcut.
 */

import { describe, expect, it } from "vitest";

import {
  BASELINE_SHORTCUTS,
  formatShortcut,
  parseShortcut,
  platformShortcut,
} from "./shortcuts";

// ---------------------------------------------------------------------------
// platformShortcut
// ---------------------------------------------------------------------------

describe("platformShortcut", () => {
  it("returns the mac binding on mac", () => {
    const binding = {
      mac: { mod: ["cmd"] as const, key: "c" },
      default: { mod: ["ctrl"] as const, key: "c" },
    };
    const resolved = platformShortcut(binding, "mac");
    expect(resolved.mod).toContain("cmd");
    expect(resolved.key).toBe("c");
  });

  it("returns the default binding on win", () => {
    const binding = {
      mac: { mod: ["cmd"] as const, key: "c" },
      default: { mod: ["ctrl"] as const, key: "c" },
    };
    const resolved = platformShortcut(binding, "win");
    expect(resolved.mod).toContain("ctrl");
    expect(resolved.key).toBe("c");
  });

  it("returns the default binding on linux", () => {
    const binding = {
      mac: { mod: ["cmd"] as const, key: "r" },
      default: { mod: ["ctrl"] as const, key: "r" },
    };
    const resolved = platformShortcut(binding, "linux");
    expect(resolved.mod).toContain("ctrl");
    expect(resolved.key).toBe("r");
  });
});

// ---------------------------------------------------------------------------
// formatShortcut
// ---------------------------------------------------------------------------

describe("formatShortcut", () => {
  it("formats Cmd+K as ⌘K on mac", () => {
    expect(formatShortcut({ mod: ["cmd"], key: "k" }, "mac")).toBe("⌘K");
  });

  it("formats Ctrl+K on win", () => {
    expect(formatShortcut({ mod: ["ctrl"], key: "k" }, "win")).toBe("Ctrl+K");
  });

  it("formats Cmd+Shift+P as ⌘⇧P on mac", () => {
    expect(formatShortcut({ mod: ["cmd", "shift"], key: "p" }, "mac")).toBe(
      "⌘⇧P",
    );
  });

  it("formats a plain key with no modifiers", () => {
    expect(formatShortcut({ key: "Enter" }, "mac")).toBe("↩");
    expect(formatShortcut({ key: "Enter" }, "win")).toBe("Enter");
  });

  it("formats ArrowUp", () => {
    expect(formatShortcut({ key: "ArrowUp" }, "mac")).toBe("↑");
    expect(formatShortcut({ key: "ArrowUp" }, "win")).toBe("Up");
  });

  it("formats Backspace", () => {
    expect(formatShortcut({ key: "Backspace" }, "mac")).toBe("⌫");
    expect(formatShortcut({ key: "Backspace" }, "win")).toBe("Backspace");
  });

  it("formats Delete", () => {
    expect(formatShortcut({ key: "Delete" }, "mac")).toBe("⌦");
    expect(formatShortcut({ key: "Delete" }, "win")).toBe("Delete");
  });
});

// ---------------------------------------------------------------------------
// parseShortcut
// ---------------------------------------------------------------------------

describe("parseShortcut", () => {
  it("parses a plain key", () => {
    const result = parseShortcut("ArrowUp");
    expect(result).toEqual({ key: "ArrowUp" });
  });

  it("parses Ctrl+K", () => {
    const result = parseShortcut("Ctrl+K");
    expect(result.mod).toContain("ctrl");
    expect(result.key).toBe("k");
  });

  it("parses Cmd+Shift+P", () => {
    const result = parseShortcut("Cmd+Shift+P");
    expect(result.mod).toContain("cmd");
    expect(result.mod).toContain("shift");
    expect(result.key).toBe("p");
  });

  it("parses mac symbol format ⌘K", () => {
    const result = parseShortcut("⌘K");
    expect(result.mod).toContain("cmd");
    expect(result.key).toBe("k");
  });

  it("parses mac symbol format ⌘⇧P", () => {
    const result = parseShortcut("⌘⇧P");
    expect(result.mod).toContain("cmd");
    expect(result.mod).toContain("shift");
    expect(result.key).toBe("p");
  });

  it("throws for an empty string", () => {
    expect(() => parseShortcut("")).toThrow();
  });

  it("round-trips through formatShortcut on mac", () => {
    const original = { mod: ["cmd", "shift"] as const, key: "p" };
    const formatted = formatShortcut(original, "mac");
    const parsed = parseShortcut(formatted);

    // mod order may differ; check contents.
    expect(parsed.mod).toBeDefined();
    expect(parsed.mod).toContain("cmd");
    expect(parsed.mod).toContain("shift");
    expect(parsed.key).toBe("p");
  });

  it("round-trips through formatShortcut on win", () => {
    const original = { mod: ["ctrl", "shift"] as const, key: "p" };
    const formatted = formatShortcut(original, "win");
    const parsed = parseShortcut(formatted);

    expect(parsed.mod).toContain("ctrl");
    expect(parsed.mod).toContain("shift");
    expect(parsed.key).toBe("p");
  });
});

// ---------------------------------------------------------------------------
// BASELINE_SHORTCUTS — sanity checks
// ---------------------------------------------------------------------------

describe("BASELINE_SHORTCUTS", () => {
  it("contains all 24 baseline entries", () => {
    expect(Object.keys(BASELINE_SHORTCUTS)).toHaveLength(24);
  });

  it("has ArrowUp for view.cursor.up on mac and default", () => {
    const entry = BASELINE_SHORTCUTS["view.cursor.up"];
    expect(entry?.mac.key).toBe("ArrowUp");
    expect(entry?.default.key).toBe("ArrowUp");
  });

  it("has cmd modifier for clipboard.copy on mac", () => {
    const entry = BASELINE_SHORTCUTS["clipboard.copy"];
    expect(entry?.mac.mod).toContain("cmd");
    expect(entry?.default.mod).toContain("ctrl");
  });

  it("has cmd+shift for palette.open on mac", () => {
    const entry = BASELINE_SHORTCUTS["palette.open"];
    expect(entry?.mac.mod).toContain("cmd");
    expect(entry?.mac.mod).toContain("shift");
  });
});
