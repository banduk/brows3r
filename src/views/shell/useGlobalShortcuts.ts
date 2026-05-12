/**
 * Global keyboard-shortcut dispatcher.
 *
 * Walks every command registered with `defaultShortcut` and binds it as a
 * window-level keydown handler. Replaces the per-command hooks
 * (`usePaletteShortcut`, `useInspectorShortcut`, `useNavShortcuts`) so the
 * registry is the single source of truth for "what keystroke runs what
 * command".
 *
 * Behaviour:
 *
 * - Modifier match is exact: `mod: ["cmd"]` requires `metaKey` (Mac) /
 *   `ctrlKey` (everything else) AND no other modifier. This avoids
 *   stealing e.g. Cmd+Shift+R when the user expects a different binding.
 * - The current pane's `profileId` / `bucket` / `prefix` / `selection` and
 *   the shared TanStack `QueryClient` are threaded into the `ctx` so file
 *   commands (`file.copy`, `file.delete`, …) work the same as when they
 *   are dispatched from a button.
 * - Skipped when focus is in an editable element (input, textarea,
 *   contenteditable) UNLESS the modifier is a real "global" modifier
 *   (Cmd/Ctrl + key) — that way typing "1" in a search box does not fire
 *   `view.mode.details`, but Cmd+R still refreshes from anywhere.
 *
 * OCP: add a `defaultShortcut` to any registered command and it
 * immediately becomes globally dispatchable. No edits required here.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { registry } from "@/commands/registry";
import type { Modifier, Platform, ShortcutKey } from "@/commands/shortcuts";
import { platformShortcut } from "@/commands/shortcuts";
import { usePanesStore } from "@/store/panes";

/** Resolve a registry `defaultShortcut` (either plain or platform-tagged) for the runtime platform. */
function resolveDefaultShortcut(
  def: NonNullable<import("@/commands/registry").CommandDef["defaultShortcut"]>,
  platform: Platform,
): ShortcutKey {
  if ("mac" in def) {
    return platformShortcut(def, platform);
  }
  return def;
}

function isMacPlatform(): boolean {
  return navigator.platform.startsWith("Mac");
}

function currentPlatform(): Platform {
  return isMacPlatform() ? "mac" : "win";
}

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

/**
 * Normalize a KeyboardEvent's "key" value so it matches the registry's
 * `defaultShortcut.key`. The registry uses single-character lowercase
 * (`"r"`, `"k"`) for letter keys and the literal DOM key for the rest
 * (`"ArrowUp"`, `"F2"`, `"Enter"`, `"["`).
 */
function normalizeKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  return key;
}

/**
 * Check that the keyboard event's modifier set matches the shortcut's
 * declared modifiers exactly — no extras, no missing.
 */
function modifiersMatch(
  event: KeyboardEvent,
  mods: ReadonlyArray<Modifier>,
): boolean {
  const isMac = isMacPlatform();
  // "cmd" → Meta on Mac, Control elsewhere. Same convention the per-command
  // hooks used; keeps Cmd-based shortcuts portable to Linux/Windows users
  // who hold Ctrl in the same role.
  const expectCmd = mods.includes("cmd");
  const expectCtrl = mods.includes("ctrl");
  const expectAlt = mods.includes("alt");
  const expectShift = mods.includes("shift");
  const expectMeta = mods.includes("meta");

  const wantMeta = (isMac && expectCmd) || expectMeta;
  const wantCtrl = (!isMac && expectCmd) || expectCtrl;

  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== expectAlt) return false;
  if (event.shiftKey !== expectShift) return false;
  return true;
}

/**
 * Whether the shortcut should fire while focus is in an editable element.
 *
 * Rules:
 *
 * - Bare keys (no modifier) — always skipped so they don't steal
 *   characters typed into inputs.
 * - Cmd/Ctrl + single letter (`a`, `c`, `x`, `v`, `z`, `y`, `s`, …) —
 *   skipped so the browser's native text-edit shortcuts continue to
 *   work (Cmd+C copy in a textarea, Cmd+A select-all, etc.). The app's
 *   own file commands sharing those bindings only fire when focus is
 *   outside an editable element.
 * - Cmd/Ctrl + non-letter (digit, F-key, ArrowKey, special char) —
 *   fires even from editable focus (Cmd+1 view mode, Cmd+R refresh
 *   via `key === "r"` is the one letter exception that goes through
 *   this branch by being letter — see comment below).
 *
 * `r`/`f`/`p` would also qualify as letters but they are rare-conflict
 * keys: Cmd+R is browser reload (which we want to remap to refresh
 * data), Cmd+F is "find" (open app search), Cmd+P is "palette".
 * Keeping the strict "skip letters" rule loses Cmd+R-from-input — a
 * minor cost; users can click out before refreshing.
 */
function shortcutSurvivesEditableFocus(shortcut: ShortcutKey): boolean {
  const mods = shortcut.mod ?? [];
  if (mods.length === 0) return false;
  const isLetterKey =
    shortcut.key.length === 1 && /[a-zA-Z]/.test(shortcut.key);
  if (isLetterKey) return false;
  return mods.includes("cmd") || mods.includes("ctrl") || mods.includes("meta");
}

export function useGlobalShortcuts(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const eventKey = normalizeKey(event.key);

      // Walk the registry once per keystroke. The registry is small
      // (~30 commands) so this is cheap; if it ever grows past ~hundreds
      // we can pre-index by `key`.
      const platform = currentPlatform();
      for (const cmd of registry.all()) {
        if (!cmd.defaultShortcut) continue;
        const shortcut = resolveDefaultShortcut(cmd.defaultShortcut, platform);
        if (normalizeKey(shortcut.key) !== eventKey) continue;
        const expectedMods = shortcut.mod ?? [];
        if (!modifiersMatch(event, expectedMods)) continue;

        if (
          isEditableElement(event.target) &&
          !shortcutSurvivesEditableFocus(shortcut)
        ) {
          // The user is typing — don't intercept bare keys / letter
          // shortcuts so the browser's text-edit defaults still work.
          continue;
        }

        event.preventDefault();
        event.stopPropagation();

        // Build a context snapshot from the active pane so file commands
        // (`file.copy`, `file.delete`, …) receive the same `ctx` shape
        // they get from button clicks. Commands that don't need any of
        // these fields ignore them.
        const panes = usePanesStore.getState();
        const pane = panes.panes.find((p) => p.id === panes.activePaneId);
        const ctx: Record<string, unknown> = {
          profileId: pane?.location?.profileId,
          bucket: pane?.location?.bucket,
          prefix: pane?.location?.prefix ?? "",
          keys: Array.from(pane?.selection ?? []),
          queryClient,
        };

        void cmd.run(ctx);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [queryClient]);
}
