/**
 * ProxyPanel — proxy mode (system/explicit/none) and URL field.
 */

import { useState } from "react";
import type { ProxyMode } from "@/api/settings";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions } from "./_shared";

type ProxyModeTag = "system" | "explicit" | "none";

function proxyModeTag(proxy: ProxyMode): ProxyModeTag {
  return proxy.mode;
}

function proxyUrl(proxy: ProxyMode): string {
  if (proxy.mode === "explicit") return proxy.url;
  return "";
}

export function ProxyPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const proxy = settings?.proxy ?? DEFAULT_SETTINGS.proxy;

  const [mode, setMode] = useState<ProxyModeTag>(proxyModeTag(proxy));
  const [url, setUrl] = useState(proxyUrl(proxy));
  const [saving, setSaving] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function buildProxy(): ProxyMode {
    if (mode === "explicit") return { mode: "explicit", url: url.trim() };
    if (mode === "none") return { mode: "none" };
    return { mode: "system" };
  }

  function validate(): string | null {
    if (mode === "explicit") {
      if (url.trim().length === 0) return "Proxy URL is required.";
      try {
        new URL(url.trim());
      } catch {
        return "Proxy URL must be a valid URL.";
      }
    }
    return null;
  }

  async function handleSave() {
    const err = validate();
    setUrlError(err);
    if (err !== null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update({ proxy: buildProxy() });
    } catch {
      setSaveError("Failed to save proxy settings.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    const defaults = DEFAULT_SETTINGS.proxy;
    setMode(proxyModeTag(defaults));
    setUrl(proxyUrl(defaults));
    setUrlError(null);
    void resetPanel({ proxy: defaults });
  }

  return (
    <section aria-label="Proxy settings" className="flex flex-col gap-4">
      <FieldRow label="Proxy mode" htmlFor="proxy-mode">
        <select
          id="proxy-mode"
          value={mode}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => setMode(e.currentTarget.value as ProxyModeTag)}
        >
          <option value="system">System proxy</option>
          <option value="explicit">Explicit URL</option>
          <option value="none">No proxy</option>
        </select>
      </FieldRow>

      {mode === "explicit" && (
        <FieldRow
          label="Proxy URL"
          htmlFor="proxy-url"
          error={urlError ?? undefined}
        >
          <input
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            id="proxy-url"
            type="text"
            placeholder="http://proxy.example.com:8080"
            value={url}
            aria-invalid={urlError !== null}
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
        </FieldRow>
      )}

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
