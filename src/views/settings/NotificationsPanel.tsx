/**
 * NotificationsPanel — notifications.in_app, .os_enabled, .sound settings.
 */

import { useState } from "react";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { PanelActions, ToggleSwitch } from "./_shared";

export function NotificationsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const notif = settings?.notifications ?? DEFAULT_SETTINGS.notifications;

  const [inApp, setInApp] = useState(notif.inApp);
  const [osEnabled, setOsEnabled] = useState(notif.osEnabled);
  const [sound, setSound] = useState(notif.sound);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await update({
        notifications: { inApp, osEnabled, sound },
      });
    } catch (err) {
      setError("Failed to save notification settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.notifications",
        title: "Failed to save notification settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const defaults = DEFAULT_SETTINGS.notifications;
    setInApp(defaults.inApp);
    setOsEnabled(defaults.osEnabled);
    setSound(defaults.sound);
    void resetPanel({ notifications: defaults });
  }

  return (
    <section aria-label="Notification settings" className="flex flex-col gap-4">
      <ToggleSwitch
        id="notif-in-app"
        checked={inApp}
        onChange={setInApp}
        label="In-app notifications"
        description="Show notification banners inside the app"
      />

      <ToggleSwitch
        id="notif-os-enabled"
        checked={osEnabled}
        onChange={setOsEnabled}
        label="OS notifications"
        description="Trigger system-level notifications on transfer completion"
      />

      <ToggleSwitch
        id="notif-sound"
        checked={sound}
        onChange={setSound}
        label="Notification sound"
        description="Play a sound when a notification is shown"
      />

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
