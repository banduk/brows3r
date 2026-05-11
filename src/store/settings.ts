/**
 * Zustand store for app settings.
 *
 * Mirrors `Settings` from the backend (`src-tauri/src/settings/mod.rs`).
 * - Loads via `settingsGet()` on first use.
 * - Persists via `settingsUpdate(patch)`.
 * - Local optimistic update on form change; rollback on backend error.
 * - Provides a stub for future settings-change subscription.
 *
 * OCP: adding a new setting = one field in `Settings` (src/api/settings.ts)
 * and one action here if it needs special handling.
 */

import { create } from "zustand";
import { type Settings, settingsGet, settingsUpdate } from "@/api/settings";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  downloadDir: undefined,
  transferConcurrency: 4,
  cacheTtlSecs: 300,
  cacheSizeCapMb: 256,
  previewSizeLimitMb: 50,
  defaultViewMode: "Details",
  notifications: {
    inApp: true,
    osEnabled: true,
    sound: false,
  },
  fallbackThresholdMb: 100,
  transferConfirmations: {
    delete: true,
    overwrite: true,
    largeUploadMb: 1024,
  },
  s3CompatibleEndpoints: [],
  autoUpdate: {
    enabled: true,
    channel: "stable",
  },
  diagnosticsEnabled: false,
  startupBehavior: {
    restoreSession: true,
    openTo: undefined,
  },
  proxy: { mode: "system" },
  theme: "system",
  keyboardShortcuts: {},
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SettingsState {
  /** Current settings snapshot. `null` means not yet loaded. */
  settings: Settings | null;
  /** Whether the initial load is in progress. */
  loading: boolean;
  /** Error from the last backend call, if any. */
  error: string | null;

  /** Load settings from the backend. No-op if already loaded. */
  load(): Promise<void>;

  /**
   * Apply a partial patch optimistically, persist via `settingsUpdate`.
   * Rolls back to the previous snapshot if the backend rejects the change.
   */
  update(patch: Partial<Settings>): Promise<void>;

  /** Reset a single panel's fields to the DEFAULT_SETTINGS values. */
  resetPanel(patch: Partial<Settings>): Promise<void>;

  /** Reset all settings to defaults. */
  resetAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,
  error: null,

  async load() {
    if (get().settings !== null || get().loading) return;
    set({ loading: true, error: null });
    try {
      const settings = await settingsGet();
      set({ settings, loading: false });
    } catch (err: unknown) {
      const msg =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : "Failed to load settings";
      set({ loading: false, error: msg });
    }
  },

  async update(patch: Partial<Settings>) {
    const previous = get().settings;
    // Optimistic update.
    set((s) => ({
      settings: s.settings !== null ? { ...s.settings, ...patch } : s.settings,
      error: null,
    }));
    try {
      const updated = await settingsUpdate(patch);
      set({ settings: updated });
    } catch (err: unknown) {
      // Rollback on error.
      set({ settings: previous });
      const msg =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : "Failed to save settings";
      set({ error: msg });
      throw err;
    }
  },

  async resetPanel(patch: Partial<Settings>) {
    await get().update(patch);
  },

  async resetAll() {
    await get().update(DEFAULT_SETTINGS);
  },
}));
