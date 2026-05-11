/**
 * Keyboard shortcut types, baseline shortcut map, and platform helpers.
 *
 * The baseline map is the verbatim source of truth for proposal.md lines
 * 175-176. The cross-layer snapshot test at
 * `src/commands/__tests__/baseline-shortcuts.snapshot.test.ts` asserts that
 * this map deeply equals the fixture at
 * `src/commands/__fixtures__/baseline-shortcuts.proposal.json`.
 *
 * OCP: adding a new shortcut = adding one entry to BASELINE_SHORTCUTS.
 * Changing platform resolution = one edit to platformShortcut.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported modifier keys. */
export type Modifier = "cmd" | "ctrl" | "alt" | "shift" | "meta";

/**
 * A single keyboard shortcut.
 *
 * `mod` lists all required modifier keys. `key` is the canonical key name
 * (e.g. "1", "ArrowUp", "k", "F", "Enter", "Backspace", "Delete").
 *
 * `mod` accepts both mutable and readonly arrays to be compatible with
 * `as const` usage in tests and inline literals.
 */
export interface ShortcutKey {
  mod?: ReadonlyArray<Modifier>;
  key: string;
}

/**
 * Platform identifier.
 *
 * OCP: adding a new platform (e.g. "web") = adding one literal here and
 * one branch in platformShortcut.
 */
export type Platform = "mac" | "win" | "linux";

/**
 * A shortcut that differs between macOS and other platforms.
 */
export interface PlatformShortcut {
  mac: ShortcutKey;
  default: ShortcutKey;
}

// ---------------------------------------------------------------------------
// Baseline shortcut map
// ---------------------------------------------------------------------------

/**
 * Baseline shortcut bindings keyed by command id.
 *
 * Source: proposal.md lines 175-176.
 * Verbatim mapping:
 *   arrows move selection, Enter opens, Space previews, Backspace navigates
 *   up, Delete deletes, Cmd/Ctrl+C copies, Cmd/Ctrl+X moves,
 *   Cmd/Ctrl+V pastes, Cmd/Ctrl+A selects all, Cmd/Ctrl+F searches,
 *   Cmd/Ctrl+R refreshes, Cmd/Ctrl+Shift+P opens command palette,
 *   Cmd/Ctrl+1-7 switches view modes,
 *   Cmd/Ctrl+Option/Alt+Left/Right switches panes.
 */
export const BASELINE_SHORTCUTS: Record<string, PlatformShortcut> = {
  "view.cursor.up": {
    mac: { key: "ArrowUp" },
    default: { key: "ArrowUp" },
  },
  "view.cursor.down": {
    mac: { key: "ArrowDown" },
    default: { key: "ArrowDown" },
  },
  "view.cursor.left": {
    mac: { key: "ArrowLeft" },
    default: { key: "ArrowLeft" },
  },
  "view.cursor.right": {
    mac: { key: "ArrowRight" },
    default: { key: "ArrowRight" },
  },
  "file.open": {
    mac: { key: "Enter" },
    default: { key: "Enter" },
  },
  "preview.toggle": {
    mac: { key: "Space" },
    default: { key: "Space" },
  },
  "view.navigate.up": {
    mac: { key: "Backspace" },
    default: { key: "Backspace" },
  },
  "file.delete": {
    mac: { key: "Delete" },
    default: { key: "Delete" },
  },
  "clipboard.copy": {
    mac: { mod: ["cmd"], key: "c" },
    default: { mod: ["ctrl"], key: "c" },
  },
  "clipboard.cut": {
    mac: { mod: ["cmd"], key: "x" },
    default: { mod: ["ctrl"], key: "x" },
  },
  "clipboard.paste": {
    mac: { mod: ["cmd"], key: "v" },
    default: { mod: ["ctrl"], key: "v" },
  },
  "selection.all": {
    mac: { mod: ["cmd"], key: "a" },
    default: { mod: ["ctrl"], key: "a" },
  },
  "search.local": {
    mac: { mod: ["cmd"], key: "f" },
    default: { mod: ["ctrl"], key: "f" },
  },
  "view.refresh": {
    mac: { mod: ["cmd"], key: "r" },
    default: { mod: ["ctrl"], key: "r" },
  },
  "palette.open": {
    mac: { mod: ["cmd", "shift"], key: "p" },
    default: { mod: ["ctrl", "shift"], key: "p" },
  },
  "view.mode.details": {
    mac: { mod: ["cmd"], key: "1" },
    default: { mod: ["ctrl"], key: "1" },
  },
  "view.mode.icon": {
    mac: { mod: ["cmd"], key: "2" },
    default: { mod: ["ctrl"], key: "2" },
  },
  "view.mode.gallery": {
    mac: { mod: ["cmd"], key: "3" },
    default: { mod: ["ctrl"], key: "3" },
  },
  "view.mode.column": {
    mac: { mod: ["cmd"], key: "4" },
    default: { mod: ["ctrl"], key: "4" },
  },
  "view.mode.tree": {
    mac: { mod: ["cmd"], key: "5" },
    default: { mod: ["ctrl"], key: "5" },
  },
  "view.mode.flat": {
    mac: { mod: ["cmd"], key: "6" },
    default: { mod: ["ctrl"], key: "6" },
  },
  "view.mode.dual": {
    mac: { mod: ["cmd"], key: "7" },
    default: { mod: ["ctrl"], key: "7" },
  },
  "nav.back": {
    mac: { mod: ["cmd", "alt"], key: "ArrowLeft" },
    default: { mod: ["ctrl", "alt"], key: "ArrowLeft" },
  },
  "nav.forward": {
    mac: { mod: ["cmd", "alt"], key: "ArrowRight" },
    default: { mod: ["ctrl", "alt"], key: "ArrowRight" },
  },
};

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the correct ShortcutKey for the current platform.
 *
 * macOS → mac binding; everything else → default binding.
 */
