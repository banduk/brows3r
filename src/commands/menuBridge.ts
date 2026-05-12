/**
 * Menu event bridge.
 *
 * Maps Tauri menu events (emitted by the Rust `on_menu_event` handler) to
 * command registry executions.  Each menu item id in menus.rs follows the
 * `menu:<command-id>` convention so the bridge is a simple prefix-strip +
 * `registry.run`.
 *
 * Call `installMenuBridge()` once on app mount (returns a cleanup function).
 * The bridge is intentionally separate from the query event bridge so it can
 * be tested in isolation and replaced without touching TanStack Query logic.
 *
 * OCP: adding a new menu item = one entry in menus.rs + one registered
 * command.  No changes here.
 */

import type { TauriEventMap, UnlistenFn } from "@/lib/tauri";
import { listen } from "@/lib/tauri";
import { registry } from "./registry";

// All menu event keys from TauriEventMap.
type MenuEventKey = {
  [K in keyof TauriEventMap]: K extends `menu:${string}` ? K : never;
}[keyof TauriEventMap];

// The menu item ids the bridge subscribes to.
const MENU_EVENTS: MenuEventKey[] = [
  "menu:file/new-folder",
  "menu:file/open",
  "menu:file/save",
  "menu:edit/find",
  "menu:view/refresh",
  "menu:view/toggle-sidebar",
  "menu:view/toggle-preview",
  "menu:view/mode/details",
  "menu:view/mode/icon-grid",
  "menu:view/mode/gallery",
  "menu:view/mode/column",
  "menu:view/mode/tree",
  "menu:view/mode/flat-key",
  "menu:view/mode/dual-pane",
  "menu:go/back",
  "menu:go/forward",
  "menu:go/up",
  "menu:go/bookmarks",
  "menu:help/docs",
  "menu:help/report-bug",
];

/**
 * Strip the `menu:` prefix and convert the path separator to derive the
 * registry command id.
 *
 * Tauri's event-name validator only accepts `[A-Za-z0-9_\-/:]`, so the
 * menu items use `/` between path segments (`menu:file/new-folder`) while
 * the registry keeps `.`-separated ids (`file.new-folder`). This bridge
 * is the only place that translates between the two encodings.
 *
 * Examples:
 *   "menu:file/new-folder" → "file.new-folder"
 *   "menu:view/refresh"    → "view.refresh"
 *   "menu:view/mode/details" → "view.mode.details"
 */
function menuEventToCommandId(event: MenuEventKey): string {
  // tsconfig target is ES2020 → use the regex `.replace` form rather than
  // `String.prototype.replaceAll` (ES2021).
  return event.slice("menu:".length).replace(/\//g, ".");
}

/**
 * Install Tauri event listeners for all known menu events and dispatch them
 * to the command registry.
 *
 * Returns a cleanup function that unlisten all listeners.
 */
export async function installMenuBridge(): Promise<() => void> {
  const unlisteners: UnlistenFn[] = await Promise.all(
    MENU_EVENTS.map((event) =>
      listen(event, () => {
        const commandId = menuEventToCommandId(event);
        const def = registry.lookupById(commandId);
        if (def) {
          void def.run({});
        }
        // If the command is not registered (e.g. nav stubs loaded later),
        // silently ignore so menu clicks never throw to the user.
      }),
    ),
  );

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
