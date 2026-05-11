/**
 * UpdaterPanel — auto_update.enabled and auto_update.channel settings.
 */

import { useState } from "react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions, ToggleSwitch } from "./_shared";

type UpdateChannel = "stable" | "beta" | "nightly";

const CHANNEL_OPTIONS: { value: UpdateChannel; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
  { value: "nightly", label: "Nightly" },
];

export function UpdaterPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const autoUpdate = settings?.autoUpdate ?? DEFAULT_SETTINGS.autoUpdate;

  const [enabled, setEnabled] = useState(autoUpdate.enabled);
  const [channel, setChannel] = useState<UpdateChannel>(
    autoUpdate.channel as UpdateChannel,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await update({ autoUpdate: { enabled, channel } });
    } catch {
      setError("Failed to save updater settings.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const defaults = DEFAULT_SETTINGS.autoUpdate;
    setEnabled(defaults.enabled);
    setChannel(defaults.channel as UpdateChannel);
    void resetPanel({ autoUpdate: defaults });
  }

  return (
    <section aria-label="Updater settings" className="flex flex-col gap-4">
      <ToggleSwitch
        id="updater-enabled"
        checked={enabled}
        onChange={setEnabled}
        label="Auto-update enabled"
        description="Automatically check for and install updates"
      />

      <FieldRow label="Update channel" htmlFor="updater-channel">
        <select
          id="updater-channel"
          value={channel}
          disabled={!enabled}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          onChange={(e) => setChannel(e.currentTarget.value as UpdateChannel)}
        >
          {CHANNEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
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
