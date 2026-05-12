/**
 * TransferManager — slide-up Transfer Manager panel.
 *
 * Renders from bottom-right as a fixed overlay panel. Can be minimized to a
 * small toolbar pill (per AC-9 / AC-14) that shows aggregate progress and
 * re-expands on click.
 *
 * Sections:
 * - Header: title + count badge + minimize/expand + Clear completed
 * - Active transfers list (queued + running)
 * - Completed section (collapsed by default; toggleable)
 * - Empty state when no transfers exist
 *
 * A11y:
 * - ARIA progressbar on each row (via TransferRow)
 * - Dedicated aria-live="polite" region that announces only terminal state
 *   changes (done / failed / canceled). In-progress percent updates are
 *   intentionally suppressed to avoid announcement floods.
 * - The outer section no longer carries aria-live so the progressbar updates
 *   are never surfaced by the container.
 * - Minimize button has descriptive aria-label.
 *
 * OCP: adding a "failed only" filter = one new selector + one new tab header.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Transfer } from "@/api/transfers";
import { useTransfersStore } from "@/store/transfers";
import { useUiStore } from "@/store/ui";
import { TransferGroup } from "./TransferGroup";
import { TransferRow } from "./TransferRow";

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface TransferGrouping {
  /** Singleton transfers with no batch id or batches of size 1. */
  singletons: Transfer[];
  /** Ordered list of (batchId, transfers) pairs for batches ≥ 2. */
  groups: Array<[string, Transfer[]]>;
}

/**
 * Partition transfers by batchId. Preserves insertion order for both
 * singletons and groups so the panel doesn't reshuffle as transfers
 * complete.
 */
function groupByBatch(transfers: Transfer[]): TransferGrouping {
  const groups = new Map<string, Transfer[]>();
  const singletons: Transfer[] = [];
  const order: string[] = [];
  for (const tr of transfers) {
    if (!tr.batchId) {
      singletons.push(tr);
      continue;
    }
    const existing = groups.get(tr.batchId);
    if (existing) {
      existing.push(tr);
    } else {
      groups.set(tr.batchId, [tr]);
      order.push(tr.batchId);
    }
  }

  const groupEntries: Array<[string, Transfer[]]> = [];
  for (const id of order) {
    const arr = groups.get(id);
    if (!arr) continue;
    if (arr.length === 1) {
      // A batch of 1 collapses to a singleton row — no point showing a
      // parent with a single child.
      singletons.push(arr[0] as Transfer);
    } else {
      groupEntries.push([id, arr]);
    }
  }
  return { singletons, groups: groupEntries };
}

// ---------------------------------------------------------------------------
// Stable per-state-slice selectors
// ---------------------------------------------------------------------------

function selectActive(transfers: Map<string, Transfer>): Transfer[] {
  const out: Transfer[] = [];
  for (const t of transfers.values()) {
    if (t.state === "queued" || t.state === "running") out.push(t);
  }
  return out;
}

