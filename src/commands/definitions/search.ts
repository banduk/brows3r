/**
 * Search command definitions.
 *
 * Registers the `search.local` command with the app-level registry so it is
 * reachable from the command palette and keyboard shortcut (Cmd/Ctrl+F).
 *
 * `search.local` triggers the SearchBox overlay bound to the active pane.
 *
 * OCP: adding a new search command (e.g. "search.history") = one more
 * `registry.register(def)` call here.
 */

import { registry } from "../registry";

// ---------------------------------------------------------------------------
// search.local — open the search overlay for the active pane
// ---------------------------------------------------------------------------

registry.register({
  id: "search.local",
  title: "Search / Filter",
  group: "Search",
  description:
    "Open the search overlay. Filter the current listing or search the whole bucket.",
  defaultShortcut: {
    mac: { key: "f", mod: ["meta"] },
    default: { key: "f", mod: ["ctrl"] },
  },
  run(_ctx) {
    // Dispatch a custom event so the SearchBox can subscribe without a
    // tight coupling to this command definition.
    window.dispatchEvent(new CustomEvent("search:open"));
  },
});
