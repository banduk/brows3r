/**
 * Global keyboard shortcut hook that opens the inspector on Cmd/Ctrl+I.
 *
 * Mount once in App.tsx alongside `usePaletteShortcut`. Delegates to the
 * `view.inspect` command in the registry so the shortcut and the toolbar
 * button use the exact same handler.
 *
 * Round-1 finding #25 — discoverability path 2 of 2 owned by task 45.
 */

import { useEffect } from "react";
import { registry } from "@/commands/registry";

export function useInspectorShortcut(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const isMac = navigator.platform.startsWith("Mac");
      const triggerMod = isMac ? e.metaKey : e.ctrlKey;

      if (triggerMod && e.key === "i") {
        e.preventDefault();
        const cmd = registry.lookupById("view.inspect");
        cmd?.run({});
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
