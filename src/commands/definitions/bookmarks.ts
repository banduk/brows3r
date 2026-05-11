/**
 * Bookmark and recents command definitions.
 *
 * Registers `bookmark.add`, `bookmark.delete`, and `recents.clear` with the
 * app-level registry so they are reachable from the command palette, menus,
 * and keyboard shortcuts.
 *
 * OCP: adding a new bookmark command = one `registry.register(def)` call here.
 */

import { registry } from "../registry";

// ---------------------------------------------------------------------------
// bookmark.add
// ---------------------------------------------------------------------------

registry.register({
  id: "bookmark.add",
  title: "Add Bookmark",
  group: "Bookmarks",
  description: "Bookmark the current pane location.",
  run(_ctx) {
    // Dispatch a DOM event so the toolbar / breadcrumb can handle the actual
    // API call without a direct import dependency on this module.
    window.dispatchEvent(new CustomEvent("bookmark:add"));
  },
});

// ---------------------------------------------------------------------------
// bookmark.delete
// ---------------------------------------------------------------------------

registry.register({
  id: "bookmark.delete",
  title: "Delete Bookmark",
  group: "Bookmarks",
  description: "Remove a bookmark by id.",
  run(ctx) {
    const bookmarkId =
      typeof ctx.bookmarkId === "string" ? ctx.bookmarkId : undefined;
    if (bookmarkId === undefined) return;
    window.dispatchEvent(
      new CustomEvent("bookmark:delete", { detail: { bookmarkId } }),
    );
  },
});

// ---------------------------------------------------------------------------
// recents.clear
// ---------------------------------------------------------------------------

registry.register({
  id: "recents.clear",
  title: "Clear Recent Locations",
  group: "Recents",
  description: "Clear the recent locations history.",
  run(_ctx) {
    window.dispatchEvent(new CustomEvent("recents:clear"));
  },
});
