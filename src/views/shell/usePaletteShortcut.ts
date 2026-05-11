/**
 * Global keyboard shortcut hook that opens the command palette on Cmd/Ctrl+K.
 *
 * Mount once in App.tsx. Registers a window-level keydown listener so the
 * shortcut works from any focused element in the app.
 */

import { useEffect } from "react";
import { useCommandPaletteStore } from "@/store/command_palette";

export function usePaletteShortcut(): void {
  const openPalette = useCommandPaletteStore((s) => s.openPalette);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const isMac = navigator.platform.startsWith("Mac");
      const triggerMod = isMac ? e.metaKey : e.ctrlKey;

      if (triggerMod && e.key === "k") {
        e.preventDefault();
        openPalette();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openPalette]);
}
