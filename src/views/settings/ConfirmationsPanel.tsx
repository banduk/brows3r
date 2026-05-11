/**
 * ConfirmationsPanel — transfer_confirmations.delete, .overwrite, .large_upload_mb.
 *
 * Validates: large_upload_mb must be > 0.
 */

import { useState } from "react";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, NumberInput, PanelActions, ToggleSwitch } from "./_shared";

export function ConfirmationsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const confirmations =
    settings?.transferConfirmations ?? DEFAULT_SETTINGS.transferConfirmations;

  const [confirmDelete, setConfirmDelete] = useState(confirmations.delete);
  const [confirmOverwrite, setConfirmOverwrite] = useState(
    confirmations.overwrite,
  );
  const [largeUploadMb, setLargeUploadMb] = useState(
    confirmations.largeUploadMb,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!Number.isFinite(largeUploadMb) || largeUploadMb <= 0) {
      return "Large upload threshold must be greater than 0 MB.";
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
      await update({
        transferConfirmations: {
          delete: confirmDelete,
          overwrite: confirmOverwrite,
          largeUploadMb,
        },
      });
    } catch (err) {
      setError("Failed to save confirmation settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.confirmations",
        title: "Failed to save confirmation settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const defaults = DEFAULT_SETTINGS.transferConfirmations;
    setConfirmDelete(defaults.delete);
    setConfirmOverwrite(defaults.overwrite);
    setLargeUploadMb(defaults.largeUploadMb);
    void resetPanel({ transferConfirmations: defaults });
  }

  const validationError = validate();

  return (
    <section aria-label="Confirmation settings" className="flex flex-col gap-4">
      <ToggleSwitch
        id="confirm-delete"
        checked={confirmDelete}
        onChange={setConfirmDelete}
        label="Confirm delete operations"
        description="Prompt before permanently deleting objects"
      />

      <ToggleSwitch
        id="confirm-overwrite"
        checked={confirmOverwrite}
        onChange={setConfirmOverwrite}
        label="Confirm overwrite operations"
        description="Prompt before overwriting existing objects"
      />

      <FieldRow
        label="Large upload threshold (MB)"
        htmlFor="confirm-large-upload"
        error={error ?? undefined}
        hint="Ask for confirmation before uploading files larger than this size"
      >
        <NumberInput
          id="confirm-large-upload"
          value={largeUploadMb}
          min={1}
          onChange={setLargeUploadMb}
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
