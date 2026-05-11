/**
 * Breadcrumb path bar.
 *
 * Renders the current S3 location as a sequence of clickable segments:
 *   Profile > bucket > segment > ... > current
 *
 * Behaviours:
 * - Each segment is a button that calls `usePanesStore.setLocation(...)`.
 * - Long paths collapse middle segments into an ellipsis; hover/tooltip
 *   shows the full path.
 * - Edit mode (Cmd+L or click on the background): an `<input>` replaces the
 *   segments; Enter parses the path and navigates.
 *
 * A11y:
 * - `nav` landmark, `aria-label="Breadcrumb"`.
 * - `aria-current="page"` on the last (current) segment.
 * - Keyboard: Tab moves between segments; Enter / Space activate a segment.
 * - Edit mode: input is focused immediately; Escape exits without navigating.
 *
 * OCP: adding new behaviours on segment click (e.g. Cmd+click opens a new
 * pane) = one `if (e.metaKey)` branch in `handleSegmentClick`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useProfilesList } from "@/query/hooks/useValidatedProfile";
import { usePanesStore } from "@/store/panes";
import type { S3Location } from "@/store/ui";

// ---------------------------------------------------------------------------
// Path parsing / serialisation helpers
// ---------------------------------------------------------------------------

/** Maximum segments shown before collapsing. */
const MAX_VISIBLE_SEGMENTS = 4;

interface Segment {
  label: string;
  location: S3Location;
}

