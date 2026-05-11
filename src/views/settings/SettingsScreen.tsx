/**
 * SettingsScreen — top-level settings modal with tabs for all 14 panels.
 *
 * Uses Radix UI Tabs (available via the `radix-ui` package).
 *
 * OCP: adding a 15th panel = one entry in PANELS + one new file. No other
 * structural change needed.
 *
 * The screen is opened via the `settings:open` custom DOM event, which is
 * dispatched by the `settings.open` command definition.
 */

import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useSettingsStore } from "@/store/settings";
import { CachePanel } from "./CachePanel";
import { ConfirmationsPanel } from "./ConfirmationsPanel";
import { DefaultViewPanel } from "./DefaultViewPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { EndpointsPanel } from "./EndpointsPanel";
import { FallbackPanel } from "./FallbackPanel";
import { GeneralPanel } from "./GeneralPanel";
import { MultipartPanel } from "./MultipartPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { PreviewPanel } from "./PreviewPanel";
import { ProxyPanel } from "./ProxyPanel";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { StartupPanel } from "./StartupPanel";
import { TransfersPanel } from "./TransfersPanel";
import { UpdaterPanel } from "./UpdaterPanel";

// ---------------------------------------------------------------------------
// Panel registry
// ---------------------------------------------------------------------------

const PANELS = [
  { id: "general", label: "General", Component: GeneralPanel },
  { id: "transfers", label: "Transfers", Component: TransfersPanel },
  { id: "preview", label: "Preview", Component: PreviewPanel },
  { id: "shortcuts", label: "Shortcuts", Component: ShortcutsPanel },
  {
    id: "notifications",
    label: "Notifications",
    Component: NotificationsPanel,
  },
  { id: "endpoints", label: "Endpoints", Component: EndpointsPanel },
  { id: "updater", label: "Updates", Component: UpdaterPanel },
  { id: "diagnostics", label: "Diagnostics", Component: DiagnosticsPanel },
  { id: "startup", label: "Startup", Component: StartupPanel },
  { id: "proxy", label: "Proxy", Component: ProxyPanel },
  { id: "cache", label: "Cache", Component: CachePanel },
  { id: "fallback", label: "Fallback", Component: FallbackPanel },
  {
    id: "confirmations",
    label: "Confirmations",
    Component: ConfirmationsPanel,
  },
  { id: "defaultView", label: "Default View", Component: DefaultViewPanel },
  { id: "multipart", label: "Multipart cleanup", Component: MultipartPanel },
] as const;

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

export function SettingsScreen() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(PANELS[0].id);
  const load = useSettingsStore((s) => s.load);
  const resetAll = useSettingsStore((s) => s.resetAll);
  const loading = useSettingsStore((s) => s.loading);
  const error = useSettingsStore((s) => s.error);

  // Listen for the settings:open event dispatched by the settings.open command.
  useEffect(() => {
    function handleOpen() {
      setOpen(true);
    }
    window.addEventListener("settings:open", handleOpen);
    return () => window.removeEventListener("settings:open", handleOpen);
  }, []);

  // Load settings when the screen opens.
  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation wrapper only, no semantic interaction */}
      <div
        className="relative bg-popover rounded-xl ring-1 ring-foreground/10 w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => void resetAll()}
              aria-label="Reset all settings to defaults"
            >
              Reset all
            </button>
            <button
              type="button"
              aria-label="Close settings"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              <svg
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            Loading settings…
          </div>
        ) : error !== null ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          </div>
        ) : (
          <Tabs.Root
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex flex-1 overflow-hidden"
          >
            {/* Tab list — vertical sidebar */}
            <Tabs.List
              aria-label="Settings sections"
              className="flex flex-col gap-0.5 border-r w-44 shrink-0 p-2 overflow-y-auto"
            >
              {PANELS.map(({ id, label }) => (
                <Tabs.Trigger
                  key={id}
                  value={id}
                  className="flex w-full items-center rounded-md px-3 py-1.5 text-sm text-left text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            {/* Panel content */}
            <div className="flex-1 overflow-y-auto p-5">
              {PANELS.map(({ id, Component }) => (
                <Tabs.Content key={id} value={id} className="outline-none">
                  <Component />
                </Tabs.Content>
              ))}
            </div>
          </Tabs.Root>
        )}
      </div>
    </div>
  );
}
