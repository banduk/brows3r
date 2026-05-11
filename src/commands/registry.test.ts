/**
 * Tests for the command registry.
 *
 * Each test uses createRegistry() for isolation — no shared state between
 * tests, no side-effects on the app singleton.
 */

import { describe, expect, it } from "vitest";

import { createRegistry } from "./registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop() {}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe("registry.register", () => {
  it("registers a command and retrieves it by id", () => {
    const reg = createRegistry();
    reg.register({ id: "test.one", title: "One", group: "Test", run: noop });

    const def = reg.lookupById("test.one");
    expect(def).toBeDefined();
    expect(def?.id).toBe("test.one");
    expect(def?.title).toBe("One");
  });

  it("throws when the same id is registered twice", () => {
    const reg = createRegistry();
    reg.register({ id: "test.dup", title: "Dup", group: "Test", run: noop });

    expect(() =>
      reg.register({ id: "test.dup", title: "Dup2", group: "Test", run: noop }),
    ).toThrow(/already registered/i);
  });
});

// ---------------------------------------------------------------------------
// lookupById
// ---------------------------------------------------------------------------

describe("registry.lookupById", () => {
  it("returns undefined for an unknown id", () => {
    const reg = createRegistry();
    expect(reg.lookupById("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lookupByShortcut
// ---------------------------------------------------------------------------

describe("registry.lookupByShortcut", () => {
  it("finds a command by its mac shortcut on mac", () => {
    const reg = createRegistry();
    reg.register({
      id: "nav.back",
      title: "Back",
      group: "Navigation",
      defaultShortcut: {
        mac: { mod: ["cmd", "alt"], key: "ArrowLeft" },
        default: { mod: ["ctrl", "alt"], key: "ArrowLeft" },
      },
      run: noop,
    });

    const found = reg.lookupByShortcut(
      { mod: ["cmd", "alt"], key: "ArrowLeft" },
      "mac",
    );
    expect(found?.id).toBe("nav.back");
  });

  it("finds a command by its default shortcut on win", () => {
    const reg = createRegistry();
    reg.register({
      id: "nav.back",
      title: "Back",
      group: "Navigation",
      defaultShortcut: {
        mac: { mod: ["cmd", "alt"], key: "ArrowLeft" },
        default: { mod: ["ctrl", "alt"], key: "ArrowLeft" },
      },
      run: noop,
    });

    const found = reg.lookupByShortcut(
      { mod: ["ctrl", "alt"], key: "ArrowLeft" },
      "win",
    );
    expect(found?.id).toBe("nav.back");
  });

  it("does not find the mac shortcut on win", () => {
    const reg = createRegistry();
    reg.register({
      id: "clipboard.copy",
      title: "Copy",
      group: "Clipboard",
      defaultShortcut: {
        mac: { mod: ["cmd"], key: "c" },
        default: { mod: ["ctrl"], key: "c" },
      },
      run: noop,
    });

    const found = reg.lookupByShortcut({ mod: ["cmd"], key: "c" }, "win");
    expect(found).toBeUndefined();
  });

  it("returns undefined when no shortcut matches", () => {
    const reg = createRegistry();
    reg.register({
      id: "file.open",
      title: "Open",
      group: "File",
      defaultShortcut: { key: "Enter" },
      run: noop,
    });

    expect(reg.lookupByShortcut({ key: "ArrowUp" }, "mac")).toBeUndefined();
  });

  it("handles plain (non-platform) shortcuts", () => {
    const reg = createRegistry();
    reg.register({
      id: "file.open",
      title: "Open",
      group: "File",
      defaultShortcut: { key: "Enter" },
      run: noop,
    });

    // Plain shortcuts resolve the same on all platforms.
    expect(reg.lookupByShortcut({ key: "Enter" }, "mac")?.id).toBe("file.open");
    expect(reg.lookupByShortcut({ key: "Enter" }, "win")?.id).toBe("file.open");
  });

  it("matches regardless of modifier order", () => {
    const reg = createRegistry();
    reg.register({
      id: "palette.open",
      title: "Command Palette",
      group: "Application",
      defaultShortcut: {
        mac: { mod: ["cmd", "shift"], key: "p" },
        default: { mod: ["ctrl", "shift"], key: "p" },
      },
      run: noop,
    });

    // Provide modifiers in reverse order — should still match.
    const found = reg.lookupByShortcut(
      { mod: ["shift", "cmd"], key: "p" },
      "mac",
    );
    expect(found?.id).toBe("palette.open");
  });
});

// ---------------------------------------------------------------------------
// all()
// ---------------------------------------------------------------------------

describe("registry.all", () => {
  it("returns empty array for a fresh registry", () => {
    const reg = createRegistry();
    expect(reg.all()).toHaveLength(0);
  });

  it("returns all registered commands in registration order", () => {
    const reg = createRegistry();
    reg.register({ id: "a", title: "A", group: "G", run: noop });
    reg.register({ id: "b", title: "B", group: "G", run: noop });
    reg.register({ id: "c", title: "C", group: "G", run: noop });

    const ids = reg.all().map((d) => d.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// byGroup()
// ---------------------------------------------------------------------------

describe("registry.byGroup", () => {
  it("returns commands for the requested group only", () => {
    const reg = createRegistry();
    reg.register({ id: "file.open", title: "Open", group: "File", run: noop });
    reg.register({
      id: "file.delete",
      title: "Delete",
      group: "File",
      run: noop,
    });
    reg.register({
      id: "view.refresh",
      title: "Refresh",
      group: "View",
      run: noop,
    });

    const fileCommands = reg.byGroup("File");
    expect(fileCommands).toHaveLength(2);
    expect(fileCommands.map((d) => d.id)).toEqual(
      expect.arrayContaining(["file.open", "file.delete"]),
    );
  });

  it("returns empty array for an unknown group", () => {
    const reg = createRegistry();
    expect(reg.byGroup("NoSuchGroup")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

describe("registry.detectConflicts", () => {
  it("returns no conflicts for a registry with unique shortcuts", () => {
    const reg = createRegistry();
    reg.register({
      id: "file.open",
      title: "Open",
      group: "File",
      defaultShortcut: { key: "Enter" },
      run: noop,
    });
    reg.register({
      id: "file.delete",
      title: "Delete",
      group: "File",
      defaultShortcut: { key: "Delete" },
      run: noop,
    });

    const report = reg.detectConflicts("mac");
    expect(report.conflicts).toHaveLength(0);
  });

  it("reports a conflict when two commands share the same platform shortcut", () => {
    const reg = createRegistry();
    reg.register({
      id: "cmd.a",
      title: "A",
      group: "G",
      defaultShortcut: { mod: ["ctrl"], key: "k" },
      run: noop,
    });
    reg.register({
      id: "cmd.b",
      title: "B",
      group: "G",
      defaultShortcut: { mod: ["ctrl"], key: "k" },
      run: noop,
    });

    const report = reg.detectConflicts("win");
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.commandIds).toEqual(
      expect.arrayContaining(["cmd.a", "cmd.b"]),
    );
  });

  it("does not report a conflict when shortcuts differ by platform", () => {
    // cmd.a uses Cmd+K on mac, cmd.b uses Ctrl+K on win.
    // On mac, cmd.a resolves to Cmd+K and cmd.b resolves to Ctrl+K → no conflict.
    const reg = createRegistry();
    reg.register({
      id: "cmd.a",
      title: "A",
      group: "G",
      defaultShortcut: {
        mac: { mod: ["cmd"], key: "k" },
        default: { mod: ["ctrl"], key: "j" },
      },
      run: noop,
    });
    reg.register({
      id: "cmd.b",
      title: "B",
      group: "G",
      defaultShortcut: {
        mac: { mod: ["ctrl"], key: "k" },
        default: { mod: ["ctrl"], key: "k" },
      },
      run: noop,
    });

    const report = reg.detectConflicts("mac");
    expect(report.conflicts).toHaveLength(0);
  });

  it("conflict detection is deterministic across multiple calls", () => {
    const reg = createRegistry();
    reg.register({
      id: "x",
      title: "X",
      group: "G",
      defaultShortcut: { key: "F1" },
      run: noop,
    });
    reg.register({
      id: "y",
      title: "Y",
      group: "G",
      defaultShortcut: { key: "F1" },
      run: noop,
    });

    const r1 = reg.detectConflicts("mac");
    const r2 = reg.detectConflicts("mac");
    expect(r1).toEqual(r2);
  });

  it("ignores commands without a defaultShortcut", () => {
    const reg = createRegistry();
    reg.register({
      id: "no.shortcut",
      title: "No Shortcut",
      group: "G",
      run: noop,
    });
    reg.register({
      id: "no.shortcut2",
      title: "No Shortcut 2",
      group: "G",
      run: noop,
    });

    const report = reg.detectConflicts("mac");
    expect(report.conflicts).toHaveLength(0);
  });
});
