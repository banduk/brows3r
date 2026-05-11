/**
 * Command Palette modal.
 *
 * Opens on Cmd/Ctrl+K (via usePaletteShortcut).
 * Displays fuzzy-filtered registry commands with keyboard navigation.
 *
 * A11y: combobox/listbox roles, aria-activedescendant, sr-only title.
 * An aria-live="polite" visually-hidden region announces result count changes
 * to screen readers as the user types ("3 commands match").
 * Focus trap is handled by shadcn's Dialog (Radix UI).
 */

import { useCallback, useEffect, useRef } from "react";
import type { CommandContext } from "@/commands/registry";
import type { Platform } from "@/commands/shortcuts";
import { formatShortcut } from "@/commands/shortcuts";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useCommandPaletteStore } from "@/store/command_palette";

// ---------------------------------------------------------------------------
// Platform detection helper
// ---------------------------------------------------------------------------

function detectPlatform(): Platform {
  return navigator.platform.startsWith("Mac") ? "mac" : "win";
}

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  ctx?: CommandContext;
}

export function CommandPalette({ ctx = {} }: CommandPaletteProps) {
  const open = useCommandPaletteStore((s) => s.open);
  const query = useCommandPaletteStore((s) => s.query);
  const focusedIndex = useCommandPaletteStore((s) => s.focusedIndex);
  const results = useCommandPaletteStore((s) => s.results);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const focusNext = useCommandPaletteStore((s) => s.focusNext);
  const focusPrev = useCommandPaletteStore((s) => s.focusPrev);
  const executeFocused = useCommandPaletteStore((s) => s.executeFocused);

  const inputRef = useRef<HTMLInputElement>(null);
  const platform = detectPlatform();

  // Autofocus the input when the palette opens.
  useEffect(() => {
    if (open) {
      // Small defer so Dialog animation doesn't fight focus.
      const id = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusPrev();
      } else if (e.key === "Enter") {
        e.preventDefault();
        executeFocused(ctx);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    },
    [focusNext, focusPrev, executeFocused, closePalette, ctx],
  );

  const activeDescendantId =
    results.length > 0 ? `cp-result-${focusedIndex.toString()}` : undefined;

  // Compute an announcement for the aria-live region.
  // Announced on every query change so screen readers hear the count.
  const announcement =
    results.length === 0
      ? query.length > 0
        ? "No commands match"
        : ""
      : results.length === 1
        ? "1 command matches"
        : `${results.length.toString()} commands match`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closePalette()}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 max-w-xl"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        {/* sr-only title for a11y */}
        <DialogTitle className="sr-only">Command Palette</DialogTitle>

        {/* Live region — announces result count changes to screen readers.
            Visually hidden; polite so it does not interrupt the user. */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {open ? announcement : ""}
        </div>

        {/* Search input */}
        <div className="flex items-center border-b px-3">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="cp-listbox"
            aria-activedescendant={activeDescendantId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Type a command..."
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>

        <ul
          id="cp-listbox"
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto py-1"
        >
          {results.length === 0 && (
            <li
              role="option"
              aria-selected={false}
              tabIndex={-1}
              className="py-6 text-center text-sm text-muted-foreground"
            >
              No commands match
              {query.length > 0 && (
                <span className="block mt-1 text-xs opacity-70">
                  Try a different search term
                </span>
              )}
            </li>
          )}

          {results.map((def, idx) => {
            const isFocused = idx === focusedIndex;
            const shortcutStr =
              def.defaultShortcut !== undefined
                ? (() => {
                    const resolved =
                      "mac" in def.defaultShortcut &&
                      "default" in def.defaultShortcut
                        ? platform === "mac"
                          ? def.defaultShortcut.mac
                          : def.defaultShortcut.default
                        : def.defaultShortcut;
                    return formatShortcut(resolved, platform);
                  })()
                : undefined;

            return (
              <li
                key={def.id}
                id={`cp-result-${idx.toString()}`}
                role="option"
                aria-selected={isFocused}
                tabIndex={-1}
                className={[
                  "flex items-center justify-between px-4 py-2 cursor-pointer text-sm select-none",
                  isFocused
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                ].join(" ")}
                onMouseEnter={() => {
                  // Sync focused index on hover without triggering re-filter.
                  useCommandPaletteStore.setState({ focusedIndex: idx });
                }}
                onClick={() => executeFocused(ctx)}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="truncate font-medium">{def.title}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {def.group}
                  </span>
                </div>
                {shortcutStr !== undefined && (
                  <kbd className="ml-4 shrink-0 text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    {shortcutStr}
                  </kbd>
                )}
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
