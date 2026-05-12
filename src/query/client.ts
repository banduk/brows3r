/**
 * TanStack Query client configured for Tauri.
 *
 * Design choices:
 * - `staleTime: 30_000` — matches Rust SWR TTL cap; Tauri events drive
 *   invalidation so window-focus refetches are disabled.
 * - `retry` delegates to `AppError.retryable` — only `Network` and
 *   `RateLimited` errors are retried (up to 3 times).
 * - `installEventBridge` wires Tauri event listeners that translate
 *   backend events into `queryClient.invalidateQueries` calls. It must
 *   be called once on app mount and the returned cleanup must be called
 *   on unmount.
 */

import { QueryCache, QueryClient } from "@tanstack/react-query";

import { profileValidate } from "@/api/profiles";
import { type AppError, isAppError } from "@/lib/errors";
import { listen } from "@/lib/tauri";
import { useValidationStore } from "@/store/validation";
import { keys } from "./keys";

// ---------------------------------------------------------------------------
// Auth-error auto-recovery
// ---------------------------------------------------------------------------

/**
 * Track query-keys we have already attempted to recover from once this
 * session. Without this guard a persistently-failing query (e.g. an
 * actually-revoked credential) would loop revalidate → retry → fail →
 * revalidate forever.
 */
const recoveryAttempts = new Set<string>();

/**
 * Extract the profileId from a query key. Most of our keys are tuples of
 * the form `[domain, profileId, ...]` so the second element is the
 * profile. Returns null when the shape does not match.
 */
function profileIdFromQueryKey(queryKey: readonly unknown[]): string | null {
  const head = queryKey[0];
  if (typeof head !== "string") return null;
  // Keys like keys.profiles() are just ["profiles"]; not profile-scoped.
  if (queryKey.length < 2) return null;
  const second = queryKey[1];
  return typeof second === "string" ? second : null;
}

/**
 * Auth-error auto-recovery handler.
 *
 * When a gated query fails with `Auth` or `AccessDenied`, the most
 * common cause is a session-scoped credential going stale (SSO token
 * lifetime expired between launches, role chain rotated, etc.). Rather
 * than make the user click Validate again, we transparently re-validate
 * the profile and invalidate the failed query so it retries with fresh
 * credentials.
 */
function handleAuthError(
  client: QueryClient,
  queryKey: readonly unknown[],
  error: AppError,
): void {
  if (error.kind !== "Auth" && error.kind !== "AccessDenied") return;
  const profileId = profileIdFromQueryKey(queryKey);
  if (!profileId) return;

  // Deduplicate: per (profileId, queryKey) pair.
  const fingerprint = `${profileId}|${JSON.stringify(queryKey)}`;
  if (recoveryAttempts.has(fingerprint)) return;
  recoveryAttempts.add(fingerprint);

  // Kick off revalidation. Mark the store so the UI shows the spinner.
  useValidationStore.getState().startValidating(profileId);
  void profileValidate(profileId)
    .then(async (report) => {
      await client.invalidateQueries({ queryKey: keys.profiles() });
      if (report.ok) {
        useValidationStore.getState().markOk(profileId);
        // Refetch the failed query now that we have fresh creds.
        await client.invalidateQueries({ queryKey });
      } else if (report.error) {
        useValidationStore.getState().markError(profileId, report.error);
      }
    })
    .catch((err: unknown) => {
      useValidationStore.getState().markError(
        profileId,
        isAppError(err)
          ? err
          : {
              kind: "Internal",
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
              details: { traceId: "auth_recovery_throw" },
            },
      );
    });
}

// ---------------------------------------------------------------------------
// QueryClient
// ---------------------------------------------------------------------------

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(error, query) {
      if (!isAppError(error)) return;
      handleAuthError(queryClient, query.queryKey, error as AppError);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) =>
        failureCount < 3 && isAppError(error) && (error as AppError).retryable,
    },
    mutations: {
      retry: false,
    },
  },
});

/** Test-only: forget every auth-recovery attempt so a unit test can re-run. */
export function _resetAuthRecoveryAttempts(): void {
  recoveryAttempts.clear();
}

// ---------------------------------------------------------------------------
// Event bridge
// ---------------------------------------------------------------------------

/**
 * Register Tauri event listeners that drive query invalidation.
 *
 * Returns a cleanup function that unlisten all registered listeners.
 * Call it when the app tears down (e.g. in a React effect cleanup).
 *
 * `notification:new` is forwarded here but NOT invalidated via TanStack Query —
 * it will be pushed into the notifications Zustand store once that lands
 * in task 22. The invalidation of the `notifications` query key is still
 * triggered so list-based consumers stay fresh.
 */
export async function installEventBridge(
  client: QueryClient = queryClient,
): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen("objects:updated", ({ profileId, bucket, prefix }) => {
      client.invalidateQueries({
        queryKey: keys.objects(profileId, bucket, prefix),
      });
      client.invalidateQueries({
        queryKey: keys.objectsFlat(profileId, bucket, prefix),
      });
      client.invalidateQueries({
        queryKey: keys.inspector(profileId, bucket),
      });
    }),

    listen("buckets:updated", ({ profileId }) => {
      client.invalidateQueries({
        queryKey: keys.buckets(profileId),
      });
    }),

    listen("media:revoked", (_payload) => {
      client.invalidateQueries({
        queryKey: keys.media(),
      });
    }),

    listen("notification:new", (payload) => {
      // Push into the Zustand notifications store (task 22).
      import("@/store/notifications").then(({ useNotificationsStore }) => {
        useNotificationsStore.getState().add(payload);
      });
      // Also invalidate any query-based consumers.
      client.invalidateQueries({
        queryKey: keys.notifications(),
      });
    }),

    listen("transfer:progress", (payload) => {
      import("@/store/transfers").then(({ applyProgressEvent }) => {
        applyProgressEvent(payload);
      });
    }),

    listen("transfer:state", (payload) => {
      import("@/store/transfers").then(
        ({ applyStateEvent, useTransfersStore }) => {
          applyStateEvent(payload);
          // Auto-surface the panel (minimized) on the first running transition
          // so the user has an immediate, low-friction hook to monitor and
          // cancel the job. We only do this on the first running transition
          // to avoid re-opening a panel the user has explicitly closed.
          if (payload.state === "running") {
            useTransfersStore.getState().openPanelMinimized();
          }
        },
      );
      // Per-file completion toasts were removed: a single "Transfer
      // started" toast fires when seedTransfers runs, and the StatusBar
      // Activity chip + the Activity Center take over from there. See
      // notifyTransferStarted.ts for the rationale.
    }),

    // Lock events → push into the Zustand locks store so context menus and
    // other lock-aware UI can gate conflicting actions.
    listen("lock:acquired", (payload) => {
      import("@/store/locks").then(({ useLocksStore }) => {
        useLocksStore.getState().addLock(payload);
      });
    }),

    listen("lock:released", (payload) => {
      import("@/store/locks").then(({ useLocksStore }) => {
        useLocksStore.getState().removeLock(payload.lockId);
      });
    }),
  ]);

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
