/**
 * Global keyboard shortcuts for pane navigation: back, forward, up.
 *
 * Mount once in App.tsx alongside `usePaletteShortcut` and
 * `useInspectorShortcut`. Each shortcut delegates to a registry command
 * so the keyboard binding and the Toolbar button share the exact same
 * handler. Skipped when the user is typing in an input/textarea so
 * the shortcuts don't steal focus during text edits.
 *
 * Bindings (macOS / Linux+Windows):
 *   Cmd+[ / Ctrl+[       → nav.back
 *   Cmd+] / Ctrl+]       → nav.forward
 *   Cmd+↑ / Ctrl+↑       → nav.up
 *
 * Why these specific keys: they mirror common browser / IDE conventions
 * without colliding with the existing Cmd+K (palette), Cmd+I (inspect),
 * Cmd+F (search), Cmd+L (breadcrumb edit), Cmd+R (refresh), or Cmd+, (settings).
 */

import { useEffect } from "react";
import { registry } from "@/commands/registry";

function isEditableElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export function useNavShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.startsWith("Mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (isEditableElement(e.target)) return;

      if (e.key === "[") {
        e.preventDefault();
        registry.lookupById("nav.back")?.run({});
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        registry.lookupById("nav.forward")?.run({});
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        registry.lookupById("nav.up")?.run({});
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
