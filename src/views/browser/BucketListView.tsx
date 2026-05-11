/**
 * BucketListView — main-pane content when a profile is selected but no
 * bucket has been chosen yet. Lists buckets for the active profile and
 * navigates into one on click.
 *
 * Reachability:
 *   AppShell mounts this when `activePane.location.bucket === null`.
 *   Selecting a bucket sets `location.bucket` and the dispatcher swaps
 *   to a real view-mode component (Details, IconGrid, …).
 *
 * State matrix:
 *   isGated  → validation prompt (profile.validatedAt is null)
 *   isLoading → spinner row
 *   error    → inline error with retry hint
 *   empty    → "no buckets" copy
 *   data     → row list (name, region, age)
 *
 * OCP: extending the row to show extra metadata (tags, access points)
 * is one new <span> per row — no structural changes.
 */

import { DatabaseIcon } from "lucide-react";
import { useMemo } from "react";
import { formatRelative } from "@/lib/format";
import { fuzzyFilter } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { useBuckets } from "@/query/hooks/useValidatedProfile";
import { usePanesStore } from "@/store/panes";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BucketListViewProps {
  profileId: string;
  /** Optional bucket name to mark as the active row (none by default). */
  activeBucket?: string | null;
}

// ---------------------------------------------------------------------------
// BucketListView
// ---------------------------------------------------------------------------

export function BucketListView({
  profileId,
  activeBucket,
}: BucketListViewProps) {
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const setLocation = usePanesStore((s) => s.setLocation);
  const filter = usePanesStore(
    (s) => s.panes.find((p) => p.id === s.activePaneId)?.filter ?? "",
  );
  const { data: buckets, isLoading, isGated, error } = useBuckets(profileId);

  // Apply the pane's inline fuzzy filter. Memoised because useBuckets returns
  // a fresh array reference on every revalidation tick.
  const visibleBuckets = useMemo(
    () => (buckets ? fuzzyFilter(buckets, filter, (b) => b.name) : buckets),
    [buckets, filter],
  );

  function navigateInto(bucket: string) {
    setLocation(activePaneId, { profileId, bucket, prefix: "" });
  }

  if (isGated) {
    return (
      <Message
        title="Profile not validated"
        body="Validate the profile from the sidebar before listing its buckets."
      />
    );
  }

  if (isLoading) {
    return <Message title="Loading buckets…" />;
  }

  if (error) {
    return (
      <Message
        title="Failed to load buckets"
        body={error.message}
        tone="error"
      />
    );
  }

  if (!buckets || buckets.length === 0) {
    return (
      <Message
        title="No buckets found"
        body="This profile has access to zero buckets in S3."
      />
    );
  }

  if (visibleBuckets && visibleBuckets.length === 0 && filter) {
    return (
      <Message
        title={`No bucket matches "${filter}"`}
        body="Clear the filter (Esc) or refine your query."
      />
    );
  }

  return (
    <ul aria-label="Bucket list" className="flex h-full flex-col overflow-auto">
      {(visibleBuckets ?? buckets).map((bucket) => {
        const isActive = bucket.name === activeBucket;
        return (
          <li
            key={bucket.name}
            className={cn(
              "border-b border-border/40",
              isActive && "bg-accent/40",
            )}
          >
            <button
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => navigateInto(bucket.name)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50"
            >
              <DatabaseIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {bucket.name}
              </span>
              {bucket.region && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {bucket.region}
                </span>
              )}
              {bucket.creationDate !== undefined && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelative(bucket.creationDate)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Message — uniform centered status block reused by every empty-ish state.
// ---------------------------------------------------------------------------

interface MessageProps {
  title: string;
  body?: string;
  tone?: "default" | "error";
}

function Message({ title, body, tone = "default" }: MessageProps) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <p
        className={cn(
          "text-sm font-medium",
          tone === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {title}
      </p>
      {body && <p className="text-xs text-muted-foreground">{body}</p>}
    </div>
  );
}
