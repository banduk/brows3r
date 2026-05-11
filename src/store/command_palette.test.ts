/**
 * Tests for the command palette Zustand store.
 *
 * Each test uses an isolated registry + store instance so tests don't
 * bleed into each other.
 */

import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "@/commands/registry";
import { createCommandPaletteStore, filterCommands } from "./command_palette";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  const reg = createRegistry();
  reg.register({
    id: "app.about",
    title: "About brows3r",
    group: "Application",
    run: vi.fn(),
  });
  reg.register({
    id: "file.open",
    title: "Open File",
    group: "File",
    run: vi.fn(),
  });
  reg.register({
    id: "view.refresh",
    title: "Refresh View",
    group: "View",
    run: vi.fn(),
  });

  const store = createCommandPaletteStore(reg);
  return { store, reg };
}

// ---------------------------------------------------------------------------
// filterCommands (pure function)
// ---------------------------------------------------------------------------

describe("filterCommands", () => {
  const commands = [
    { id: "a", title: "About brows3r", group: "App", run: vi.fn() },
    { id: "b", title: "Open File", group: "File", run: vi.fn() },
    { id: "c", title: "Refresh View", group: "View", run: vi.fn() },
  ];

  it("returns all commands when query is empty", () => {
    expect(filterCommands(commands, "")).toHaveLength(3);
  });

  it("filters by substring match", () => {
    const results = filterCommands(commands, "file");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("b");
  });

  it("ranks prefix match above word-boundary above substring", () => {
    const cmds = [
      // substring only: "fuzz" appears mid-word, does not start a word
      { id: "sub", title: "Contains nofuzzy inside", group: "G", run: vi.fn() },
      // word-boundary: second word starts with "fuzzy"
      { id: "word", title: "About fuzzy", group: "G", run: vi.fn() },
      // prefix: title starts with "Fuzzy"
      { id: "prefix", title: "Fuzzy finder", group: "G", run: vi.fn() },
    ];
    const results = filterCommands(cmds, "fuzzy");
    expect(results[0]?.id).toBe("prefix");
    expect(results[1]?.id).toBe("word");
    expect(results[2]?.id).toBe("sub");
  });

  it("returns empty when no commands match", () => {
    expect(filterCommands(commands, "zzz")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(commands, "ABOUT")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Store — open / close
// ---------------------------------------------------------------------------

describe("commandPaletteStore", () => {
  it("starts closed", () => {
    const { store } = makeStore();
    expect(store.getState().open).toBe(false);
  });

  it("openPalette sets open=true and resets query/index", () => {
    const { store } = makeStore();
    store.getState().setQuery("abc");
    store.getState().openPalette();
    const s = store.getState();
    expect(s.open).toBe(true);
    expect(s.query).toBe("");
    expect(s.focusedIndex).toBe(0);
  });

  it("closePalette sets open=false and resets state", () => {
    const { store } = makeStore();
    store.getState().openPalette();
    store.getState().setQuery("open");
    store.getState().closePalette();
    const s = store.getState();
    expect(s.open).toBe(false);
    expect(s.query).toBe("");
    expect(s.focusedIndex).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // setQuery filters results
  // ---------------------------------------------------------------------------

  it("setQuery updates results filtered by the query", () => {
    const { store } = makeStore();
    store.getState().openPalette();
    store.getState().setQuery("open");
    const { results } = store.getState();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.title.toLowerCase()).toContain("open");
    }
  });

  it("setQuery with empty string returns all commands", () => {
    const { store, reg } = makeStore();
    store.getState().setQuery("open");
    store.getState().setQuery("");
    expect(store.getState().results).toHaveLength(reg.all().length);
  });

  it("setQuery resets focusedIndex to 0", () => {
    const { store } = makeStore();
    store.getState().openPalette();
    store.setState({ focusedIndex: 2 });
    store.getState().setQuery("ref");
    expect(store.getState().focusedIndex).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // focusNext / focusPrev wraps
  // ---------------------------------------------------------------------------

  it("focusNext advances the focused index", () => {
    const { store } = makeStore();
    store.getState().openPalette(); // loads all 3 commands
    store.getState().focusNext();
    expect(store.getState().focusedIndex).toBe(1);
  });

  it("focusNext wraps around to 0 at the end", () => {
    const { store } = makeStore();
    store.getState().openPalette(); // 3 results
    store.setState({ focusedIndex: 2 }); // last item
    store.getState().focusNext();
    expect(store.getState().focusedIndex).toBe(0);
  });

  it("focusPrev wraps around to last at 0", () => {
    const { store } = makeStore();
    store.getState().openPalette(); // 3 results
    store.getState().focusPrev();
    expect(store.getState().focusedIndex).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // executeFocused
  // ---------------------------------------------------------------------------

  it("executeFocused calls the focused command's run with ctx", () => {
    const runFn = vi.fn();
    const reg = createRegistry();
    reg.register({ id: "cmd.a", title: "Command A", group: "G", run: runFn });
    reg.register({ id: "cmd.b", title: "Command B", group: "G", run: vi.fn() });

    const store = createCommandPaletteStore(reg);
    store.getState().openPalette();
    store.setState({ focusedIndex: 0 });

    const ctx = { someKey: "value" };
    store.getState().executeFocused(ctx);

    expect(runFn).toHaveBeenCalledOnce();
    expect(runFn).toHaveBeenCalledWith(ctx);
  });

  it("executeFocused closes the palette after running", () => {
    const { store } = makeStore();
    store.getState().openPalette();
    store.getState().executeFocused({});
    expect(store.getState().open).toBe(false);
  });

  it("executeFocused does nothing when results are empty", () => {
    const reg = createRegistry();
    const store = createCommandPaletteStore(reg);
    store.getState().openPalette();
    // No commands registered, results = [].
    expect(() => store.getState().executeFocused({})).not.toThrow();
  });
});
