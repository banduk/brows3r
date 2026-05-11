/**
 * Theme provider.
 *
 * Reads `useUiStore().theme` ('light' | 'dark' | 'system') and applies the
 * active theme by:
 *   - Setting `data-theme="light"|"dark"` on `<html>`.
 *   - Adding/removing the Tailwind `dark` class on `<html>`.
 *
 * For 'system', the OS preference is detected via
 * `window.matchMedia('(prefers-color-scheme: dark)')` and kept in sync via a
 * change listener so the app reacts to OS-level switches without a reload.
 *
 * Renders nothing — this is a pure side-effect component.
 *
 * OCP: any theme-dependent UI (Monaco, Shiki, future editor panels) reads
 * from the shared store or from `data-theme` on `<html>` — no per-consumer
 * theme detection is needed.
 */

import { useEffect } from "react";
import { useUiStore } from "@/store/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyTheme(resolved: "light" | "dark"): void {
  const html = document.documentElement;
  html.setAttribute("data-theme", resolved);
  if (resolved === "dark") {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

function resolveSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Theme(): null {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    if (theme === "system") {
      // Apply current OS preference immediately.
      applyTheme(resolveSystemTheme());

      // Keep in sync when the user changes the OS preference.
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      function handleChange(e: MediaQueryListEvent): void {
        applyTheme(e.matches ? "dark" : "light");
      }
      mq.addEventListener("change", handleChange);
      return () => mq.removeEventListener("change", handleChange);
    }

    applyTheme(theme);
    return undefined;
  }, [theme]);

  return null;
}