function selectCompleted(transfers: Map<string, Transfer>): Transfer[] {
  const out: Transfer[] = [];
  for (const t of transfers.values()) {
    if (t.state === "done" || t.state === "failed" || t.state === "canceled")
      out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pill (minimized state)
// ---------------------------------------------------------------------------

interface PillProps {
  activeCount: number;
  overallPct: number;
  onExpand: () => void;
}

function TransferPill({ activeCount, overallPct, onExpand }: PillProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={t("transferManager.expand")}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{t("transferManager.pillCount", { count: activeCount })}</span>
      <span>•</span>
      <span>{overallPct}%</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Terminal-state announcement hook
// ---------------------------------------------------------------------------

/**
 * Builds human-readable announcements for terminal state transitions.
 *
 * Only "done", "failed", and "canceled" transitions are announced.
 * In-progress percent updates are suppressed to avoid flooding.
 *
 * Returns the latest announcement string (empty when nothing new).
 */
function useTransferAnnouncement(transfers: Map<string, Transfer>): string {
  const { t: tr } = useTranslation();
  // Track previously seen states per transfer id.
  const prevStates = useRef<Map<string, Transfer["state"]>>(new Map());
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    for (const [id, t] of transfers) {
      const prev = prevStates.current.get(id);
      // Only emit an announcement when the state changes to a terminal value.
      if (prev !== t.state) {
        const label = t.key.split("/").pop() ?? t.key;
        if (t.state === "done") {
          const key =
            t.kind === "upload"
              ? "transferManager.announce.uploadDone"
              : "transferManager.announce.downloadDone";
          setAnnouncement(tr(key, { name: label }));
        } else if (t.state === "failed") {
          const key =
            t.kind === "upload"
              ? "transferManager.announce.uploadFailed"
              : "transferManager.announce.downloadFailed";
          setAnnouncement(tr(key, { name: label }));
        } else if (t.state === "canceled") {
          setAnnouncement(
            tr("transferManager.announce.canceled", { name: label }),
          );
        }
        prevStates.current.set(id, t.state);
      }
    }
    // Clean up entries for transfers that are no longer present.
    for (const id of prevStates.current.keys()) {
      if (!transfers.has(id)) {
        prevStates.current.delete(id);
      }
    }
  }, [transfers, tr]);

  return announcement;
}

// ---------------------------------------------------------------------------
// TransferManager panel
// ---------------------------------------------------------------------------

export function TransferManager() {
  const { t } = useTranslation();
  const panelOpen = useTransfersStore((s) => s.panelOpen);
  const panelMinimized = useTransfersStore((s) => s.panelMinimized);
  const togglePanel = useTransfersStore((s) => s.togglePanel);
  const setMinimized = useTransfersStore((s) => s.setMinimized);
  const clearCompleted = useTransfersStore((s) => s.clearCompleted);
  const transfers = useTransfersStore((s) => s.transfers);
  const setActivityCenterOpen = useUiStore((s) => s.setActivityCenterOpen);
  const activityCenterOpen = useUiStore((s) => s.activityCenterOpen);

  const active = selectActive(transfers);
  const completed = selectCompleted(transfers);

  const [completedExpanded, setCompletedExpanded] = useState(false);
  const announcement = useTransferAnnouncement(transfers);

  // When the Activity Center is open it owns the full pane; the floating
  // popup would be redundant + cover content. Hide it.
  // (Hook calls above must run unconditionally — React rules-of-hooks.)
  if (activityCenterOpen) return null;

  // Compute aggregate progress for the minimized pill.
  const totalBytes = active.reduce((sum, t) => sum + (t.totalBytes ?? 0), 0);
  const doneBytes = active.reduce((sum, t) => sum + t.transferredBytes, 0);
  const overallPct =
    totalBytes > 0
      ? Math.min(100, Math.round((doneBytes / totalBytes) * 100))
      : 0;

  // Minimized pill — only when minimized AND panel was open.
  if (panelMinimized && panelOpen) {
    return (
      <TransferPill
        activeCount={active.length}
        overallPct={overallPct}
        onExpand={() => setMinimized(false)}
      />
    );
  }

  // Panel not open — nothing to render.
  if (!panelOpen) return null;

  const hasAny = active.length > 0 || completed.length > 0;

  return (
    <section
      aria-label={t("transferManager.label")}
      className="fixed bottom-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
    >
      {/* Dedicated aria-live region — announces only terminal state changes.
          Visually hidden; polite so it never interrupts the user. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="transfer-announcement"
      >
        {announcement}
      </div>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">
            {t("transferManager.title")}
          </h2>
          {active.length > 0 && (
            <span
              title={t("transferManager.activeCountTitle", {
                count: active.length,
              })}
              className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
            >
              {active.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setActivityCenterOpen(true);
            }}
            className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="transfer-manager-view-all"
          >
            {t("transferManager.viewAll")}
          </button>

          {completed.length > 0 && (
            <button
              type="button"
              onClick={clearCompleted}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("transferManager.clearCompleted")}
            </button>
          )}

          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label={t("transferManager.minimize")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">⌵</span>
          </button>

          <button
            type="button"
            onClick={togglePanel}
            aria-label={t("transferManager.close")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="max-h-[60vh] overflow-y-auto p-3">
        {!hasAny ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("transferManager.empty")}
          </p>
        ) : (
          <>
            {/* Active section — grouped by batchId. */}
            {active.length > 0 && (
              <section aria-label={t("transferManager.activeSection")}>
                <ul className="flex flex-col gap-2">
                  {(() => {
                    const { singletons, groups } = groupByBatch(active);
                    return (
                      <>
                        {groups.map(([batchId, group]) => (
                          <TransferGroup
                            key={batchId}
                            transfers={group}
                            defaultExpanded={false}
                          />
                        ))}
                        {singletons.map((tr) => (
                          <TransferRow key={tr.id} transfer={tr} />
                        ))}
                      </>
                    );
                  })()}
                </ul>
              </section>
            )}

            {/* Completed section */}
            {completed.length > 0 && (
              <section
                aria-label={t("transferManager.completedSection")}
                className="mt-3"
              >
                <button
                  type="button"
                  onClick={() => setCompletedExpanded((v) => !v)}
                  aria-expanded={completedExpanded}
                  className="flex w-full items-center justify-between rounded px-1 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>
                    {t("transferManager.completedCount", {
                      count: completed.length,
                    })}
                  </span>
                  <span aria-hidden="true">
                    {completedExpanded ? "▲" : "▼"}
                  </span>
                </button>

                {completedExpanded &&
                  (() => {
                    const { singletons, groups } = groupByBatch(completed);
                    return (
                      <ul className="mt-2 flex flex-col gap-2">
                        {groups.map(([batchId, group]) => (
                          <TransferGroup
                            key={batchId}
                            transfers={group}
                            defaultExpanded={false}
                          />
                        ))}
                        {singletons.map((tr) => (
                          <TransferRow key={tr.id} transfer={tr} />
                        ))}
                      </ul>
                    );
                  })()}
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
