/**
 * FallbackPanel — fallback_threshold_mb for cross-account automatic fallback.
 *
 * Validates: 1–10240 MB.
 */

import { useState } from "react";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, NumberInput, PanelActions } from "./_shared";

export function FallbackPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [thresholdMb, setThresholdMb] = useState(
    settings?.fallbackThresholdMb ?? DEFAULT_SETTINGS.fallbackThresholdMb,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (
      !Number.isFinite(thresholdMb) ||
      thresholdMb < 1 ||
      thresholdMb > 10240
    ) {
      return "Fallback threshold must be between 1 and 10240 MB.";
    }
    return null;
  }

  async function handleSave() {
    const err = validate();
    if (err !== null) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await update({ fallbackThresholdMb: thresholdMb });
    } catch (err) {
      setError("Failed to save fallback settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.fallback",
        title: "Failed to save fallback settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setThresholdMb(DEFAULT_SETTINGS.fallbackThresholdMb);
    void resetPanel({
      fallbackThresholdMb: DEFAULT_SETTINGS.fallbackThresholdMb,
    });
  }

  const validationError = validate();

  return (
    <section aria-label="Fallback settings" className="flex flex-col gap-4">
      <FieldRow
        label="Cross-account fallback threshold (MB)"
        htmlFor="fallback-threshold"
        error={error ?? undefined}
        hint="Objects below this size automatically use download+upload fallback for cross-account copies. Larger objects require explicit confirmation."
      >
        <NumberInput
          id="fallback-threshold"
          value={thresholdMb}
          min={1}
          max={10240}
          onChange={setThresholdMb}
          aria-invalid={validationError !== null}
        />
      </FieldRow>

      <PanelActions
        onReset={handleReset}
        onSave={() => void handleSave()}
        saving={saving}
      />
    </section>
  );
}
