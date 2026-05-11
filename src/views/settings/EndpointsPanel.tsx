/**
 * EndpointsPanel — s3_compatible_endpoints CRUD list.
 *
 * OCP: adding a new endpoint field = one more <input> inside the form row.
 */

import { useRef, useState } from "react";
import type { S3CompatibleEndpoint } from "@/api/settings";
import { surfaceUnknownError } from "@/lib/errors";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/store/settings";
import { FieldRow, PanelActions } from "./_shared";

/** Internal row type adds a stable `_id` so React keys are not index-based. */
interface EndpointRow extends S3CompatibleEndpoint {
  _id: string;
}

let _counter = 0;
function makeId(): string {
  return `ep-${++_counter}`;
}

function toRow(ep: S3CompatibleEndpoint): EndpointRow {
  return { ...ep, _id: makeId() };
}

function toEndpoint(row: EndpointRow): S3CompatibleEndpoint {
  const { _id: _unused, ...ep } = row;
  return ep;
}

export function EndpointsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const resetPanel = useSettingsStore((s) => s.resetPanel);

  const [endpoints, setEndpoints] = useState<EndpointRow[]>(() =>
    (
      settings?.s3CompatibleEndpoints ?? DEFAULT_SETTINGS.s3CompatibleEndpoints
    ).map(toRow),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Keep index-to-label stable for display without using index as key.
  const displayIndexRef = useRef<Map<string, number>>(new Map());

  function labelIndex(id: string): number {
    const existing = displayIndexRef.current.get(id);
    if (existing !== undefined) return existing;
    const next = displayIndexRef.current.size + 1;
    displayIndexRef.current.set(id, next);
    return next;
  }

  function validate(): string[] {
    const errs: string[] = [];
    for (const ep of endpoints) {
      const n = labelIndex(ep._id);
      if (ep.name.trim().length === 0) {
        errs.push(`Endpoint ${n}: name is required.`);
      }
      if (ep.endpointUrl.trim().length === 0) {
        errs.push(`Endpoint ${n}: URL is required.`);
      } else {
        try {
          new URL(ep.endpointUrl);
        } catch {
          errs.push(`Endpoint ${n}: URL is not valid.`);
        }
      }
    }
    return errs;
  }

  function updateEndpoint(id: string, patch: Partial<S3CompatibleEndpoint>) {
    setEndpoints((prev) =>
      prev.map((ep) => (ep._id === id ? { ...ep, ...patch } : ep)),
    );
  }

  function addEndpoint() {
    setEndpoints((prev) => [
      ...prev,
      { name: "", endpointUrl: "", defaultRegion: "", _id: makeId() },
    ]);
  }

  function removeEndpoint(id: string) {
    setEndpoints((prev) => prev.filter((ep) => ep._id !== id));
    displayIndexRef.current.delete(id);
  }

  async function handleSave() {
    const errs = validate();
    setErrors(errs);
    if (errs.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update({ s3CompatibleEndpoints: endpoints.map(toEndpoint) });
    } catch (err) {
      setSaveError("Failed to save endpoint settings.");
      void surfaceUnknownError(err, {
        operation: "settings_update.endpoints",
        title: "Failed to save endpoint settings",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    displayIndexRef.current.clear();
    setEndpoints(DEFAULT_SETTINGS.s3CompatibleEndpoints.map(toRow));
    setErrors([]);
    void resetPanel({
      s3CompatibleEndpoints: DEFAULT_SETTINGS.s3CompatibleEndpoints,
    });
  }

  return (
    <section
      aria-label="S3-compatible endpoints settings"
      className="flex flex-col gap-4"
    >
      {endpoints.map((ep) => {
        const n = labelIndex(ep._id);
        return (
          <div
            key={ep._id}
            className="rounded-lg border border-border p-3 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Endpoint {n}</span>
              <button
                type="button"
                aria-label={`Remove endpoint ${n}`}
                className="text-xs text-destructive hover:underline"
                onClick={() => removeEndpoint(ep._id)}
              >
                Remove
              </button>
            </div>

            <FieldRow label="Name" htmlFor={`ep-${ep._id}-name`}>
              <input
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                id={`ep-${ep._id}-name`}
                type="text"
                placeholder="My MinIO"
                value={ep.name}
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(e) =>
                  updateEndpoint(ep._id, { name: e.currentTarget.value })
                }
              />
            </FieldRow>

            <FieldRow label="Endpoint URL" htmlFor={`ep-${ep._id}-url`}>
              <input
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                id={`ep-${ep._id}-url`}
                type="text"
                placeholder="https://s3.example.com"
                value={ep.endpointUrl}
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(e) =>
                  updateEndpoint(ep._id, { endpointUrl: e.currentTarget.value })
                }
              />
            </FieldRow>

            <FieldRow label="Default region" htmlFor={`ep-${ep._id}-region`}>
              <input
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                id={`ep-${ep._id}-region`}
                type="text"
                placeholder="us-east-1"
                value={ep.defaultRegion}
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(e) =>
                  updateEndpoint(ep._id, {
                    defaultRegion: e.currentTarget.value,
                  })
                }
              />
            </FieldRow>
          </div>
        );
      })}

      {errors.length > 0 && (
        <ul role="alert" className="text-sm text-destructive list-disc pl-4">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="self-start text-sm text-primary underline-offset-2 hover:underline"
        onClick={addEndpoint}
      >
        + Add endpoint
      </button>

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
