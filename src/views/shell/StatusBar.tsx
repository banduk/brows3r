/**
 * StatusBar — bottom-of-window footer with the current location and an
 * "open in AWS console" affordance for AWS S3 profiles.
 *
 * Behaviour:
 * - Left chip shows `s3://<bucket>/<prefix>` for the active pane, or a
 *   neutral "No location" when the pane is empty.
 * - When the active profile is an AWS profile (not a compat endpoint),
 *   an external-link icon next to the chip opens the AWS S3 console at
 *   the corresponding bucket + prefix. Hidden for compat (MinIO etc.)
 *   profiles since the console URL would be meaningless.
 * - Right side shows a profile / validation chip — the previous hardcoded
 *   "Disconnected" string was a stub from before the validation flow
 *   landed and never reflected real connectivity.
 */

import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ActivityIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { profileGet } from "@/api/profiles";
import { formatBytes } from "@/lib/format";
import { useObjectHead } from "@/query/hooks/useObjectHead";
import { useProfilesList } from "@/query/hooks/useValidatedProfile";
import type { Pane } from "@/store/panes";
import { useTransfersStore } from "@/store/transfers";
import { useUiStore } from "@/store/ui";

/**
 * Concise list of the most-used shortcuts, rendered as a tooltip on the
 * status-bar keyboard hint icon. Adding a row here is the only change
 * needed to surface a new shortcut to the user.
 */
const SHORTCUT_HINTS = [
  ["⌘K", "Command palette"],
  ["⌘F", "Search recursive"],
  ["/", "Filter current view"],
  ["⌘A", "Select all"],
  ["⌘I", "Inspect selection"],
  ["⌘L", "Edit breadcrumb path"],
  ["⌘R", "Refresh listing"],
  ["⌘[ / ⌘]", "Back / forward"],
  ["⌘↑", "Up one level"],
  ["↑ / ↓ / ← / →", "Move cursor (any view)"],
  ["Enter / Space", "Open / drill in"],
  ["Backspace", "Up one level / back column"],
  ["⌘B", "Toggle sidebar"],
  ["⌘J", "Toggle preview"],
  ["⌘⇧A", "Open Activity Center"],
  ["⌘⇧J", "Toggle transfer popup"],
  ["⌘1‒7", "Switch view mode"],
  ["⌘,", "Open Settings"],
] as const;

interface StatusBarProps {
  pane: Pane;
}

