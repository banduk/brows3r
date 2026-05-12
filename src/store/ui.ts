/**
 * UI state slice — persisted to localStorage.
 *
 * Covers theme, sidebar geometry, default view mode, and the last-visited
 * location. Every subsequent layout or navigation widget reads from this
 * slice so user preferences survive across sessions.
 *
 * OCP: adding a new persisted setting = one field + one action.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The seven view modes available in the file list area. */
export type ViewMode =
  | "Details"
  | "IconGrid"
  | "Gallery"
  | "Column"
  | "Tree"
  | "FlatKey"
  | "DualPane";

/**
 * Per-user preferences for text/code previews (Shiki view and Monaco editor).
 * Both surfaces read from the same slice so toggling word-wrap or font-size
 * is consistent whether the user is viewing or editing.
 *
 * `themeOverride` of `"auto"` follows the global UI theme; explicit `"light"`
 * or `"dark"` keeps a per-preview override.
 */
export interface TextPreviewPrefs {
  themeOverride: "auto" | "light" | "dark";
  wordWrap: boolean;
  fontSize: number;
  lineNumbers: boolean;
}

export const DEFAULT_TEXT_PREVIEW_PREFS: TextPreviewPrefs = {
  themeOverride: "auto",
  wordWrap: true,
  fontSize: 13,
  lineNumbers: false,
};

const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 28;

/**
 * User-resizable column widths (pixels) for the file list table. The Name
 * column flexes to fill remaining space; the other three are explicit.
 *
 * Stored here rather than as Tailwind classes so the user can drag them
 * narrower when names are long.
 */
export interface DetailsColumnWidths {
  size: number;
  modified: number;
  storageClass: number;
}

export const DEFAULT_DETAILS_COLUMN_WIDTHS: DetailsColumnWidths = {
  size: 80,
  modified: 112,
  storageClass: 96,
};

const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 400;

/** Minimal representation of an S3 location (profile + bucket + prefix). */
export interface S3Location {
  profileId: string;
  bucket: string | null;
  /** Prefix always ends with "/" for directory-like scopes, or "" for root. */
  prefix: string;
}

// ---------------------------------------------------------------------------
// State + actions
// ---------------------------------------------------------------------------

/** Clamp a percentage to a sane resizable-panel range. */
function clampPct(pct: number, min: number, max: number): number {
  if (!Number.isFinite(pct)) return min;
  return Math.max(min, Math.min(max, pct));
}

interface UiState {
  theme: "light" | "dark" | "system";
  sidebarCollapsed: boolean;
  /**
   * Sidebar width as a percentage of the layout (10-50). Stored as percent
   * because react-resizable-panels v4 works in percentages and the
   * container width is unknown at store-init time.
   */
  sidebarPct: number;
  /** Preview width as a percentage of the layout (15-50). */
  previewPct: number;
  /** When `true` the preview pane is collapsed and not rendered. */
  previewCollapsed: boolean;
  defaultViewMode: ViewMode;
  lastLocation: S3Location | null;
  /**
   * Whether the user has completed the first-run welcome flow.
   * Persisted to localStorage so the modal only shows on the first launch.
   */
  firstRunCompleted: boolean;
  /** Persisted preferences for both the read-only and editor text previews. */
  textPreviewPrefs: TextPreviewPrefs;
  /** Resizable column widths for the file list (Details view). */
  detailsColumnWidths: DetailsColumnWidths;
  /**
   * When `true` the Activity Center (transfer history + filters)
   * replaces the main pane. The floating Transfer Manager popup stays
   * available for ambient awareness.
   */
  activityCenterOpen: boolean;
  /**
   * When `true` the Notifications Center (errors + warnings + info
   * messages) replaces the main pane. Mutually exclusive with the
   * Activity Center — opening one closes the other.
   */
  notificationsCenterOpen: boolean;
  /**
   * Unix-ms timestamp of the last time the user opened the Activity
   * Center. Drives the "new download" highlight on the status-bar chip:
   * transfers finished AFTER this stamp count as "unseen".
   */
  activityLastSeenAt: number;
  /**
   * Unix-ms timestamp of the last time the user opened the
   * Notifications Center.
   */
  notificationsLastSeenAt: number;

