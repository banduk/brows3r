/**
 * GeneralPanel — theme (light/dark/system) and default view mode.
 *
 * OCP: adding a new theme option = one new <option>; adding a new view
 * mode = one new <option>. No structural change needed.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions } from "./_shared";

type Theme = "light" | "dark" | "system";
type ViewMode =
  | "Details"
  | "IconGrid"
  | "Gallery"
  | "Column"
  | "Tree"
  | "FlatKey"
  | "DualPane";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "System default" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "Details", label: "Details" },
  { value: "IconGrid", label: "Icon / Grid" },
  { value: "Gallery", label: "Gallery" },
  { value: "Column", label: "Column" },
  { value: "Tree", label: "Tree" },
  { value: "FlatKey", label: "Flat key" },
  { value: "DualPane", label: "Dual pane" },
];

export function GeneralPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);
  const { t, i18n } = useTranslation();

  const [theme, setTheme] = useState<Theme>(
    (settings?.theme as Theme) ?? DEFAULT_SETTINGS.theme,
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    (settings?.defaultViewMode as ViewMode) ?? DEFAULT_SETTINGS.defaultViewMode,
  );
  const [language, setLanguage] = useState<string>(
    i18n.resolvedLanguage ?? i18n.language ?? "en",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleLanguageChange(next: string) {
    setLanguage(next);
    void i18n.changeLanguage(next);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await update({ theme, defaultViewMode: viewMode });
    } catch (err) {
      setError("Failed to save general settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.general",
        title: "Failed to save general settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setTheme(DEFAULT_SETTINGS.theme as Theme);
    setViewMode(DEFAULT_SETTINGS.defaultViewMode as ViewMode);
    void resetPanel({
      theme: DEFAULT_SETTINGS.theme,
      defaultViewMode: DEFAULT_SETTINGS.defaultViewMode,
    });
  }

  return (
    <section aria-label="General settings" className="flex flex-col gap-4">
      <FieldRow label="Theme" htmlFor="general-theme">
        <select
          id="general-theme"
          value={theme}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => setTheme(e.currentTarget.value as Theme)}
        >
          {THEME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label="Default view mode" htmlFor="general-view-mode">
        <select
          id="general-view-mode"
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

      <FieldRow label={t("settings.language.label")} htmlFor="general-language">
        <select
          id="general-language"
          value={language}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => handleLanguageChange(e.currentTarget.value)}
        >
          {SUPPORTED_LANGUAGES.map((opt) => (
            <option key={opt.code} value={opt.code}>
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
