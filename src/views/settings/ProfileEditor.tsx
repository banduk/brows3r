/**
 * ProfileEditor — modal dialog for creating and editing profiles.
 *
 * Create mode: all fields editable, Access Key ID + Secret required.
 * Edit mode:   display name, region, and compat flags only — secrets are
 *              already in the keychain and are not re-entered here.
 *
 * OCP:
 * - Compat flags are rendered from a config list (`COMPAT_FLAG_FIELDS`).
 *   Adding a new flag = one entry in the list, no JSX change.
 * - The collapsible compat section is self-contained; the rest of the form
 *   does not know about flags.
 * - Common regions list is separate from form logic.
 */

import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  type CompatFlags,
  profileCreateManual,
  profileGet,
  profileUpdate,
  profileValidate,
  type ValidationReport,
} from "@/api/profiles";
import { EditorPanel } from "@/components/EditorPanel";
import { Button } from "@/components/ui/button";
import { keys } from "@/query/keys";

// ---------------------------------------------------------------------------
// Common region suggestions
// ---------------------------------------------------------------------------

const COMMON_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "sa-east-1",
];

// ---------------------------------------------------------------------------
// Compat flag field configuration
// ---------------------------------------------------------------------------

/** Each entry maps to one field in the collapsible compat section. OCP. */
interface BoolFlagDef {
  kind: "bool";
  key: keyof CompatFlags;
  label: string;
  description?: string;
}

interface SelectFlagDef<T extends string = string> {
  kind: "select";
  key: keyof CompatFlags;
  label: string;
  options: Array<{ value: T; label: string }>;
  description?: string;
}

interface TextFlagDef {
  kind: "text";
  key: keyof CompatFlags;
  label: string;
  placeholder?: string;
  description?: string;
}

type CompatFlagDef = BoolFlagDef | SelectFlagDef | TextFlagDef;

const COMPAT_FLAG_FIELDS: CompatFlagDef[] = [
  {
    kind: "text",
    key: "endpointUrl",
    label: "Endpoint URL",
    placeholder: "https://s3.example.com",
    description: "Custom S3-compatible endpoint (MinIO, R2, Wasabi, etc.)",
  },
  {
    kind: "select",
    key: "addressingStyle",
    label: "Addressing style",
    options: [
      { value: "auto", label: "Auto" },
      { value: "virtual", label: "Virtual-hosted" },
      { value: "path", label: "Path-style" },
    ],
  },
  {
    kind: "select",
    key: "signatureVersion",
    label: "Signature version",
    options: [
      { value: "v4", label: "SigV4 (default)" },
      { value: "v2", label: "SigV2 (legacy)" },
    ],
  },
  {
    kind: "select",
    key: "checksumMode",
    label: "Checksum mode",
    options: [
      { value: "enabled", label: "Enabled (default)" },
      { value: "disabled", label: "Disabled" },
    ],
  },
  {
    kind: "bool",
    key: "acceptInvalidCerts",
    label: "Accept invalid TLS certificates",
    description: "Use only for local development or self-signed certs",
  },
  {
    kind: "bool",
    key: "expectContinue",
    label: "Use Expect: 100-continue",
    description: "Some proxies require this header to be omitted",
  },
  {
    kind: "bool",
    key: "chunkedUpload",
    label: "Chunked upload encoding",
    description: "Disable if your endpoint rejects chunked transfer encoding",
  },
  {
    kind: "bool",
    key: "disableBucketNameValidation",
    label: "Disable bucket name validation",
    description: "Allow non-DNS-compliant bucket names",
  },
];

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  displayName: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  defaultRegion: string;
  compatFlags: CompatFlags;
}

const initialForm: FormState = {
  displayName: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  defaultRegion: "",
  compatFlags: {},
};

type FormAction =
  | {
      type: "set_field";
      field: keyof Omit<FormState, "compatFlags">;
      value: string;
    }
  | { type: "set_compat"; key: keyof CompatFlags; value: unknown }
  | { type: "reset"; state: FormState };

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "set_field":
      return { ...state, [action.field]: action.value };
    case "set_compat":
      return {
        ...state,
        compatFlags: { ...state.compatFlags, [action.key]: action.value },
      };
    case "reset":
      return action.state;
  }
}

