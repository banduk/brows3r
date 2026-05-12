/**
 * API module for auto-update commands.
 *
 * Wraps the Rust `updater_check` and `updater_install` commands.
 * Status transitions are also emitted as `updater:status` events (see
 * `TauriEventMap` in `@/lib/tauri`) so the UI can react without polling.
 *
 * OCP: new update commands are additive — one new function here, one new
 * Rust command, one new registration in `lib.rs`.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every state the updater can be in.
 *
 * Mirrors `src-tauri/src/updater/mod.rs` `UpdateStatus`.
 * The `status` field is the discriminant (serde tag).
 */
export type UpdateStatus =
  | { status: "idle" }
  | { status: "checking" }
  | {
      status: "available";
      version: string;
      notes: string | null;
      downloadUrl: string | null;
    }
  | { status: "downloading"; progress: number | null }
  | { status: "ready" }
  | { status: "upToDate" }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// updaterCheck
// ---------------------------------------------------------------------------

/**
 * Ask the backend to check for a newer release.
 *
 * The backend also emits `updater:status` events at each transition.
 * Returns the final `UpdateStatus` directly for callers who prefer a
 * synchronous result.
 */
export async function updaterCheck(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("updater_check");
}

// ---------------------------------------------------------------------------
// updaterInstall
// ---------------------------------------------------------------------------

/**
 * Download and install the pending update.
 *
 * Should only be called after `updaterCheck` returned `{ status: "available" }`.
 * The backend emits `updater:status` events during download and when ready.
 */
export async function updaterInstall(): Promise<void> {
  return invoke<void>("updater_install");
}

// ---------------------------------------------------------------------------
// updaterRestart
// ---------------------------------------------------------------------------

/**
 * Restart the application process so a staged update takes effect.
 *
 * Should be called after `updaterInstall` resolves (the backend emits
 * `{ status: "ready" }` at that point). Calling this terminates the
 * current process — the function never returns from the caller's
 * perspective.
 */
export async function updaterRestart(): Promise<void> {
  return invoke<void>("updater_restart");
}
