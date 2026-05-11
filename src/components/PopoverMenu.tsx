/**
 * PopoverMenu — accessible dropdown that escapes scrollable ancestors.
 *
 * Why this exists: rows inside the Sidebar live in `overflow-hidden` and
 * `overflow-y-auto` containers. A dropdown with `position: absolute` would
 * be clipped by those ancestors. PopoverMenu uses `position: fixed` and
 * computes its coordinates from the trigger's `getBoundingClientRect()`,
 * so it always renders above the entire window regardless of where the
 * trigger sits.
 *
 * Usage:
 * ```tsx
 * <PopoverMenu
 *   triggerLabel="Actions for John"
 *   triggerIcon={<MoreHorizontalIcon />}
 *   items={[
 *     { label: "Edit",     onClick: () => ... },
 *     { label: "Validate", onClick: () => ... },
 *     { label: "Delete",   onClick: () => ..., variant: "danger" },
 *   ]}
 * />
 * ```
 *
 * A11y:
 * - Trigger has `aria-haspopup="menu"` and `aria-expanded`.
 * - Menu has `role="menu"` and items have `role="menuitem"`.
 * - Esc closes; click-outside closes; Tab through items keyboardable.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PopoverMenuItem {
  label: string;
  onClick(): void;
  /** Optional leading icon rendered inside the menu item. */
  icon?: React.ReactNode;
  /** Optional trailing decoration (e.g. a "✓" or shortcut hint). */
  trailing?: React.ReactNode;
  /** Visual treatment. `danger` paints the item red. */
  variant?: "default" | "danger";
  /** When true the item is disabled (pointer + keyboard). */
  disabled?: boolean;
}

export interface PopoverMenuProps {
  /** Accessible label for the trigger button. */
  triggerLabel: string;
  /** Visual content of the trigger button. */
  triggerIcon: React.ReactNode;
  /** Menu items. */
  items: PopoverMenuItem[];
  /** Optional fixed minimum width for the menu (default 140px). */
  minWidth?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PopoverMenu({
  triggerLabel,
  triggerIcon,
  items,
  minWidth = 140,
}: PopoverMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  const recompute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const menuEl = menuRef.current;
    const rect = el.getBoundingClientRect();

    // Default: anchor the menu to the bottom-right of the trigger.
    let top = rect.bottom + 4;
    let left = Math.max(8, rect.right - minWidth);

    // Clamp inside the viewport so the menu never spills off the right edge
    // or bottom edge of the window — covers the case where the trigger
    // sits near the corner of the app.
    const margin = 8;
    const menuWidth = menuEl?.offsetWidth ?? minWidth;
    const menuHeight = menuEl?.offsetHeight ?? 0;
    if (left + menuWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - menuWidth - margin);
    }
    if (menuHeight > 0 && top + menuHeight > window.innerHeight - margin) {
      // Flip upward if the menu doesn't fit below the trigger.
      const flipped = rect.top - 4 - menuHeight;
      top = flipped >= margin ? flipped : margin;
    }
    setCoords({ top, left });
  }, [minWidth]);

  // Recompute when opening + on window resize/scroll while open.
  useEffect(() => {
    if (!open) return;
    recompute();
    const handler = () => recompute();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [open, recompute]);

  // Click-outside + Esc to close.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (
        target &&
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="shrink-0"
      >
        {triggerIcon}
      </Button>

      {open && coords && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={triggerLabel}
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            minWidth,
            zIndex: 1000,
          }}
          className="rounded-lg border border-border bg-popover py-1 text-sm shadow-md"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                item.variant === "danger"
                  ? "text-destructive hover:bg-destructive/10"
                  : "hover:bg-accent"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => {
                if (item.disabled) return;
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon && (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
                >
                  {item.icon}
                </span>
              )}
              <span className="flex-1 truncate">{item.label}</span>
              {item.trailing && (
                <span
                  aria-hidden="true"
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {item.trailing}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
