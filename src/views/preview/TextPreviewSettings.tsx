/**
 * TextPreviewSettings — shared settings popover for both the read-only
 * TextPreview (Shiki) and the EditorPreview (Monaco).
 *
 * Renders a cog-icon button. Clicking opens a small panel with controls for
 * the four preferences stored in `useUiStore().textPreviewPrefs`:
 *
 *   - Theme       : auto | light | dark (auto follows the global UI theme)
 *   - Word wrap   : on  | off
 *   - Font size   : numeric stepper (9–28 px)
 *   - Line numbers: on  | off            (Monaco-only effect; toggled here
 *                                          for consistency with Shiki future
 *                                          line-number support)
 *
 * The popover is intentionally low-tech: it uses native focus management and
 * dismisses on outside-click via a single document listener. This keeps the
 * Radix dependency surface small for a component that needs to live inside
 * every preview's toolbar.
 *
 * OCP: adding a new preference is two changes — one in `ui.ts`
 * (`TextPreviewPrefs` + the matching action) and one row here.
 */

import { SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type TextPreviewPrefs, useUiStore } from "@/store/ui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_SIZE_STEP = 1;
const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 28;

const THEME_OPTIONS: Array<TextPreviewPrefs["themeOverride"]> = [
  "auto",
  "light",
  "dark",
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TextPreviewSettingsProps {
  /** When set, hides options not relevant for the read-only Shiki view. */
  variant?: "viewer" | "editor";
}

export function TextPreviewSettings({
  variant = "viewer",
}: TextPreviewSettingsProps): React.ReactElement {
  const prefs = useUiStore((s) => s.textPreviewPrefs);
  const update = useUiStore((s) => s.updateTextPreviewPrefs);
  const reset = useUiStore((s) => s.resetTextPreviewPrefs);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape so the popover behaves like a real
  // menu without bringing in Radix. The listener attaches only while the
  // popover is open to keep the resting cost at zero.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const node = containerRef.current;
      if (!node) return;
      if (!node.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function bumpFontSize(delta: number) {
    const next = Math.min(
      FONT_SIZE_MAX,
      Math.max(FONT_SIZE_MIN, prefs.fontSize + delta),
    );
    update({ fontSize: next });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Text preview settings"
        title="Text preview settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center rounded p-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="text-preview-settings-btn"
      >
        <SettingsIcon className="size-3.5" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Text preview settings"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
          data-testid="text-preview-settings-popover"
        >
          {/* Theme */}
          <SettingRow label="Theme">
            <div
              role="radiogroup"
              aria-label="Theme"
              className="inline-flex overflow-hidden rounded border border-border"
            >
              {THEME_OPTIONS.map((opt) => (
                // biome-ignore lint/a11y/useSemanticElements: segmented control built from <button>s for keyboard/click consistency with the other popovers
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={prefs.themeOverride === opt}
                  onClick={() => update({ themeOverride: opt })}
                  className={`px-2 py-0.5 capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    prefs.themeOverride === opt
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </SettingRow>

          {/* Word wrap */}
          <SettingRow label="Word wrap">
            <Toggle
              checked={prefs.wordWrap}
              onChange={(checked) => update({ wordWrap: checked })}
              label="Word wrap"
            />
          </SettingRow>

          {/* Font size */}
          <SettingRow label="Font size">
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                aria-label="Decrease font size"
                onClick={() => bumpFontSize(-FONT_SIZE_STEP)}
                disabled={prefs.fontSize <= FONT_SIZE_MIN}
                className="rounded border border-border px-1.5 py-0.5 hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                −
              </button>
              <span
                className="w-8 text-center tabular-nums"
                aria-live="polite"
                data-testid="font-size-value"
              >
                {prefs.fontSize}
              </span>
              <button
                type="button"
                aria-label="Increase font size"
                onClick={() => bumpFontSize(FONT_SIZE_STEP)}
                disabled={prefs.fontSize >= FONT_SIZE_MAX}
                className="rounded border border-border px-1.5 py-0.5 hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                +
              </button>
            </div>
          </SettingRow>

          {/* Line numbers — useful for both viewer (future) and editor. */}
          {variant === "editor" && (
            <SettingRow label="Line numbers">
              <Toggle
                checked={prefs.lineNumbers}
                onChange={(checked) => update({ lineNumbers: checked })}
                label="Line numbers"
              />
            </SettingRow>
          )}

          <div className="mt-2 flex justify-end border-t border-border pt-2">
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="rounded border border-border px-2 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reset defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 last:mb-0">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-4 w-7 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        checked ? "bg-accent-foreground/80" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block size-3 rounded-full bg-background transition-transform ${
          checked ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