export function platformShortcut(
  binding: PlatformShortcut,
  platform: Platform,
): ShortcutKey {
  return platform === "mac" ? binding.mac : binding.default;
}

/**
 * Format a ShortcutKey for UI display.
 *
 * macOS uses Unicode symbols (⌘, ⌥, ⌃, ⇧). Other platforms use text labels.
 */
export function formatShortcut(
  shortcut: ShortcutKey,
  platform: Platform,
): string {
  const mods = shortcut.mod ?? [];
  const isMac = platform === "mac";

  const macModSymbols: Record<Modifier, string> = {
    cmd: "⌘",
    meta: "⌘",
    ctrl: "⌃",
    alt: "⌥",
    shift: "⇧",
  };
  const winModSymbols: Record<Modifier, string> = {
    cmd: "Cmd",
    meta: "Cmd",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
  };
  const modSymbols = isMac ? macModSymbols : winModSymbols;
  const modStr = mods.map((m) => modSymbols[m]).join(isMac ? "" : "+");

  const keyStr = formatKey(shortcut.key, isMac);

  if (modStr.length === 0) {
    return keyStr;
  }

  return isMac ? `${modStr}${keyStr}` : `${modStr}+${keyStr}`;
}

function formatKey(key: string, isMac: boolean): string {
  switch (key) {
    case "ArrowUp":
      return isMac ? "↑" : "Up";
    case "ArrowDown":
      return isMac ? "↓" : "Down";
    case "ArrowLeft":
      return isMac ? "←" : "Left";
    case "ArrowRight":
      return isMac ? "→" : "Right";
    case "Enter":
      return isMac ? "↩" : "Enter";
    case "Backspace":
      return isMac ? "⌫" : "Backspace";
    case "Delete":
      return isMac ? "⌦" : "Delete";
    case "Space":
      return "Space";
    case "Escape":
      return isMac ? "⎋" : "Esc";
    default:
      // Single letter → uppercase for display.
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Parse a shortcut string back into a ShortcutKey.
 *
 * Accepted formats:
 *   - "ArrowUp"          → { key: "ArrowUp" }
 *   - "Ctrl+K"           → { mod: ["ctrl"], key: "k" }
 *   - "Cmd+Shift+P"      → { mod: ["cmd", "shift"], key: "p" }
 *   - "⌘⇧P"             → { mod: ["cmd", "shift"], key: "p" }
 *
 * Throws if the string is empty or cannot be parsed.
 */
export function parseShortcut(str: string): ShortcutKey {
  if (str.trim().length === 0) {
    throw new Error("Cannot parse empty shortcut string");
  }

  // Detect Unicode symbol format (mac display format).
  if (/[⌘⌥⌃⇧]/.test(str)) {
    return parseMacSymbols(str);
  }

  // Text format: "Ctrl+Shift+P"
  const parts = str.split("+").map((p) => p.trim());
  const mods: Modifier[] = [];
  const keyParts: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "cmd" || lower === "command") {
      mods.push("cmd");
    } else if (lower === "ctrl" || lower === "control") {
      mods.push("ctrl");
    } else if (lower === "alt" || lower === "option") {
      mods.push("alt");
    } else if (lower === "shift") {
      mods.push("shift");
    } else if (lower === "meta") {
      mods.push("meta");
    } else {
      keyParts.push(part);
    }
  }

  if (keyParts.length === 0) {
    throw new Error(`No key found in shortcut string: "${str}"`);
  }

  const key =
    keyParts[0] !== undefined && keyParts[0].length === 1
      ? keyParts[0].toLowerCase()
      : (keyParts[0] ?? "");

  return mods.length > 0 ? { mod: mods, key } : { key };
}

function parseMacSymbols(str: string): ShortcutKey {
  const mods: Modifier[] = [];
  let remaining = str;

  if (remaining.includes("⌘")) {
    mods.push("cmd");
    remaining = remaining.replace("⌘", "");
  }
  if (remaining.includes("⌃")) {
    mods.push("ctrl");
    remaining = remaining.replace("⌃", "");
  }
  if (remaining.includes("⌥")) {
    mods.push("alt");
    remaining = remaining.replace("⌥", "");
  }
  if (remaining.includes("⇧")) {
    mods.push("shift");
    remaining = remaining.replace("⇧", "");
  }

  const key = remaining.length === 1 ? remaining.toLowerCase() : remaining;

  if (key.length === 0) {
    throw new Error(`No key found in mac symbol string: "${str}"`);
  }

  return mods.length > 0 ? { mod: mods, key } : { key };
}
