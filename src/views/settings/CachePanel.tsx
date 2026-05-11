/**
 * CachePanel — cache_ttl_secs and cache_size_cap_mb settings.
 *
 * Validates:
 * - TTL: 0–3600 seconds.
 * - Size cap: 1–4096 MB.
 */

import { useState } from "react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, NumberInput, PanelActions } from "./_shared";

export function CachePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [ttlSecs, setTtlSecs] = useState(
    settings?.cacheTtlSecs ?? DEFAULT_SETTINGS.cacheTtlSecs,
  );
  const [sizeMb, setSizeMb] = useState(
    settings?.cacheSizeCapMb ?? DEFAULT_SETTINGS.cacheSizeCapMb,
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ ttl?: string; size?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  function validate(): { ttl?: string; size?: string } {
    const errs: { ttl?: string; size?: string } = {};
    if (!Number.isFinite(ttlSecs) || ttlSecs < 0 || ttlSecs > 3600) {
      errs.ttl = "Cache TTL must be between 0 and 3600 seconds.";
    }
    if (!Number.isFinite(sizeMb) || sizeMb < 1 || sizeMb > 4096) {
      errs.size = "Cache size cap must be between 1 and 4096 MB.";
    }
    return errs;
  }

  async function handleSave() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update({ cacheTtlSecs: ttlSecs, cacheSizeCapMb: sizeMb });
    } catch {
      setSaveError("Failed to save cache settings.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setTtlSecs(DEFAULT_SETTINGS.cacheTtlSecs);
    setSizeMb(DEFAULT_SETTINGS.cacheSizeCapMb);
    setErrors({});
    void resetPanel({
      cacheTtlSecs: DEFAULT_SETTINGS.cacheTtlSecs,
      cacheSizeCapMb: DEFAULT_SETTINGS.cacheSizeCapMb,
    });
  }

  const validationErrors = validate();

  return (
    <section aria-label="Cache settings" className="flex flex-col gap-4">
      <FieldRow
        label="Cache TTL (seconds)"
        htmlFor="cache-ttl"
        error={errors.ttl}
        hint="How long cached listings are considered fresh (0 = no cache)"
      >
        <NumberInput
          id="cache-ttl"
          value={ttlSecs}
          min={0}
          max={3600}
          onChange={setTtlSecs}
          aria-invalid={validationErrors.ttl !== undefined}
        />
      </FieldRow>

      <FieldRow
        label="Cache size cap (MB)"
        htmlFor="cache-size"
        error={errors.size}
        hint="Maximum disk space used for cached listings"
      >
        <NumberInput
          id="cache-size"
          value={sizeMb}
          min={1}
          max={4096}
          onChange={setSizeMb}
          aria-invalid={validationErrors.size !== undefined}
        />
      </FieldRow>

      {saveError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
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
