/**
 * useFilteredEntries — apply the active pane's inline fuzzy filter to a
 * listing of `ObjectEntry`.
 *
 * The cheap path runs the filter on the main thread for small listings
 * (< MAIN_THREAD_THRESHOLD entries) — the postMessage roundtrip there
 * would dominate the actual filter cost.
 *
 * For larger listings the filter is offloaded to fuzzy.worker so a fast
 * typer does not drop frames. The hook keeps the previous result on screen
 * while the worker computes the next one (no flicker mid-keystroke) and
 * stamps each request with an id so stale responses are ignored.
 *
 * Returns the input unchanged when the filter is empty so no-filter renders
 * stay allocation-free.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ObjectEntry } from "@/api/objects";
import { fuzzyFilter } from "@/lib/fuzzy";
import { usePanesStore } from "@/store/panes";

/** Items below this count keep the synchronous main-thread path. */
const MAIN_THREAD_THRESHOLD = 1_000;
/** Debounce keystrokes hitting the worker. */
const DEBOUNCE_MS = 60;

function basenameOfKey(key: string, prefix: string): string {
  const tail = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return tail.endsWith("/") ? tail.slice(0, -1) : tail;
}

export function useFilteredEntries(
  entries: ObjectEntry[],
  prefix: string,
): ObjectEntry[] {
  const filter = usePanesStore(
    (s) => s.panes.find((p) => p.id === s.activePaneId)?.filter ?? "",
  );

  // -- Cheap synchronous path -------------------------------------------------
  const cheapResult = useMemo(() => {
    if (!filter) return entries;
    if (entries.length > MAIN_THREAD_THRESHOLD) return null;
    return fuzzyFilter(entries, filter, (e) => basenameOfKey(e.key, prefix));
  }, [entries, filter, prefix]);

  // -- Worker path (for large listings) --------------------------------------
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [workerResult, setWorkerResult] = useState<ObjectEntry[]>(entries);

  // Reset the worker result when the underlying entries change identity —
  // otherwise a stale filtered view sticks around after navigation.
  useEffect(() => {
    setWorkerResult(entries);
  }, [entries]);

  useEffect(() => {
    if (cheapResult !== null) return; // synchronous path handled it
    if (typeof window === "undefined") return;

    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL("../../workers/fuzzy.worker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current.onmessage = (
        e: MessageEvent<{ requestId: number; results: ObjectEntry[] }>,
      ) => {
        // Drop stale responses — only the latest dispatched request wins.
        if (e.data.requestId !== requestIdRef.current) return;
        setWorkerResult(e.data.results);
      };
    }

    const id = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      workerRef.current?.postMessage({
        requestId: id,
        items: entries,
        query: filter,
        prefix,
      });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [entries, filter, prefix, cheapResult]);

  // Tear down the worker on unmount.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return cheapResult ?? workerResult;
}
