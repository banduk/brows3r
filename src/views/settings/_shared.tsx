/**
 * Shared form primitives for settings panels.
 *
 * OCP: each panel is fully independent. These helpers reduce boilerplate
 * without coupling panels to each other.
 */

import type * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// FieldRow — label + input wrapper with optional error
// ---------------------------------------------------------------------------

interface FieldRowProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}

export function FieldRow({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: FieldRowProps) {
  const errId = error !== undefined ? `${htmlFor}-err` : undefined;
  const hintId = hint !== undefined ? `${htmlFor}-hint` : undefined;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {children}
      {error !== undefined && (
        <p id={errId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeading — panel-level section title
// ---------------------------------------------------------------------------

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// PanelActions — reset + save button row
// ---------------------------------------------------------------------------

interface PanelActionsProps {
  onReset(): void;
  onSave(): void;
  saving?: boolean;
  resetLabel?: string;
}

export function PanelActions({
  onReset,
  onSave,
  saving = false,
  resetLabel = "Reset to defaults",
}: PanelActionsProps) {
  return (
    <div className="flex items-center justify-between pt-2 border-t">
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        onClick={onReset}
      >
        {resetLabel}
      </button>
      <button
        type="button"
        disabled={saving}
        aria-busy={saving}
        className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        onClick={onSave}
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NumberInput — numeric input with min/max/step
// ---------------------------------------------------------------------------

interface NumberInputProps {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

export function NumberInput({
  id,
  value,
  min,
  max,
  step = 1,
  onChange,
  "aria-describedby": ariaDescribedby,
  "aria-invalid": ariaInvalid,
}: NumberInputProps) {
  return (
    <input
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-describedby={ariaDescribedby}
      aria-invalid={ariaInvalid}
      className="h-8 w-36 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
      onChange={(e) => {
        const n = Number(e.currentTarget.value);
        if (!Number.isNaN(n)) onChange(n);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// ToggleSwitch — accessible checkbox styled as a toggle
// ---------------------------------------------------------------------------

interface ToggleSwitchProps {
  id: string;
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  description?: string;
}

export function ToggleSwitch({
  id,
  checked,
  onChange,
  label,
  description,
}: ToggleSwitchProps) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 cursor-pointer select-none"
    >
      <input
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        id={id}
        type="checkbox"
        className="mt-0.5 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>
        <span className="text-sm font-medium">{label}</span>
        {description !== undefined && (
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
