/**
 * Per-profile validation status tracker.
 *
 * Owns the in-flight + last-error state for `profile_validate` mutations
 * so the sidebar dot, navigation gates, and any future "needs auth" UI
 * can render a unified status without each component repeating the
 * "did I dispatch a validate?" bookkeeping.
 *
 * The backend's `validatedAt` (returned in the profile summary) is still
 * the canonical "is this profile usable" signal — this store only adds
 * the transient state that lives between dispatching the mutation and
 * the next refetch of the profiles list.
 *
 * OCP: adding a new state (e.g. "rate-limited") = one new variant in
 * `ValidationStatus`.
 */

import { create } from "zustand";
import type { AppError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationStatus =
  | "idle" // never tried this session
  | "validating" // mutation in flight
  | "ok" // last attempt succeeded; backend's validatedAt is the truth
  | "error"; // last attempt surfaced an AppError

interface ValidationState {
  /** Per-profile current status. Missing key ≡ "idle". */
  statuses: ReadonlyMap<string, ValidationStatus>;
  /** Per-profile error from the most recent failed attempt, if any. */
  errors: ReadonlyMap<string, AppError>;

  /** Mark a profile as currently being validated. */
  startValidating(profileId: string): void;
  /** Mark a profile as successfully validated. */
  markOk(profileId: string): void;
  /** Mark a profile as failed with the given error. */
  markError(profileId: string, error: AppError): void;
  /** Reset everything (used by tests). */
  reset(): void;
}

export const useValidationStore = create<ValidationState>((set) => ({
  statuses: new Map(),
  errors: new Map(),

  startValidating(profileId) {
    set((s) => {
      const statuses = new Map(s.statuses);
      const errors = new Map(s.errors);
      statuses.set(profileId, "validating");
      errors.delete(profileId);
      return { statuses, errors };
    });
  },

  markOk(profileId) {
    set((s) => {
      const statuses = new Map(s.statuses);
      const errors = new Map(s.errors);
      statuses.set(profileId, "ok");
      errors.delete(profileId);
      return { statuses, errors };
    });
  },

  markError(profileId, error) {
    set((s) => {
      const statuses = new Map(s.statuses);
      const errors = new Map(s.errors);
      statuses.set(profileId, "error");
      errors.set(profileId, error);
      return { statuses, errors };
    });
  },

  reset() {
    set({ statuses: new Map(), errors: new Map() });
  },
}));

/** Convenience selector — never returns undefined. */
export function selectStatus(
  state: ValidationState,
  profileId: string,
): ValidationStatus {
  return state.statuses.get(profileId) ?? "idle";
}
