/**
 * API module for settings commands.
 *
 * Types mirror `src-tauri/src/settings/mod.rs` (camelCase via serde).
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Controls in-app and OS-level notification behaviour. */
export interface NotificationSettings {
  inApp: boolean;
  osEnabled: boolean;
  sound: boolean;
}

/** Confirmation thresholds for destructive / billable operations. */
export interface TransferConfirmations {
  delete: boolean;
  overwrite: boolean;
  largeUploadMb: number;
}

/** Single S3-compatible endpoint entry. */
export interface S3CompatibleEndpoint {
  name: string;
  endpointUrl: string;
  defaultRegion: string;
  compatFlagsTemplate?: Record<string, unknown>;
}

/** Auto-update channel and behaviour. */
export interface AutoUpdateSettings {
  enabled: boolean;
  /** `"stable"` | `"beta"` | `"nightly"` */
  channel: string;
}

/** What the app does on startup. */
export interface StartupBehavior {
  restoreSession: boolean;
  openTo?: string;
}

/**
 * HTTP proxy mode — discriminated union matching Rust `ProxyMode`.
 *
 * `mode` is the serde tag. Rust serializes `ProxyMode::System` as
 * `{ "mode": "system" }`, `Explicit` as `{ "mode": "explicit", "url": "..." }`.
 */
export type ProxyMode =
  | { mode: "system" }
  | { mode: "explicit"; url: string }
  | { mode: "none" };

/** Root settings object. */
export interface Settings {
  schemaVersion: number;
  downloadDir?: string;
  transferConcurrency: number;
  cacheTtlSecs: number;
  cacheSizeCapMb: number;
  previewSizeLimitMb: number;
  defaultViewMode: string;
  notifications: NotificationSettings;
  fallbackThresholdMb: number;
  transferConfirmations: TransferConfirmations;
  s3CompatibleEndpoints: S3CompatibleEndpoint[];
  autoUpdate: AutoUpdateSettings;
  diagnosticsEnabled: boolean;
  startupBehavior: StartupBehavior;
  proxy: ProxyMode;
  theme: string;
  keyboardShortcuts: Record<string, string>;
  /** Forward-compat: unknown keys round-tripped verbatim. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Return the current settings snapshot. */
export function settingsGet(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

/**
 * Apply a partial JSON patch to settings, validate, and persist.
 *
 * Only keys present in `patch` are updated. Pass `force: true` to bypass
 * shortcut-conflict checks (accepted but unused in v1).
 */
export function settingsUpdate(
  patch: Partial<Settings>,
  force?: boolean,
): Promise<Settings> {
  return invoke<Settings>("settings_update", {
    patch,
    force: force ?? null,
  });
}
