/**
 * API module for diagnostics bundle commands.
 *
 * Wraps the Rust `diagnostics_collect` and `diagnostics_export` commands.
 * The frontend holds a `BundleRef` between the two steps — it is never
 * serialised to a remote endpoint (privacy guarantee: you control where it goes).
 *
 * OCP: new diagnostics commands are additive — one new function here, one new
 * Rust command, one new registration in `lib.rs`.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How aggressively credentials and paths are redacted.
 *
 * Mirrors `src-tauri/src/diagnostics/redact.rs` `RedactionLevel`.
 */
export type RedactionLevel = "Full" | "Partial" | "None";

/**
 * Controls which categories of data are included in the bundle.
 *
 * Mirrors `src-tauri/src/diagnostics/bundle.rs` `BundleConfig`.
 * All fields default to `true` on the Rust side.
 */
export interface BundleConfig {
  includeRecentErrors: boolean;
  redactionLevel: RedactionLevel;
  includeLogs: boolean;
  includeSettings: boolean;
  includeProfilesMetadata: boolean;
}

/**
 * Reference to a collected (but not yet exported) bundle.
 *
 * Mirrors `src-tauri/src/diagnostics/bundle.rs` `BundleRef`.
 * The `path` is an absolute path to the ZIP on the local filesystem.
 */
export interface BundleRef {
  id: string;
  path: string;
  sizeBytes: number;
  redactionApplied: boolean;
}

// ---------------------------------------------------------------------------
// diagnosticsCollect
// ---------------------------------------------------------------------------

/**
 * Collect a diagnostic bundle from app files according to `config`.
 *
 * Returns a `BundleRef` that the UI holds between the "Generate" and "Save"
 * steps.  The ZIP is never sent anywhere automatically.
 */
export async function diagnosticsCollect(
  config: BundleConfig,
): Promise<BundleRef> {
  return invoke<BundleRef>("diagnostics_collect", { config });
}

// ---------------------------------------------------------------------------
// diagnosticsExport
// ---------------------------------------------------------------------------

/**
 * Copy the collected bundle ZIP to `destPath` and remove the temp dir.
 *
 * `bundleRef` must be the value returned by a preceding `diagnosticsCollect`
 * call.  After a successful export the caller can show a success notification
 * with the destination path.
 */
export async function diagnosticsExport(
  bundleRef: BundleRef,
  destPath: string,
): Promise<void> {
  return invoke<void>("diagnostics_export", {
    bundleRef,
    destPath,
  });
}
