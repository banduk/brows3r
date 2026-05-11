/**
 * Disabled-state copy helpers for inspector controls.
 *
 * Centralises all AC-5 disabled-reason strings so every surface that needs to
 * explain why a property is unavailable uses the same phrasing.
 *
 * OCP: adding a new disabled reason = one new exported function here.
 * Callers import the specific function they need; the rest are tree-shaken.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the copy to show when an IAM policy denied access.
 *
 * Example: "Requires s3:GetBucketVersioning"
 */
export function disabledForDenied(iamAction: string): string {
  return `Requires ${iamAction}`;
}

/**
 * Returns the copy to show when the provider does not implement the API.
 *
 * Example: "Not available on this provider"
 */
export function disabledForUnsupported(_reason?: string): string {
  return "Not available on this provider";
}

/**
 * Returns the copy to show when a property was intentionally deferred from v1.
 *
 * Example: "Deferred from v1"
 */
export function disabledForDeferred(_reason: string): string {
  return "Deferred from v1";
}

/**
 * Returns the copy to show when the operation is unavailable due to the
 * object's storage class.
 *
 * Example: "Not available for GLACIER"
 */
export function disabledForStorageClass(storageClass: string): string {
  return `Not available for ${storageClass}`;
}
