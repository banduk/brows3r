/**
 * Recents sidebar panel.
 *
 * Shows the 10 most recent S3 locations by default.  A "Show all" button
 * reveals up to 50.
 *
 * Validation gate (round-1 finding #9): rows for unvalidated profiles are
 * rendered as disabled via `useValidatedProfile(entry.profileId)`.
 *
 * Auto-tracking: `useRecentAutoTrack` subscribes to `usePanesStore` and calls
 * `recentTrack(...)` after every pane location change.  It must be mounted
 * once at the application root (App.tsx) so tracking happens regardless of
 * whether the sidebar is visible.
 *
 * OCP: adding a new "show recent by profile" filter = one new prop.  The
 * validation gate is uniform.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
// `useEffect` is also used to surface the recents-list fetch error.
import type { RecentLocation } from "@/api/bookmarks";
import { recentsClear, recentsList, recentTrack } from "@/api/bookmarks";
import { Button } from "@/components/ui/button";
import { surfaceUnknownError } from "@/lib/errors";
import { useValidatedProfile } from "@/query/hooks/useValidatedProfile";
import { keys } from "@/query/keys";
import { usePanesStore } from "@/store/panes";

// Visible rows by default before "Show all".
const DEFAULT_VISIBLE = 10;

// ---------------------------------------------------------------------------
// RecentRow
// ---------------------------------------------------------------------------

interface RecentRowProps {
  entry: RecentLocation;
  isActive: boolean;
  onNavigate(entry: RecentLocation): void;
}

function RecentRow({ entry, isActive, onNavigate }: RecentRowProps) {
  const { isValidated } = useValidatedProfile(entry.profileId);

  const displayLabel = entry.prefix || entry.bucket;

  if (!isValidated) {
    return (
      <li
        className="flex cursor-not-allowed items-center gap-2 px-3 py-2 opacity-50"
        title="Validate this profile to use this location"
        aria-disabled="true"
      >
        <ClockIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {displayLabel}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Validate to use
        </span>
      </li>
    );
  }

  return (
    <li
      className={`flex items-center hover:bg-accent/50 ${
        isActive ? "bg-accent/40" : ""
      }`}
    >
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left"
        onClick={() => onNavigate(entry)}
      >
        <ClockIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            isActive ? "font-medium" : ""
          }`}
        >
          {displayLabel}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Recents (main export)
// ---------------------------------------------------------------------------

export function Recents() {
  const queryClient = useQueryClient();
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const setLocation = usePanesStore((s) => s.setLocation);
  const activeLocation = usePanesStore(
    (s) => s.panes.find((p) => p.id === s.activePaneId)?.location ?? null,
  );

  const [showAll, setShowAll] = useState(false);

  const {
    data: recents = [],
    isLoading,
    error: recentsError,
  } = useQuery({
    queryKey: keys.recents(),
    queryFn: recentsList,
  });

  // Surface persistent recents fetch failures so the sidebar does not
  // silently stick on "Loading recents…" when the backend keeps failing.
  useEffect(() => {
    if (!recentsError) return;
    void surfaceUnknownError(recentsError, {
      operation: "recents_list",
      context: "background",
      title: "Failed to load recents",
    });
  }, [recentsError]);

  const clearMutation = useMutation({
    mutationFn: recentsClear,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.recents() });
    },
    onError: (err) =>
      surfaceUnknownError(err, {
        operation: "recents_clear",
        title: "Failed to clear recents",
      }),
  });

  function handleNavigate(entry: RecentLocation) {
    setLocation(activePaneId, {
      profileId: entry.profileId,
      bucket: entry.bucket,
      prefix: entry.prefix,
    });
  }

  const visible = showAll ? recents : recents.slice(0, DEFAULT_VISIBLE);
  const hasMore = recents.length > DEFAULT_VISIBLE;

  return (
    <section aria-label="Recent locations">
      {isLoading && !recentsError && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Loading recents…
        </p>
      )}

      {recentsError && (
        <p
          className="px-3 py-2 text-xs text-destructive"
          role="alert"
          data-testid="recents-load-error"
        >
          Failed to load recents.{" "}
          {recentsError instanceof Error
            ? recentsError.message
            : "Check the notifications panel for details."}
        </p>
      )}

      {!isLoading && !recentsError && recents.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No recent locations.
        </p>
      )}

      <ul aria-label="Recent locations list">
        {visible.map((entry) => (
          <RecentRow
            key={`${entry.profileId}/${entry.bucket}/${entry.prefix}`}
            entry={entry}
            isActive={
              activeLocation?.profileId === entry.profileId &&
              activeLocation?.bucket === entry.bucket &&
              (activeLocation?.prefix ?? "") === entry.prefix
            }
            onNavigate={handleNavigate}
          />
        ))}
      </ul>

      {!showAll && hasMore && (
        <button
          type="button"
          className="w-full px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          Show all ({recents.length})
        </button>
      )}

      {showAll && hasMore && (
        <button
          type="button"
          className="w-full px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll(false)}
        >
          Show less
        </button>
      )}

      {recents.length > 0 && (
        <div className="px-3 py-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto py-0.5 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => clearMutation.mutate()}
          >
            Clear recents
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// useRecentAutoTrack — mount once at the app root
// ---------------------------------------------------------------------------

/**
 * Hook that subscribes to `usePanesStore` and calls `recentTrack(...)` after
 * every pane location change.
 *
 * Mount this once in `App.tsx` (outside the sidebar) so it fires even when
 * the Recents panel is not visible.
 *
 * The hook invalidates `keys.recents()` after a successful track so the
 * sidebar updates without a manual refresh.
 */
export function useRecentAutoTrack(): void {
  const queryClient = useQueryClient();
  // Stable reference to the current active pane's location.
  const panes = usePanesStore((s) => s.panes);
  const activePaneId = usePanesStore((s) => s.activePaneId);

  // Track the last-known location per pane so we only fire on actual changes.
  const prevRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const pane = panes.find((p) => p.id === activePaneId);
    const loc = pane?.location;

    // Only track when we have a fully-qualified location (profile + bucket).
    if (!loc?.bucket) return;

    const key = `${loc.profileId}/${loc.bucket}/${loc.prefix}`;
    const prev = prevRef.current.get(activePaneId);

    if (prev === key) return; // no change
    prevRef.current.set(activePaneId, key);

    // Fire and forget — tracking errors must never surface to the user.
    void recentTrack(loc.profileId, loc.bucket, loc.prefix).then(() => {
      void queryClient.invalidateQueries({ queryKey: keys.recents() });
    });
  }, [panes, activePaneId, queryClient]);
}
