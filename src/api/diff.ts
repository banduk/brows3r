/**
 * API module for the diff preview / confirmation framework.
 *
 * Each function wraps exactly one Rust command in `commands/diff_cmd.rs`.
 * Types mirror the Rust serde shapes (camelCase).
 *
 * OCP: adding a new diff kind = one new variant in `DiffPayload` here + one
 * new parse branch in the Rust `diff_cmd.rs`.  This module's structure does
 * not change.
 */

import type { ObjectRef } from "@/api/objects";
import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Opaque identifier for a pending diff record.
 *
 * Serialises as a bare UUID string, e.g.
 * `"550e8400-e29b-41d4-a716-446655440000"`.
 *
 * Mirrors `src-tauri/src/diff/mod.rs` DiffId.
 */
export type DiffId = string;

/**
 * Lifecycle status of a diff record.
 *
 * Mirrors `src-tauri/src/diff/mod.rs` DiffStatus.
 */
export type DiffStatus = "pending" | "confirmed" | "cancelled" | "expired";

/**
 * Discriminated union of all supported diff payload kinds.
 *
 * The `kind` field mirrors the `#[serde(tag = "kind")]` on the Rust enum.
 *
 * OCP: new variants are added as new members of this union.
 *
 * Mirrors `src-tauri/src/diff/mod.rs` DiffPayload.
 */
export type DiffPayload = {
  kind: "storage_class";
  /** The objects whose storage class will be changed. */
  targets: ObjectRef[];
  /** Map of `key → current_storage_class` (from listing / HEAD). */
  current: Record<string, string>;
  /** The new storage class value (e.g. `"GLACIER"`, `"STANDARD_IA"`). */
  newClass: string;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Create a pending diff record and return its `DiffId`.
 *
 * # Parameters
 *
 * - `kind`    — Must be `"storage_class"` in v1.
 * - `payload` — JSON payload matching the schema for the given kind.
 *
 * The backend returns `AppError { kind: "Validation" }` for unsupported kinds.
 *
 * # Usage
 *
 * ```ts
 * const diffId = await diffPreviewCreate("storage_class", {
 *   targets: [{ bucket: "my-bucket", key: "photos/img.jpg" }],
 *   current: { "photos/img.jpg": "STANDARD" },
 *   new_class: "GLACIER",
 * });
 * ```
 *
 * @param kind    - The diff kind string. Currently only `"storage_class"`.
 * @param payload - The diff payload object for the given kind.
 */
export function diffPreviewCreate(
  kind: string,
  payload: Record<string, unknown>,
): Promise<DiffId> {
  return invoke<DiffId>("diff_preview_create", { kind, payload });
}

/**
 * Cancel a pending diff record, voiding any future confirm attempts.
 *
 * After this call, `objectSetStorageClass` (or any other command that uses
 * `confirmedDiffId`) will return a `Validation` error.
 *
 * Returns `AppError { kind: "NotFound" }` when the diff does not exist.
 *
 * @param diffId - The `DiffId` returned by `diffPreviewCreate`.
 */
export function diffPreviewCancel(diffId: DiffId): Promise<void> {
  return invoke<void>("diff_preview_cancel", { diffId });
}
