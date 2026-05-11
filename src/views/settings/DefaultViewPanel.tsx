/**
 * DefaultViewPanel — default_view_mode re-exposed as a standalone panel.
 *
 * This is a convenience panel for users who want a dedicated tab for view
 * defaults without going through General. OCP: the view mode list is shared
 * with GeneralPanel through constants.
 */

import { useState } from "react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions } from "./_shared";

type ViewMode =
  | "Details"
  | "IconGrid"
  | "Gallery"
  | "Column"
  | "Tree"
  | "FlatKey"
  | "DualPane";

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "Details", label: "Details" },
  { value: "IconGrid", label: "Icon / Grid" },
  { value: "Gallery", label: "Gallery" },
  { value: "Column", label: "Column" },
  { value: "Tree", label: "Tree" },
  { value: "FlatKey", label: "Flat key" },
  { value: "DualPane", label: "Dual pane" },
];

export function DefaultViewPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [viewMode, setViewMode] = useState<ViewMode>(
    (settings?.defaultViewMode as ViewMode) ?? DEFAULT_SETTINGS.defaultViewMode,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await update({ defaultViewMode: viewMode });
    } catch {
      setError("Failed to save default view settings.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setViewMode(DEFAULT_SETTINGS.defaultViewMode as ViewMode);
    void resetPanel({ defaultViewMode: DEFAULT_SETTINGS.defaultViewMode });
  }

  return (
    <section aria-label="Default view settings" className="flex flex-col gap-4">
      <FieldRow label="Default view mode" htmlFor="default-view-mode">
        <select
          id="default-view-mode"
          value={viewMode}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => setViewMode(e.currentTarget.value as ViewMode)}
        >
          {VIEW_MODE_OPTIONS.map((opt) => (
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