export function StatusBar({ pane }: StatusBarProps) {
  const { t } = useTranslation();
  const location = pane.location;
  const { profiles } = useProfilesList();
  const activeProfile = location
    ? profiles.find((p) => p.id === location.profileId)
    : undefined;

  // Compat profiles carry an endpoint URL inside compatFlags; AWS-native
  // ones don't. The console-vs-endpoint branch hangs on this distinction.
  const isAwsProfile =
    activeProfile?.source === "awsCredentials" ||
    activeProfile?.source === "awsConfig" ||
    activeProfile?.source === "env";

  // ProfileSummary doesn't carry compatFlags, so the endpoint URL must
  // come from the full ProfileDetail. Only fetched for compat profiles —
  // for AWS we don't need it.
  const { data: profileDetail } = useQuery({
    queryKey: ["profile-detail", location?.profileId ?? "none"],
    queryFn: () => profileGet(location?.profileId as string),
    enabled: Boolean(location?.profileId) && !isAwsProfile,
    staleTime: 60_000,
  });

  // Single selected key (the "focused object" in the pane). Drives the
  // "fetched Xs ago" indicator so the user can tell when the HEAD data
  // they see may have drifted from the live object in S3, AND feeds the
  // selection chip that displays the *full* filename (file lists
  // truncate them, the status bar is the lossless surface).
  const selectionList = Array.from(pane.selection);
  const selectionCount = selectionList.length;
  const focusedKey = selectionList[0] ?? null;
  const { data: focusedHead, dataUpdatedAt } = useObjectHead(
    location?.profileId,
    location?.bucket,
    focusedKey,
  );
  const fetchedLabel = useFetchedAgo(dataUpdatedAt);

  const selectionLabel = (() => {
    if (selectionCount === 0) return null;
    if (selectionCount > 1) {
      return `${selectionCount.toString()} items selected`;
    }
    if (!focusedKey) return null;
    // Strip the prefix portion: the bucket-level path is already shown
    // in the location chip; the user wants to see the *file name*.
    const name = focusedKey.split("/").filter(Boolean).pop() ?? focusedKey;
    return name;
  })();

  /**
   * URL that the "open in browser" affordance points at, plus a label
   * for the tooltip. The level of precision depends on what is in focus:
   *
   *   selected object → AWS object preview URL (deepest link)
   *   folder prefix   → AWS folder listing URL
   *   bucket only     → AWS bucket root URL
   *   compat profile  → endpoint URL fallback
   *
   * The AWS object-preview URL pattern is:
   *   https://s3.console.aws.amazon.com/s3/object/<bucket>?region=<r>&prefix=<key>
   *
   * Returns null when no bucket is in focus or we have no usable URL.
   */
  function browserTarget(): { url: string; label: string } | null {
    if (!location?.bucket) return null;
    const bucket = encodeURIComponent(location.bucket);
    const prefix = location.prefix ?? "";

    if (isAwsProfile) {
      const region = activeProfile?.defaultRegion ?? "us-east-1";
      const regionParam = `region=${encodeURIComponent(region)}`;

      // 1. Selected object → object-preview URL. focusedKey points to the
      //    exact S3 key the user has highlighted, which is the closest the
      //    AWS console UI gets to a "select this object" deep link.
      if (focusedKey && !focusedKey.endsWith("/")) {
        const url = `https://s3.console.aws.amazon.com/s3/object/${bucket}?${regionParam}&prefix=${encodeURIComponent(focusedKey)}`;
        return { url, label: `Open ${focusedKey} in the AWS S3 console` };
      }

      // 2. Folder / prefix → list view inside the bucket.
      const folder = prefix.endsWith("/")
        ? prefix
        : prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const bucketBase = `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?${regionParam}`;
      if (folder) {
        return {
          url: `${bucketBase}&prefix=${encodeURIComponent(folder)}`,
          label: `Open folder ${folder} in the AWS S3 console`,
        };
      }

      // 3. Bucket root.
      return {
        url: bucketBase,
        label: `Open bucket ${location.bucket} in the AWS S3 console`,
      };
    }

    const endpoint = profileDetail?.compatFlags?.endpointUrl;
    if (endpoint) {
      return {
        url: endpoint,
        label: `Open the profile's S3 endpoint (${endpoint}) in the browser`,
      };
    }
    return null;
  }

  const target = browserTarget();

  const profileLabel = activeProfile
    ? activeProfile.validatedAt
      ? `${activeProfile.displayName} • ${t("statusBar.validated")}`
      : `${activeProfile.displayName} • ${t("statusBar.notValidated")}`
    : t("statusBar.noProfile");

  return (
    <footer className="border-t bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
      <div
        role="status"
        aria-label={t("statusBar.label")}
        className="flex items-center gap-3"
      >
        {/* Path + adjacent "open in browser" icon. Grouped tight so the
            icon reads as belonging to the path. */}
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate">
            {location?.bucket
              ? `s3://${location.bucket}/${location.prefix ?? ""}`
              : t("statusBar.noLocation")}
          </span>
          {target && (
            <button
              type="button"
              aria-label={target.label}
              title={target.label}
              onClick={() => void openUrl(target.url)}
              className="inline-flex shrink-0 items-center rounded p-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLinkIcon className="size-3" />
            </button>
          )}
        </div>
        {selectionLabel && (
          <span
            className="min-w-0 max-w-[40%] shrink truncate text-foreground/80"
            data-testid="status-selection-name"
            title={
              selectionCount > 1
                ? selectionList.join("\n")
                : (focusedKey ?? selectionLabel)
            }
          >
            {selectionCount === 1 && focusedHead?.contentLength != null ? (
              <>
                {selectionLabel}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-70">
                  {formatBytes(focusedHead.contentLength)}
                </span>
              </>
            ) : (
              selectionLabel
            )}
          </span>
        )}
        {fetchedLabel && (
          <span
            className="shrink-0 text-[10px] uppercase tracking-wide opacity-75"
            title={
              dataUpdatedAt
                ? `HEAD last fetched at ${new Date(dataUpdatedAt).toLocaleString()} — the object in S3 may have changed since.`
                : undefined
            }
            data-testid="status-fetched-ago"
          >
            {fetchedLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <ActivityChip />
          <ShortcutHints />
          <SettingsButton />
          <span className="truncate" title={profileLabel}>
            {profileLabel}
          </span>
        </div>
      </div>
    </footer>
  );
}

/**
 * Format a millis timestamp as a human-readable "fetched Xs ago" string,
 * re-rendering at a cadence appropriate for the elapsed magnitude (every
 * second under a minute, every 30s under an hour, every minute otherwise).
 *
 * Returns `null` when no fetch has completed yet (`dataUpdatedAt === 0`),
 * so the caller can omit the chip entirely.
 */
function useFetchedAgo(dataUpdatedAt: number): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!dataUpdatedAt) return;
    // Re-render on a coarse schedule so the label stays approximately fresh
    // without becoming a render hotspot.
    const id = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, [dataUpdatedAt]);

  if (!dataUpdatedAt) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - dataUpdatedAt) / 1000));
  if (seconds < 5) return "Fetched just now";
  if (seconds < 60) return `Fetched ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Fetched ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Fetched ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Fetched ${days}d ago`;
}

