/**
 * Pure conflict detection for the command registry.
 *
 * `detectConflicts` is a standalone function that wraps `registry.detectConflicts`
 * for callers that prefer a functional interface (e.g. the settings UI, tests).
 *
 * OCP: `ConflictReport` is structured — the settings UI renders it without
 * re-parsing. Adding new conflict categories = extending ConflictReport, not
 * modifying the settings renderer.
 */

import type { ConflictReport, Registry } from "./registry";
import type { Platform } from "./shortcuts";

// Re-export for consumers that import from this module.
export type { ConflictReport };

/**
 * Detect duplicate shortcut bindings in `registry` for the given platform.
 *
 * Returns a structured report. An empty `conflicts` array means no conflicts.
 *
 * This is a pure function over the registry's current state; it does not
 * mutate anything.
 */
export function detectConflicts(
  reg: Registry,
  platform: Platform,
): ConflictReport {
  return reg.detectConflicts(platform);
}
