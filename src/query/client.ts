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

import { QueryClient } from "@tanstack/react-query";

import { type AppError, isAppError } from "@/lib/errors";
import { listen } from "@/lib/tauri";
import { keys } from "./keys";

// ---------------------------------------------------------------------------
// QueryClient
// ---------------------------------------------------------------------------

export const queryClient = new QueryClient({
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
      // Side-effect: surface a "Download complete" toast with a clickable
      // "Open folder" action when a download finishes successfully. Kept
      // inline (rather than inside applyStateEvent) so the store stays a
      // pure reducer.
      if (payload.state === "done") {
        import("./notifyDownloadComplete").then(
          ({ notifyDownloadComplete }) => {
            notifyDownloadComplete(payload.requestId);
          },
        );
      }
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
