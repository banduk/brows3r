/**
 * usePeriodicProfileRefresh — silently re-validate every already-validated
 * profile on a fixed cadence so session-scoped credentials don't go stale
 * between user interactions.
 *
 * Off by default (opt-in via Settings → General → "Auto-refresh
 * validation"). When enabled, fires `profile_validate` for every profile
 * that already has a `validatedAt` — never forces validation for a
 * profile the user hasn't used yet. Errors update the validation store
 * (red dot + tooltip) instead of being surfaced as toasts; the refresh
 * is background-only.
 *
 * Mount once at the app root.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { profilesList, profileValidate } from "@/api/profiles";
import { isAppError } from "@/lib/errors";
import { keys } from "@/query/keys";
import {
  useValidationPrefsStore,
  useValidationStore,
} from "@/store/validation";

export function usePeriodicProfileRefresh(): void {
  const queryClient = useQueryClient();
  const enabled = useValidationPrefsStore((s) => s.periodicRefreshEnabled);
  const minutes = useValidationPrefsStore((s) => s.periodicRefreshMinutes);

  useEffect(() => {
    if (!enabled) return;
    if (minutes <= 0) return;

    const intervalMs = minutes * 60 * 1000;
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        const profiles = await profilesList();
        const validated = profiles.filter((p) => p.validatedAt != null);
        await Promise.allSettled(
          validated.map(async (p) => {
            const store = useValidationStore.getState();
            store.startValidating(p.id);
            try {
              const report = await profileValidate(p.id);
              if (cancelled) return;
              if (report.ok) {
                store.markOk(p.id);
              } else if (report.error) {
                store.markError(p.id, report.error);
              }
            } catch (err) {
              if (cancelled) return;
              store.markError(
                p.id,
                isAppError(err)
                  ? err
                  : {
                      kind: "Internal",
                      message: err instanceof Error ? err.message : String(err),
                      retryable: false,
                      details: { traceId: "periodic_refresh_throw" },
                    },
              );
            }
          }),
        );
        if (!cancelled) {
          await queryClient.invalidateQueries({ queryKey: keys.profiles() });
        }
      } catch {
        // Periodic refresh is best-effort. Errors fetching the list are
        // benign — next tick will try again.
      }
    }

    const handle = window.setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [enabled, minutes, queryClient]);
}