/**
 * Tiny "?" affordance in the status bar. Hovering reveals the canonical
 * shortcut list — discoverability without taking pixels away from the
 * content area.
 */
function ShortcutHints() {
  const { t } = useTranslation();
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={t("statusBar.shortcuts.aria")}
        title={t("statusBar.shortcuts.aria")}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <KeyboardIcon className="size-3" />
        <span className="text-[10px] uppercase tracking-wide">
          {t("statusBar.shortcuts.label")}
        </span>
      </button>
      <div
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full right-0 z-50 mb-1 w-72 rounded-md border border-border bg-popover p-2 text-[11px] text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        <p className="mb-1 font-medium">{t("statusBar.shortcuts.title")}</p>
        <table className="w-full">
          <tbody>
            {SHORTCUT_HINTS.map(([keys, action]) => (
              <tr key={action}>
                <td className="whitespace-nowrap pr-2 font-mono opacity-80">
                  {keys}
                </td>
                <td className="text-muted-foreground">{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * ActivityChip — status-bar affordance that opens the Transfer Manager
 * panel. Always visible so the user can review history; pulses + shows
 * aggregate progress while any transfer is queued or running.
 */
function ActivityChip() {
  const { t } = useTranslation();
  const transfers = useTransfersStore((s) => s.transfers);
  const toggleActivityCenter = useUiStore((s) => s.toggleActivityCenter);

  let activeCount = 0;
  let totalBytes = 0;
  let doneBytes = 0;
  for (const tr of transfers.values()) {
    if (tr.state === "queued" || tr.state === "running") {
      activeCount += 1;
      totalBytes += tr.totalBytes ?? 0;
      doneBytes += tr.transferredBytes;
    }
  }
  const overallPct =
    totalBytes > 0
      ? Math.min(100, Math.round((doneBytes / totalBytes) * 100))
      : 0;

  const isActive = activeCount > 0;
  const completedCount = transfers.size - activeCount;
  const title = isActive
    ? t("activity.titleActive", { count: activeCount, pct: overallPct })
    : completedCount > 0
      ? t("activity.titleCompleted", { count: completedCount })
      : t("activity.titleIdle");

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => toggleActivityCenter()}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors ${
        isActive
          ? "bg-green-500/15 text-green-700 dark:text-green-400 hover:bg-green-500/25"
          : "hover:bg-accent hover:text-accent-foreground"
      }`}
      data-testid="activity-chip"
    >
      <ActivityIcon
        className={`size-3 ${isActive ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      {isActive ? (
        <span className="text-[10px] uppercase tracking-wide font-medium">
          {activeCount} • {overallPct}%
        </span>
      ) : (
        <span className="text-[10px] uppercase tracking-wide">
          {t("activity.label")}
        </span>
      )}
    </button>
  );
}

/**
 * SettingsButton — visible gear icon in the status bar that opens the
 * Settings screen. The Cmd+, shortcut also opens it; the icon exists so
 * the feature is discoverable for users who don't know the shortcut.
 */
function SettingsButton() {
  const { t } = useTranslation();
  const label = t("statusBar.openSettings");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        window.dispatchEvent(new CustomEvent("settings:open"));
      }}
      className="inline-flex items-center rounded p-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="open-settings"
    >
      <SettingsIcon className="size-3.5" />
    </button>
  );
}
