/**
 * PreviewPanel — preview_size_limit_mb setting.
 *
 * Validates: 1 ≤ limit ≤ 500.
 */

import { useState } from "react";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, NumberInput, PanelActions } from "./_shared";

export function PreviewPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [limitMb, setLimitMb] = useState(
    settings?.previewSizeLimitMb ?? DEFAULT_SETTINGS.previewSizeLimitMb,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!Number.isFinite(limitMb) || limitMb < 1 || limitMb > 500) {
      return "Preview size limit must be between 1 and 500 MB.";
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
      await update({ previewSizeLimitMb: limitMb });
    } catch (err) {
      setError("Failed to save preview settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.preview",
        title: "Failed to save preview settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setLimitMb(DEFAULT_SETTINGS.previewSizeLimitMb);
    void resetPanel({
      previewSizeLimitMb: DEFAULT_SETTINGS.previewSizeLimitMb,
    });
  }

  const validationError = validate();

  return (
    <section aria-label="Preview settings" className="flex flex-col gap-4">
      <FieldRow
        label="Preview size limit (MB)"
        htmlFor="preview-limit-mb"
        error={error ?? undefined}
        hint="Files larger than this limit will not be previewed automatically"
      >
        <NumberInput
          id="preview-limit-mb"
          value={limitMb}
          min={1}
          max={500}
          onChange={setLimitMb}
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
