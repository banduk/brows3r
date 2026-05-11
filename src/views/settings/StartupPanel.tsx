/**
 * StartupPanel — startup_behavior.restore_session and .open_to settings.
 */

import { useState } from "react";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions, ToggleSwitch } from "./_shared";

export function StartupPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const startup = settings?.startupBehavior ?? DEFAULT_SETTINGS.startupBehavior;

  const [restoreSession, setRestoreSession] = useState(startup.restoreSession);
  const [openTo, setOpenTo] = useState(startup.openTo ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await update({
        startupBehavior: {
          restoreSession,
          openTo: openTo.trim().length > 0 ? openTo.trim() : undefined,
        },
      });
    } catch (err) {
      setError("Failed to save startup settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.startup",
        title: "Failed to save startup settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const defaults = DEFAULT_SETTINGS.startupBehavior;
    setRestoreSession(defaults.restoreSession);
    setOpenTo(defaults.openTo ?? "");
    void resetPanel({ startupBehavior: defaults });
  }

  return (
    <section aria-label="Startup settings" className="flex flex-col gap-4">
      <ToggleSwitch
        id="startup-restore-session"
        checked={restoreSession}
        onChange={setRestoreSession}
        label="Restore last session on startup"
        description="Reopen the last active profile and location when the app starts"
      />

      <FieldRow
        label="Open to (optional)"
        htmlFor="startup-open-to"
        hint="Profile or path to navigate to on startup (overrides session restore)"
      >
        <input
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          id="startup-open-to"
          type="text"
          placeholder="e.g. my-profile://my-bucket/"
          value={openTo}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => setOpenTo(e.currentTarget.value)}
        />
      </FieldRow>

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
