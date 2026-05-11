/**
 * Zustand slice for the command palette.
 *
 * State: open/closed, query string, focused result index.
 * Results are derived from the registry via inline fuzzy matching.
 *
 * OCP: fuzzy scoring is centralised here — future improvements (recency,
 * frequency) are one function swap.
 */

import { create } from "zustand";
import type { CommandContext, CommandDef } from "@/commands/registry";
import { registry } from "@/commands/registry";

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

/** Score — higher = better match. Returns -1 when no match. */
function fuzzyScore(title: string, query: string): number {
  const lowerTitle = title.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerQuery.length === 0) return 0;
  if (!lowerTitle.includes(lowerQuery)) return -1;

  // Exact prefix match: best score.
  if (lowerTitle.startsWith(lowerQuery)) return 3;

  // Word-boundary match: a word in the title starts with the query.
  const words = lowerTitle.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(lowerQuery)) return 2;
  }

  // Substring match: anywhere in the title.
  return 1;
}

/**
 * Filter and sort commands from the registry by fuzzy relevance.
 *
 * When query is empty all commands are returned in registration order.
 */
export function filterCommands(
  commands: CommandDef[],
  query: string,
): CommandDef[] {
  if (query.trim().length === 0) return commands;

  const scored: Array<{ def: CommandDef; score: number }> = [];

  for (const def of commands) {
    const score = fuzzyScore(def.title, query);
    if (score >= 0) {
      scored.push({ def, score });
    }
  }

  // Stable sort: higher score first, same score keeps registration order.
  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => s.def);
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface CommandPaletteState {
  open: boolean;
  query: string;
  focusedIndex: number;
  results: CommandDef[];

  openPalette(): void;
  closePalette(): void;
  setQuery(q: string): void;
  focusNext(): void;
  focusPrev(): void;
  executeFocused(ctx: CommandContext): void;
}

// ---------------------------------------------------------------------------
// Store factory — allows isolated instances in tests
// ---------------------------------------------------------------------------

/**
 * Internal factory, exposed so tests can create isolated instances.
 * The app-level store is the exported `useCommandPaletteStore`.
 */
export function createCommandPaletteStore(sourceRegistry = registry) {
  const allCommands = () => sourceRegistry.all();

  return create<CommandPaletteState>((set, get) => ({
    open: false,
    query: "",
    focusedIndex: 0,
    results: filterCommands(allCommands(), ""),

    openPalette() {
      set({
        open: true,
        query: "",
        focusedIndex: 0,
        results: filterCommands(allCommands(), ""),
      });
    },

    closePalette() {
      set({ open: false, query: "", focusedIndex: 0 });
    },

    setQuery(q: string) {
      const results = filterCommands(allCommands(), q);
      set({ query: q, focusedIndex: 0, results });
    },

    focusNext() {
      const { focusedIndex, results } = get();
      if (results.length === 0) return;
      set({ focusedIndex: (focusedIndex + 1) % results.length });
    },

    focusPrev() {
      const { focusedIndex, results } = get();
      if (results.length === 0) return;
      set({
        focusedIndex: (focusedIndex - 1 + results.length) % results.length,
      });
    },

    executeFocused(ctx: CommandContext) {
      const { focusedIndex, results } = get();
      const def = results[focusedIndex];
      if (def === undefined) return;

      // Run async commands fire-and-forget; errors should be handled inside run().
      void def.run(ctx);
      get().closePalette();
    },
  }));
}

// ---------------------------------------------------------------------------
// App-level singleton store
// ---------------------------------------------------------------------------

export const useCommandPaletteStore = createCommandPaletteStore();
