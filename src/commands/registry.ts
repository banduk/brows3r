/**
 * Command registry — single source of truth for all app commands.
 *
 * OCP: adding a new command = one `registry.register(def)` call in the
 * matching file under `definitions/`. No other changes required.
 *
 * The registry is singleton-friendly:
 * - `createRegistry()` — factory for isolated instances (tests, previews).
 * - `registry` — default app-level singleton.
 */

import type { Platform, ShortcutKey } from "./shortcuts";
import { platformShortcut } from "./shortcuts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to every command handler.
 *
 * Intentionally minimal for v1. Future tasks add fields (pane, selection,
 * focused element) without breaking existing definitions.
 */
export interface CommandContext {
  // Extensible: pane id, selection, active profile — start minimal.
  [key: string]: unknown;
}

/**
 * A single registered command.
 *
 * OCP: optional fields (`enabled`, `description`, `defaultShortcut`) can be
 * added to existing definitions without breaking lookup or conflict detection.
 */
export interface CommandDef {
  /** Unique stable id, e.g. "profile.add", "view.column". */
  id: string;
  /** Human-readable title used in the command palette. */
  title: string;
  /** Grouping label for the palette and menus, e.g. "Profile", "View". */
  group: string;
  /** Optional longer description shown in the palette detail view. */
  description?: string;
  /**
   * Default keyboard shortcut.
   * Plain ShortcutKey: same on all platforms.
   * Object with mac/default: platform-resolved by lookupByShortcut.
   */
  defaultShortcut?: ShortcutKey | { mac: ShortcutKey; default: ShortcutKey };
  /** Optional gate; when present and returning false, the command is inactive. */
  enabled?: (ctx: CommandContext) => boolean;
  /** The action to run. May be async (fire-and-forget; errors should be caught internally). */
  run: (ctx: CommandContext) => void | Promise<void>;
}

/**
 * Result of conflict detection.
 *
 * Structured so the settings UI can render it without re-parsing.
 */
export interface ConflictReport {
  conflicts: Array<{
    shortcut: ShortcutKey;
    commandIds: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

export interface Registry {
  /** Register a command. Throws if the id is already registered. */
  register(def: CommandDef): void;
  /** Look up a command by id. Returns undefined when not found. */
  lookupById(id: string): CommandDef | undefined;
  /**
   * Look up a command whose defaultShortcut matches the given shortcut on
   * the given platform. Returns undefined when no match.
   */
  lookupByShortcut(
    shortcut: ShortcutKey,
    platform: Platform,
  ): CommandDef | undefined;
  /** All registered commands in registration order. */
  all(): CommandDef[];
  /** Commands belonging to a group. */
  byGroup(group: string): CommandDef[];
  /**
   * Return all shortcut conflicts (same resolved shortcut → multiple commands)
   * for a given platform.
   */
  detectConflicts(platform: Platform): ConflictReport;
}

/**
 * Compare two ShortcutKey values for equality.
 * Used internally by lookupByShortcut and detectConflicts.
 */
function shortcutEqual(a: ShortcutKey, b: ShortcutKey): boolean {
  if (a.key !== b.key) return false;

  const aMods = [...(a.mod ?? [])].sort();
  const bMods = [...(b.mod ?? [])].sort();

  if (aMods.length !== bMods.length) return false;
  return aMods.every((m, i) => m === bMods[i]);
}

/** Serialize a ShortcutKey to a stable string key for map lookups. */
function shortcutKey(s: ShortcutKey): string {
  const mods = [...(s.mod ?? [])].sort().join("+");
  return mods.length > 0 ? `${mods}+${s.key}` : s.key;
}

/**
 * Resolve the platform binding for a CommandDef's defaultShortcut.
 * Returns undefined when the def has no defaultShortcut.
 */
function resolveShortcut(
  def: CommandDef,
  platform: Platform,
): ShortcutKey | undefined {
  if (def.defaultShortcut === undefined) return undefined;

  if ("mac" in def.defaultShortcut && "default" in def.defaultShortcut) {
    return platformShortcut(
      def.defaultShortcut as { mac: ShortcutKey; default: ShortcutKey },
      platform,
    );
  }

  // Plain ShortcutKey: same on all platforms.
  return def.defaultShortcut as ShortcutKey;
}

/**
 * Create a new isolated registry instance.
 *
 * Prefer this in tests so each suite starts clean.
 */
export function createRegistry(): Registry {
  const defs = new Map<string, CommandDef>();

  function register(def: CommandDef): void {
    if (defs.has(def.id)) {
      throw new Error(
        `Command "${def.id}" is already registered. Each id must be unique.`,
      );
    }
    defs.set(def.id, def);
  }

  function lookupById(id: string): CommandDef | undefined {
    return defs.get(id);
  }

  function lookupByShortcut(
    shortcut: ShortcutKey,
    platform: Platform,
  ): CommandDef | undefined {
    for (const def of defs.values()) {
      const resolved = resolveShortcut(def, platform);
      if (resolved !== undefined && shortcutEqual(resolved, shortcut)) {
        return def;
      }
    }
    return undefined;
  }

  function all(): CommandDef[] {
    return [...defs.values()];
  }

  function byGroup(group: string): CommandDef[] {
    return [...defs.values()].filter((d) => d.group === group);
  }

  function detectConflicts(platform: Platform): ConflictReport {
    // Group command ids by their resolved shortcut key string.
    const buckets = new Map<string, string[]>();

    for (const def of defs.values()) {
      const resolved = resolveShortcut(def, platform);
      if (resolved === undefined) continue;

      const k = shortcutKey(resolved);
      const bucket = buckets.get(k);
      if (bucket !== undefined) {
        bucket.push(def.id);
      } else {
        buckets.set(k, [def.id]);
      }
    }

    // Build report: only entries with >1 command are conflicts.
    const conflicts: ConflictReport["conflicts"] = [];

    for (const [, ids] of buckets.entries()) {
      if (ids.length < 2) continue;

      // Reconstruct the ShortcutKey from the first matching def.
      const firstId = ids[0];
      if (firstId === undefined) continue;
      const firstDef = defs.get(firstId);
      if (firstDef === undefined) continue;
      const resolved = resolveShortcut(firstDef, platform);
      if (resolved === undefined) continue;

      conflicts.push({ shortcut: resolved, commandIds: ids });
    }

    return { conflicts };
  }

  return {
    register,
    lookupById,
    lookupByShortcut,
    all,
    byGroup,
    detectConflicts,
  };
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

/**
 * App-level registry singleton.
 *
 * Definition files under `src/commands/definitions/` call
 * `registry.register(def)` at module load time.
 */
export const registry: Registry = createRegistry();