// ---------------------------------------------------------------------------
// ProfileEditor
// ---------------------------------------------------------------------------

export interface ProfileEditorProps {
  mode: "create" | "edit";
  /** Required when mode is "edit". */
  profileId?: string;
  onClose(): void;
  onSuccess(): void;
}

export function ProfileEditor({
  mode,
  profileId,
  onClose,
  onSuccess,
}: ProfileEditorProps) {
  const [state, dispatch] = useReducer(formReducer, initialForm);
  const [errors, setErrors] = useState<
    Partial<Record<keyof FormState, string>>
  >({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [compatOpen, setCompatOpen] = useState(false);

  // Validation result inline display
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] =
    useState<ValidationReport | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Ref to first focusable field for auto-focus
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // Tracks whether we've already seeded the form from profileDetail to avoid
  // re-seeding on subsequent re-renders (e.g. TanStack Query cache updates).
  const formSeededRef = useRef(false);

  // Load profile data in edit mode
  const { data: profileDetail } = useQuery({
    queryKey: keys.profile(profileId ?? ""),
    queryFn: () => profileGet(profileId ?? ""),
    enabled: mode === "edit" && profileId !== undefined,
  });

  // Populate form when profile detail first arrives — only once.
  useEffect(() => {
    if (
      mode === "edit" &&
      profileDetail !== undefined &&
      !formSeededRef.current
    ) {
      formSeededRef.current = true;
      dispatch({
        type: "reset",
        state: {
          displayName: profileDetail.displayName,
          accessKeyId: "",
          secretAccessKey: "",
          sessionToken: "",
          defaultRegion: profileDetail.defaultRegion ?? "",
          compatFlags: profileDetail.compatFlags,
        },
      });
    }
  }, [mode, profileDetail]);

  // Auto-focus first field on open
  useEffect(() => {
    const id = window.setTimeout(() => {
      firstFieldRef.current?.focus();
    }, 50);
    return () => clearTimeout(id);
  }, []);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  function validate(): boolean {
    const next: typeof errors = {};
    if (state.displayName.trim().length === 0) {
      next.displayName = "Display name is required.";
    }
    if (mode === "create") {
      if (state.accessKeyId.trim().length === 0) {
        next.accessKeyId = "Access Key ID is required.";
      }
      if (state.secretAccessKey.trim().length === 0) {
        next.secretAccessKey = "Secret Access Key is required.";
      }
    }
    const url = state.compatFlags.endpointUrl;
    if (url !== undefined && url.length > 0) {
      try {
        new URL(url);
      } catch {
        next.compatFlags = "Endpoint URL must be a valid URL.";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitError(null);
    setSubmitting(true);

    try {
      if (mode === "create") {
        await profileCreateManual({
          name: state.displayName.trim(),
          accessKeyId: state.accessKeyId.trim(),
          secretAccessKey: state.secretAccessKey,
          sessionToken:
            state.sessionToken.trim().length > 0
              ? state.sessionToken.trim()
              : undefined,
          defaultRegion:
            state.defaultRegion.trim().length > 0
              ? state.defaultRegion.trim()
              : undefined,
          compatFlags:
            Object.keys(state.compatFlags).length > 0
              ? state.compatFlags
              : undefined,
        });
      } else if (profileId !== undefined) {
        await profileUpdate(profileId, {
          displayName: state.displayName.trim(),
          defaultRegion:
            state.defaultRegion.trim().length > 0
              ? state.defaultRegion.trim()
              : undefined,
          compatFlags: state.compatFlags,
        });
      }
      onSuccess();
    } catch (err: unknown) {
      const msg =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : "An unexpected error occurred.";
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Inline validation probe
  // ---------------------------------------------------------------------------

  async function handleValidate() {
    if (profileId === undefined) return;
    setValidating(true);
    setValidationResult(null);
    setValidationError(null);
    try {
      const report = await profileValidate(profileId);
      setValidationResult(report);
    } catch (err: unknown) {
      const msg =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : "Validation failed.";
      setValidationError(msg);
    } finally {
      setValidating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderCompatField(fieldDef: CompatFlagDef) {
    const key = fieldDef.key;
    const value = state.compatFlags[key];

    if (fieldDef.kind === "bool") {
      return (
        <label
          key={String(key)}
          className="flex items-start gap-2 text-sm cursor-pointer"
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={typeof value === "boolean" ? value : false}
            onChange={(e) =>
              dispatch({
                type: "set_compat",
                key,
                value: e.currentTarget.checked,
              })
            }
          />
          <span>
            <span className="font-medium">{fieldDef.label}</span>
            {fieldDef.description !== undefined && (
              <span className="block text-xs text-muted-foreground">
                {fieldDef.description}
              </span>
            )}
          </span>
        </label>
      );
    }

    if (fieldDef.kind === "select") {
      return (
        <div key={String(key)} className="flex flex-col gap-1">
          <label
            htmlFor={`compat-${String(key)}`}
            className="text-sm font-medium"
          >
            {fieldDef.label}
          </label>
          <select
            id={`compat-${String(key)}`}
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={typeof value === "string" ? value : ""}
            onChange={(e) =>
              dispatch({
                type: "set_compat",
                key,
                value: e.currentTarget.value || undefined,
              })
            }
          >
            <option value="">Default</option>
            {fieldDef.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    // text
    return (
      <div key={String(key)} className="flex flex-col gap-1">
        <label
          htmlFor={`compat-${String(key)}`}
          className="text-sm font-medium"
        >
          {fieldDef.label}
        </label>
        <input
          id={`compat-${String(key)}`}
          type="text"
          placeholder={fieldDef.kind === "text" ? fieldDef.placeholder : ""}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={typeof value === "string" ? value : ""}
          onChange={(e) =>
            dispatch({
              type: "set_compat",
              key,
              value: e.currentTarget.value || undefined,
            })
          }
        />
        {fieldDef.description !== undefined && (
          <p className="text-xs text-muted-foreground">
            {fieldDef.description}
          </p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------

  const title = mode === "create" ? "Add profile" : "Edit profile";
  const description =
    mode === "create"
      ? "Create a manual profile. Credentials are stored in the OS keychain and never exposed to the WebView."
      : "Edit the display name, default region, and S3-compatibility flags. Secrets stay in the keychain.";

  // Form is wired to a stable id so the sticky footer's submit button can
  // submit it without being a descendant of <form>.
  const formId = "profile-editor-form";

  return (
    <EditorPanel
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting
              ? mode === "create"
                ? "Creating…"
                : "Saving…"
              : mode === "create"
                ? "Create profile"
                : "Save changes"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-4">
          {/* Display name */}
          <div className="flex flex-col gap-1">
            <label htmlFor="pe-display-name" className="text-sm font-medium">
              Display name <span aria-hidden="true">*</span>
            </label>
            <input
              id="pe-display-name"
              ref={firstFieldRef}
              type="text"
              autoComplete="off"
              required
              aria-invalid={errors.displayName !== undefined}
              aria-describedby={
                errors.displayName !== undefined
                  ? "pe-display-name-err"
                  : undefined
              }
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
              value={state.displayName}
              onChange={(e) =>
                dispatch({
                  type: "set_field",
                  field: "displayName",
                  value: e.currentTarget.value,
                })
              }
            />
            {errors.displayName !== undefined && (
              <p id="pe-display-name-err" className="text-xs text-destructive">
                {errors.displayName}
              </p>
            )}
          </div>

          {/* Secret fields — create mode only */}
          {mode === "create" && (
            <>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="pe-access-key-id"
                  className="text-sm font-medium"
                >
                  Access Key ID <span aria-hidden="true">*</span>
                </label>
                <input
                  id="pe-access-key-id"
                  type="text"
                  autoComplete="off"
                  required
                  aria-invalid={errors.accessKeyId !== undefined}
                  aria-describedby={
                    errors.accessKeyId !== undefined
                      ? "pe-access-key-id-err"
                      : undefined
                  }
                  className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
                  value={state.accessKeyId}
                  onChange={(e) =>
                    dispatch({
                      type: "set_field",
                      field: "accessKeyId",
                      value: e.currentTarget.value,
                    })
                  }
                />
                {errors.accessKeyId !== undefined && (
                  <p
                    id="pe-access-key-id-err"
                    className="text-xs text-destructive"
                  >
                    {errors.accessKeyId}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="pe-secret-access-key"
                  className="text-sm font-medium"
                >
                  Secret Access Key <span aria-hidden="true">*</span>
                </label>
                <input
                  id="pe-secret-access-key"
                  type="password"
                  autoComplete="new-password"
                  required
                  aria-invalid={errors.secretAccessKey !== undefined}
                  aria-describedby={
                    errors.secretAccessKey !== undefined
                      ? "pe-secret-access-key-err"
                      : undefined
                  }
                  className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
                  value={state.secretAccessKey}
                  onChange={(e) =>
                    dispatch({
                      type: "set_field",
                      field: "secretAccessKey",
                      value: e.currentTarget.value,
                    })
                  }
                />
                {errors.secretAccessKey !== undefined && (
                  <p
                    id="pe-secret-access-key-err"
                    className="text-xs text-destructive"
                  >
                    {errors.secretAccessKey}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="pe-session-token"
                  className="text-sm font-medium"
                >
                  Session token{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </label>
                <input
                  id="pe-session-token"
                  type="password"
                  autoComplete="new-password"
                  className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={state.sessionToken}
                  onChange={(e) =>
                    dispatch({
                      type: "set_field",
                      field: "sessionToken",
                      value: e.currentTarget.value,
                    })
                  }
                />
              </div>
            </>
          )}

          {/* Edit mode: note that secrets are stored in keychain */}
          {mode === "edit" && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
              Credentials are stored securely in the OS keychain and cannot be
              viewed or changed here. Delete and re-create the profile to update
              credentials.
            </p>
          )}

          {/* Default region */}
          <div className="flex flex-col gap-1">
            <label htmlFor="pe-default-region" className="text-sm font-medium">
              Default region{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </label>
            <input
              id="pe-default-region"
              type="text"
              list="pe-region-list"
              autoComplete="off"
              placeholder="e.g. us-east-1"
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={state.defaultRegion}
              onChange={(e) =>
                dispatch({
                  type: "set_field",
                  field: "defaultRegion",
                  value: e.currentTarget.value,
                })
              }
            />
            <datalist id="pe-region-list">
              {COMMON_REGIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>

          {/* Compat flags — collapsible */}
          <div className="rounded-lg border border-border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
              aria-expanded={compatOpen}
              aria-controls="pe-compat-section"
              onClick={() => setCompatOpen((v) => !v)}
            >
              <span>Compatibility flags</span>
              {compatOpen ? (
                <ChevronDownIcon className="size-4 text-muted-foreground" />
              ) : (
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              )}
            </button>

            {compatOpen && (
              <div
                id="pe-compat-section"
                className="flex flex-col gap-3 border-t px-3 py-3"
              >
                {errors.compatFlags !== undefined && (
                  <p className="text-xs text-destructive">
                    {errors.compatFlags}
                  </p>
                )}
                {COMPAT_FLAG_FIELDS.map((f) => renderCompatField(f))}
              </div>
            )}
          </div>

          {/* Inline validation result (edit mode) */}
          {mode === "edit" && profileId !== undefined && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={validating}
                  aria-busy={validating}
                  onClick={handleValidate}
                >
                  {validating ? "Validating…" : "Validate credentials"}
                </Button>
              </div>

              {validationResult !== null && (
                <div
                  role="status"
                  className={`rounded-lg px-3 py-2 text-sm ${
                    validationResult.ok
                      ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
                      : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300"
                  }`}
                >
                  {validationResult.ok ? (
                    <>
                      <span className="font-medium">Valid</span>
                      {validationResult.accountId !== undefined && (
                        <span> — Account: {validationResult.accountId}</span>
                      )}
                      {validationResult.arn !== undefined && (
                        <span className="block text-xs mt-0.5 opacity-80">
                          {validationResult.arn}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="font-medium">Invalid</span>
                      {validationResult.error !== undefined && (
                        <span> — {validationResult.error.message}</span>
                      )}
                    </>
                  )}
                </div>
              )}

              {validationError !== null && (
                <p role="alert" className="text-sm text-destructive">
                  {validationError}
                </p>
              )}
            </div>
          )}

          {/* Submit error */}
          {submitError !== null && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}
        </div>
      </form>
    </EditorPanel>
  );
}