  setTheme(theme: UiState["theme"]): void;
  toggleSidebar(): void;
  setSidebarPct(pct: number): void;
  setPreviewPct(pct: number): void;
  togglePreview(): void;
  setDefaultViewMode(mode: ViewMode): void;
  setLastLocation(location: S3Location | null): void;
  /** Mark the first-run welcome flow as completed. */
  markFirstRunCompleted(): void;
  /** Patch arbitrary fields of `textPreviewPrefs`. */
  updateTextPreviewPrefs(patch: Partial<TextPreviewPrefs>): void;
  /** Reset text preview prefs to factory defaults. */
  resetTextPreviewPrefs(): void;
  /** Set a single details-table column width (clamped to a sane range). */
  setDetailsColumnWidth(column: keyof DetailsColumnWidths, px: number): void;
  /** Restore the default details-table column widths. */
  resetDetailsColumnWidths(): void;
  /** Toggle the Activity Center on/off. */
  toggleActivityCenter(): void;
  /** Explicitly set the Activity Center state. */
  setActivityCenterOpen(open: boolean): void;
  /** Toggle the Notifications Center on/off. */
  toggleNotificationsCenter(): void;
  /** Explicitly set the Notifications Center state. */
  setNotificationsCenterOpen(open: boolean): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      // ---- default values ----
      theme: "system",
      sidebarCollapsed: false,
      sidebarPct: 22,
      previewPct: 28,
      previewCollapsed: false,
      defaultViewMode: "Details",
      lastLocation: null,
      firstRunCompleted: false,
      textPreviewPrefs: { ...DEFAULT_TEXT_PREVIEW_PREFS },
      detailsColumnWidths: { ...DEFAULT_DETAILS_COLUMN_WIDTHS },
      activityCenterOpen: false,
      notificationsCenterOpen: false,
      activityLastSeenAt: 0,
      notificationsLastSeenAt: 0,

      // ---- actions ----
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarPct: (pct) => set({ sidebarPct: clampPct(pct, 10, 50) }),
      // Allow the preview to grow up to 80% so users with wide windows can
      // get a usable text/code reading surface. Floor stays at 15%.
      setPreviewPct: (pct) => set({ previewPct: clampPct(pct, 15, 80) }),
      togglePreview: () =>
        set((s) => ({ previewCollapsed: !s.previewCollapsed })),
      setDefaultViewMode: (defaultViewMode) => set({ defaultViewMode }),
      setLastLocation: (lastLocation) => set({ lastLocation }),
      markFirstRunCompleted: () => set({ firstRunCompleted: true }),
      updateTextPreviewPrefs: (patch) =>
        set((s) => ({
          textPreviewPrefs: {
            ...s.textPreviewPrefs,
            ...patch,
            // Clamp font size in the store so callers can't push out-of-range
            // values into persisted state via, e.g., a malformed text input.
            fontSize:
              patch.fontSize !== undefined
                ? clampPct(patch.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE)
                : s.textPreviewPrefs.fontSize,
          },
        })),
      resetTextPreviewPrefs: () =>
        set({ textPreviewPrefs: { ...DEFAULT_TEXT_PREVIEW_PREFS } }),
      setDetailsColumnWidth: (column, px) =>
        set((s) => ({
          detailsColumnWidths: {
            ...s.detailsColumnWidths,
            [column]: clampPct(px, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH),
          },
        })),
      resetDetailsColumnWidths: () =>
        set({ detailsColumnWidths: { ...DEFAULT_DETAILS_COLUMN_WIDTHS } }),
      toggleActivityCenter: () =>
        set((s) => {
          const nextOpen = !s.activityCenterOpen;
          return {
            activityCenterOpen: nextOpen,
            // Mutually exclusive with the Notifications Center.
            notificationsCenterOpen: nextOpen
              ? false
              : s.notificationsCenterOpen,
            // Opening counts as "seen".
            activityLastSeenAt: nextOpen ? Date.now() : s.activityLastSeenAt,
          };
        }),
      setActivityCenterOpen: (open) =>
        set((s) => ({
          activityCenterOpen: open,
          notificationsCenterOpen: open ? false : s.notificationsCenterOpen,
          activityLastSeenAt: open ? Date.now() : s.activityLastSeenAt,
        })),
      toggleNotificationsCenter: () =>
        set((s) => {
          const nextOpen = !s.notificationsCenterOpen;
          return {
            notificationsCenterOpen: nextOpen,
            activityCenterOpen: nextOpen ? false : s.activityCenterOpen,
            notificationsLastSeenAt: nextOpen
              ? Date.now()
              : s.notificationsLastSeenAt,
          };
        }),
      setNotificationsCenterOpen: (open) =>
        set((s) => ({
          notificationsCenterOpen: open,
          activityCenterOpen: open ? false : s.activityCenterOpen,
          notificationsLastSeenAt: open
            ? Date.now()
            : s.notificationsLastSeenAt,
        })),
    }),
    {
      // Bumped from "brows3r-ui" → "brows3r-ui-v2" so any old localStorage
      // entries (with the deprecated sidebarWidth/previewWidth pixel fields)
      // are ignored on first read; the new defaults take over.
      name: "brows3r-ui-v2",
    },
  ),
);
