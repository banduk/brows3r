/**
 * ShortcutsPanel — keyboard_shortcuts (table of binding overrides).
 *
 * Shows the baseline shortcut map with override inputs. Conflict detection
 * uses `detectConflicts` from task 16.
 *
 * Extended in task 57:
 * - Conflict rows show a red badge.
 * - "Resolve" button per conflict group opens a small modal that lists the
 *   conflicting commands and lets the user clear one of them.
 * - "Reset shortcuts to defaults" button resets all overrides.
 */

import { useState } from "react";
import { detectConflicts } from "@/commands/conflicts";
import { registry } from "@/commands/registry";
import { BASELINE_SHORTCUTS, platformShortcut } from "@/commands/shortcuts";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { PanelActions } from "./_shared";

// ---------------------------------------------------------------------------
// Resolve modal
// ---------------------------------------------------------------------------

interface ResolveModalProps {
  commandIds: string[];
  shortcutLabel: string;
  onClear: (commandId: string) => void;
  onClose: () => void;
}

function ResolveModal({
  commandIds,
  shortcutLabel,
  onClear,
  onClose,
}: ResolveModalProps) {
  return (
    // Backdrop — close on click-outside or Escape key.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Resolve shortcut conflict"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-xl">
        <h2 className="mb-1 text-base font-semibold">
          Resolve shortcut conflict
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Shortcut{" "}
          <span className="font-mono font-medium">{shortcutLabel}</span> is
          assigned to multiple commands. Clear one of them to resolve the
          conflict.
        </p>

        <ul className="mb-4 flex flex-col gap-2">
          {commandIds.map((id) => (
            <li key={id} className="flex items-center justify-between gap-4">
              <span className="font-mono text-sm">{id}</span>
              <button
                type="button"
                className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  onClear(id);
                  onClose();
                }}
              >
                Clear
              </button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ShortcutsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [overrides, setOverrides] = useState<Record<string, string>>(
    settings?.keyboardShortcuts ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve modal state: which conflict group is open (index into conflicts array).
  const [resolveIndex, setResolveIndex] = useState<number | null>(null);

  const platform =
    typeof navigator !== "undefined" &&
    navigator.platform.toLowerCase().includes("mac")
      ? ("mac" as const)
      : ("win" as const);

  const conflicts = detectConflicts(registry, platform);
  const hasConflicts = conflicts.conflicts.length > 0;

  // Build a set of command ids that are currently conflicting.
  const conflictingCommandIds = new Set(
    conflicts.conflicts.flatMap((c) => c.commandIds),
  );

  async function handleSave() {
    if (hasConflicts) {
      setError(
        "Resolve shortcut conflicts before saving. Conflicting shortcuts must be unique.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await update({ keyboardShortcuts: overrides });
    } catch (err) {
      setError("Failed to save shortcut settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.shortcuts",
        title: "Failed to save shortcut settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setOverrides(DEFAULT_SETTINGS.keyboardShortcuts);
    void resetPanel({ keyboardShortcuts: DEFAULT_SETTINGS.keyboardShortcuts });
  }

  function handleClearOverride(commandId: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[commandId];
      return next;
    });
  }

  const openConflict =
    resolveIndex !== null ? (conflicts.conflicts[resolveIndex] ?? null) : null;

  function conflictShortcutLabel(index: number): string {
    const c = conflicts.conflicts[index];
    if (!c) return "";
    const mods = c.shortcut.mod ?? [];
    return [...mods, c.shortcut.key].join("+");
  }

  return (
    <section
      aria-label="Keyboard shortcuts settings"
      className="flex flex-col gap-4"
    >
      {/* Conflict summary banner */}
      {hasConflicts && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <span className="font-medium">Shortcut conflicts detected.</span>{" "}
          Resolve each conflict before saving.
          <ul className="mt-1 flex flex-col gap-0.5 text-xs">
            {conflicts.conflicts.map((c, i) => {
              const label = conflictShortcutLabel(i);
              return (
                <li key={label} className="flex items-center gap-2">
                  {/* Visual badge — hidden from screen readers, conflict is announced via role=alert */}
                  <span
                    aria-hidden="true"
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
                  >
                    !
                  </span>
                  <span className="font-mono">{label}</span>
                  <span className="text-muted-foreground">
                    — {c.commandIds.join(", ")}
                  </span>
                  <button
                    type="button"
                    aria-label={`Resolve conflict for ${label}`}
                    className="ml-auto rounded border border-destructive/40 bg-destructive/5 px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => setResolveIndex(i)}
                  >
                    Resolve
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Shortcut table */}
      <div className="overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Command</th>
              <th className="py-2 pr-4 font-medium">Default shortcut</th>
              <th className="py-2 font-medium">Override</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(BASELINE_SHORTCUTS).map(([commandId, binding]) => {
              const defaultKey = platformShortcut(binding, platform);
              const displayDefault = [
                ...(defaultKey.mod ?? []),
                defaultKey.key,
              ].join("+");
              const isConflicting = conflictingCommandIds.has(commandId);
              return (
                <tr
                  key={commandId}
                  className="border-b last:border-0"
                  aria-invalid={isConflicting ? "true" : undefined}
                >
                  <td className="py-2 pr-4">
                    <span className="font-mono text-xs">{commandId}</span>
                    {isConflicting && (
                      // Badge — hidden from AT; conflict announced via alert banner.
                      <span
                        aria-hidden="true"
                        className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
                      >
                        !
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {displayDefault}
                  </td>
                  <td className="py-2">
                    <input
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      type="text"
                      aria-label={`Override shortcut for ${commandId}`}
                      placeholder="e.g. Ctrl+K"
                      value={overrides[commandId] ?? ""}
                      className="h-7 w-32 rounded border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onChange={(e) => {
                        const val = e.target.value;
                        setOverrides((prev) => ({
                          ...prev,
                          [commandId]: val,
                        }));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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

      {/* Resolve modal */}
      {openConflict !== null && resolveIndex !== null && (
        <ResolveModal
          commandIds={openConflict.commandIds}
          shortcutLabel={conflictShortcutLabel(resolveIndex)}
          onClear={handleClearOverride}
          onClose={() => setResolveIndex(null)}
        />
      )}
    </section>
  );
}
