/**
 * TransfersPanel — transfer_concurrency setting.
 *
 * Validates: 1 ≤ concurrency ≤ 32.
 */

import { useState } from "react";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, NumberInput, PanelActions } from "./_shared";

export function TransfersPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [concurrency, setConcurrency] = useState(
    settings?.transferConcurrency ?? DEFAULT_SETTINGS.transferConcurrency,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      return "Transfer concurrency must be an integer between 1 and 32.";
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
      await update({ transferConcurrency: concurrency });
    } catch (err) {
      setError("Failed to save transfer settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.transfers",
        title: "Failed to save transfer settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setConcurrency(DEFAULT_SETTINGS.transferConcurrency);
    void resetPanel({
      transferConcurrency: DEFAULT_SETTINGS.transferConcurrency,
    });
  }

  const validationError = validate();

  return (
    <section aria-label="Transfer settings" className="flex flex-col gap-4">
      <FieldRow
        label="Transfer concurrency"
        htmlFor="transfers-concurrency"
        error={error ?? undefined}
        hint="Number of parallel transfers (1–32)"
      >
        <NumberInput
          id="transfers-concurrency"
          value={concurrency}
          min={1}
          max={32}
          onChange={setConcurrency}
          aria-invalid={validationError !== null}
          aria-describedby={
            validationError !== null ? "transfers-concurrency-err" : undefined
          }
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
