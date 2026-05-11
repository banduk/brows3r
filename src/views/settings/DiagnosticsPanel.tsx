/**
 * DiagnosticsPanel — diagnostics_enabled toggle and "Export bundle" flow.
 *
 * Export flow (task 60):
 *   1. User selects redaction level + include-toggles.
 *   2. Click "Generate bundle" → calls diagnosticsCollect(config).
 *   3. tauri-plugin-dialog save dialog → user picks destination.
 *   4. Click Save → calls diagnosticsExport(bundleRef, savePath).
 *   5. Success notification with destination path is shown.
 *
 * Privacy note: "Bundle is never auto-uploaded. You control where it goes."
 */

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import {
  type BundleConfig,
  type BundleRef,
  diagnosticsCollect,
  diagnosticsExport,
  type RedactionLevel,
} from "@/api/diagnostics";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions, ToggleSwitch } from "./_shared";

// Default bundle configuration exposed in the UI.
const DEFAULT_CONFIG: BundleConfig = {
  includeRecentErrors: true,
  redactionLevel: "Full",
  includeLogs: true,
  includeSettings: true,
  includeProfilesMetadata: true,
};

export function DiagnosticsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  // Settings toggles
  const [enabled, setEnabled] = useState(
    settings?.diagnosticsEnabled ?? DEFAULT_SETTINGS.diagnosticsEnabled,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bundle config
  const [config, setConfig] = useState<BundleConfig>(DEFAULT_CONFIG);

  // Export flow state
  const [collecting, setCollecting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Settings save/reset
  // -------------------------------------------------------------------------

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await update({ diagnosticsEnabled: enabled });
    } catch (err) {
      setError("Failed to save diagnostics settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.diagnostics",
        title: "Failed to save diagnostics settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setEnabled(DEFAULT_SETTINGS.diagnosticsEnabled);
    void resetPanel({
      diagnosticsEnabled: DEFAULT_SETTINGS.diagnosticsEnabled,
    });
  }

  // -------------------------------------------------------------------------
  // Bundle export flow
  // -------------------------------------------------------------------------

  async function handleGenerateAndExport() {
    setCollecting(true);
    setExportError(null);
    setExportSuccess(null);

    let bundleRef: BundleRef;
    try {
      bundleRef = await diagnosticsCollect(config);
    } catch (err) {
      setExportError("Failed to collect the diagnostic bundle.");
      void surfaceUnknownError(err, {
        operation: "diagnostics_collect",
        title: "Failed to collect diagnostic bundle",
      });
      setCollecting(false);
      return;
    }

    // Open the save dialog so the user chooses the destination path.
    let savePath: string | null;
    try {
      savePath = await saveDialog({
        defaultPath: "brows3r-diagnostics.zip",
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
        title: "Save diagnostic bundle",
      });
    } catch {
      // Dialog threw an error (rare — treat as cancel).
      savePath = null;
    }

    if (savePath === null) {
      // User cancelled — leave the temp bundle in place so they can retry.
      setCollecting(false);
      return;
    }

    try {
      await diagnosticsExport(bundleRef, savePath);
      setExportSuccess(savePath);
    } catch (err) {
      setExportError("Failed to save the diagnostic bundle.");
      void surfaceUnknownError(err, {
        operation: "diagnostics_export",
        resource: savePath,
        title: "Failed to save diagnostic bundle",
      });
    } finally {
      setCollecting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section aria-label="Diagnostics settings" className="flex flex-col gap-4">
      {/* Main diagnostics toggle */}
      <ToggleSwitch
        id="diagnostics-enabled"
        checked={enabled}
        onChange={setEnabled}
        label="Enable diagnostics collection"
        description="Collect local logs and exception details for export. No data is sent automatically."
      />

      {/* Bundle configuration */}
      <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <p className="text-sm font-semibold">Bundle contents</p>

        <ToggleSwitch
          id="bundle-include-logs"
          checked={config.includeLogs}
          onChange={(v) => setConfig((c) => ({ ...c, includeLogs: v }))}
          label="Include application logs"
        />
        <ToggleSwitch
          id="bundle-include-settings"
          checked={config.includeSettings}
          onChange={(v) => setConfig((c) => ({ ...c, includeSettings: v }))}
          label="Include settings"
          description="Secrets are never stored in settings.json."
        />
        <ToggleSwitch
          id="bundle-include-profiles"
          checked={config.includeProfilesMetadata}
          onChange={(v) =>
            setConfig((c) => ({ ...c, includeProfilesMetadata: v }))
          }
          label="Include profile metadata"
          description="Profile names and regions only — credentials are excluded."
        />
        <ToggleSwitch
          id="bundle-include-errors"
          checked={config.includeRecentErrors}
          onChange={(v) => setConfig((c) => ({ ...c, includeRecentErrors: v }))}
          label="Include recent errors"
        />

        <FieldRow
          label="Redaction level"
          htmlFor="bundle-redaction-level"
          hint="Full redacts all credentials and home-dir paths. Partial keeps account IDs visible."
        >
          <select
            id="bundle-redaction-level"
            value={config.redactionLevel}
            className="h-8 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                redactionLevel: e.currentTarget.value as RedactionLevel,
              }))
            }
          >
            <option value="Full">Full (recommended)</option>
            <option value="Partial">Partial (keeps account IDs)</option>
            <option value="None">None (no redaction)</option>
          </select>
        </FieldRow>
      </div>

      {/* Privacy note */}
      <p className="text-xs text-muted-foreground">
        Bundle is never auto-uploaded. You control where it goes.
      </p>

      {/* Generate / Export button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={collecting}
          aria-busy={collecting}
          className="h-8 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void handleGenerateAndExport()}
        >
          {collecting ? "Generating…" : "Export diagnostic bundle"}
        </button>
      </div>

      {/* Success / error feedback */}
      {exportSuccess !== null && (
        <p role="status" className="text-sm text-green-600 dark:text-green-400">
          Bundle saved to: {exportSuccess}
        </p>
      )}
      {exportError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {exportError}
        </p>
      )}

      {/* Settings-level error */}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <PanelActions
        onReset={handleReset}
        onSave={() => void handleSave()}
        saving={saving}
      />
    </section>
  );
}
