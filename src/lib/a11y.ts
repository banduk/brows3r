/**
 * A11y baseline hooks.
 *
 * Provides focus management primitives used across modal and panel surfaces:
 * - `useFocusTrap` — confines Tab/Shift+Tab focus to a container element
 *   while active (used by dialogs, command palette, modals).
 * - `useFocusReturn` — restores focus to the element that triggered an
 *   overlay when the overlay closes.
 *
 * Shadcn's Dialog already ships Radix's built-in focus trap; these hooks
 * are for non-dialog surfaces (e.g. inline panels, custom drawers).
 *
 * Tab order documented in ARIA terms (D5):
 *   skip-link → sidebar nav → main file list → preview pane → status bar
 */

import { useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Focus trap
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Confine keyboard Tab focus to `containerRef` while `active` is true.
 *
 * On activation, moves focus to the first focusable child.
 * On deactivation, focus restoration is handled by the caller via
 * `useFocusReturn`.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!active || e.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
      ).filter((el) => !el.closest("[aria-hidden='true']"));

      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      // Guard: both must be defined (checked above via length === 0 early return).
      if (!first || !last) return;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [active, containerRef],
  );

  useEffect(() => {
    if (!active) return;

    // Move focus into the container on activation.
    const container = containerRef.current;
    if (container) {
      const firstFocusable =
        container.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
      firstFocusable?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, containerRef, handleKeyDown]);
}

// ---------------------------------------------------------------------------
// Focus return
// ---------------------------------------------------------------------------

/**
 * Capture the currently focused element on mount (or on `active` flip to
 * true) and restore focus to it when `active` becomes false.
 *
 * Usage:
 *   const triggerRef = useFocusReturn(isDialogOpen);
 *   <button ref={triggerRef}>Open dialog</button>
 */
export function useFocusReturn(
  active: boolean,
): React.RefObject<HTMLElement | null> {
  const returnTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (active) {
      // Capture trigger element when overlay opens.
      returnTargetRef.current = document.activeElement as HTMLElement | null;
    } else if (returnTargetRef.current) {
      // Restore focus when overlay closes.
      returnTargetRef.current.focus();
      returnTargetRef.current = null;
    }
  }, [active]);

  return returnTargetRef;
}