function buildSegments(
  location: S3Location,
  profileDisplayName: string,
): Segment[] {
  const segments: Segment[] = [];

  // Root: profile name
  segments.push({
    label: profileDisplayName,
    location: { profileId: location.profileId, bucket: null, prefix: "" },
  });

  if (!location.bucket) return segments;

  // Bucket
  segments.push({
    label: location.bucket,
    location: {
      profileId: location.profileId,
      bucket: location.bucket,
      prefix: "",
    },
  });

  // Prefix segments (strip trailing slash for display)
  if (location.prefix) {
    const parts = location.prefix.replace(/\/$/, "").split("/").filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}/` : `${part}/`;
      segments.push({
        label: part,
        location: {
          profileId: location.profileId,
          bucket: location.bucket,
          prefix: accumulated,
        },
      });
    }
  }

  return segments;
}

function collapseSegments(segments: Segment[]): Array<Segment | "ellipsis"> {
  if (segments.length <= MAX_VISIBLE_SEGMENTS) return segments;

  // Always show first two (profile + bucket) and last two segments.
  // We checked length > 4 above, so all four indices are defined.
  const first = segments[0] as Segment;
  const second = segments[1] as Segment;
  const penultimate = segments[segments.length - 2] as Segment;
  const ultimate = segments[segments.length - 1] as Segment;
  return [first, second, "ellipsis", penultimate, ultimate];
}

/**
 * Parse a manually typed path into an S3Location.
 * Accepts:
 *   - `s3://bucket/prefix/`
 *   - `bucket/prefix/`
 *   - `bucket`
 */
function parsePath(raw: string, profileId: string): S3Location | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutScheme = trimmed.replace(/^s3:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");

  if (slashIdx === -1) {
    // Just a bucket name
    return { profileId, bucket: withoutScheme, prefix: "" };
  }

  const bucket = withoutScheme.slice(0, slashIdx);
  const prefix = withoutScheme.slice(slashIdx + 1);
  if (!bucket) return null;
  return { profileId, bucket, prefix };
}

// ---------------------------------------------------------------------------
// Breadcrumb component
// ---------------------------------------------------------------------------

interface BreadcrumbProps {
  /** Active pane id — drives which pane is navigated on segment click. */
  paneId: string;
  /** Current location of the pane (null = no profile selected). */
  location: S3Location | null;
  /** Display name for the active profile (used as first segment label). */
  profileDisplayName?: string;
}

export function Breadcrumb({
  paneId,
  location,
  profileDisplayName,
}: BreadcrumbProps) {
  const setLocation = usePanesStore((s) => s.setLocation);
  // Look up the active profile's display name when the caller didn't pass
  // one explicitly. Without this the breadcrumb shows "No profile" even when
  // a profile is selected but no bucket has been chosen yet.
  const { profiles } = useProfilesList();
  const resolvedProfileName =
    profileDisplayName ??
    profiles.find((p) => p.id === location?.profileId)?.displayName ??
    "No profile";
  const [editMode, setEditMode] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Enter edit mode when Cmd+L is pressed globally while this breadcrumb is
  // mounted. The shortcut mirrors most browser/file-manager conventions.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        enterEditMode();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  function currentPathString(): string {
    if (!location) return "";
    if (!location.bucket) return "";
    return location.prefix
      ? `${location.bucket}/${location.prefix}`
      : location.bucket;
  }

  function enterEditMode() {
    setEditValue(currentPathString());
    setEditMode(true);
  }

  // Focus the input whenever edit mode activates.
  useEffect(() => {
    if (editMode) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editMode]);

  function handleSegmentClick(seg: Segment) {
    setLocation(paneId, seg.location);
  }

  const handleEditConfirm = useCallback(() => {
    if (!location) {
      setEditMode(false);
      return;
    }
    const parsed = parsePath(editValue, location.profileId);
    if (parsed) {
      setLocation(paneId, parsed);
    }
    setEditMode(false);
  }, [editValue, location, paneId, setLocation]);

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleEditConfirm();
    if (e.key === "Escape") setEditMode(false);
  }

  // Build segments only when location is set.
  const segments = location
    ? buildSegments(location, resolvedProfileName)
    : [
        {
          label: resolvedProfileName,
          location: {
            profileId: "",
            bucket: null,
            prefix: "",
          } as S3Location,
        },
      ];
  const displayed = collapseSegments(segments);
  const allSegmentsTooltip = segments.map((s) => s.label).join(" / ");

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center">
      {editMode ? (
        // ----- Edit mode -----
        <input
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          ref={inputRef}
          type="text"
          aria-label="Navigate to path"
          value={editValue}
          onChange={(e) => setEditValue(e.currentTarget.value)}
          onKeyDown={handleEditKeyDown}
          onBlur={() => setEditMode(false)}
          className="w-full rounded border border-ring bg-background px-2 py-0.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        // ----- Segment mode -----
        // Clicking the background whitespace enters edit mode.
        <ol
          className="flex min-w-0 cursor-text items-center gap-0.5 text-sm"
          title={allSegmentsTooltip}
          onClick={(e) => {
            // Only trigger edit mode when clicking the <ol> background, not a segment button.
            if ((e.target as HTMLElement).tagName === "OL") {
              enterEditMode();
            }
          }}
          onKeyDown={(e) => {
            // Allow keyboard users to enter edit mode when pressing Enter/Space on the list background.
            if (
              (e.target as HTMLElement).tagName === "OL" &&
              (e.key === "Enter" || e.key === " ")
            ) {
              enterEditMode();
            }
          }}
        >
          {displayed.map((item, idx) => {
            if (item === "ellipsis") {
              return (
                <li key="ellipsis" className="flex items-center gap-0.5">
                  <span aria-hidden="true" className="text-muted-foreground">
                    /
                  </span>
                  <span
                    className="px-1 text-muted-foreground"
                    title={allSegmentsTooltip}
                  >
                    …
                  </span>
                </li>
              );
            }

            const isLast = idx === displayed.length - 1;
            return (
              <li key={item.label} className="flex items-center gap-0.5">
                {idx > 0 && (
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground select-none"
                  >
                    /
                  </span>
                )}
                <button
                  type="button"
                  aria-current={isLast ? "page" : undefined}
                  onClick={() => handleSegmentClick(item)}
                  className={`max-w-[160px] truncate rounded px-1 py-0.5 text-left hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isLast
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
