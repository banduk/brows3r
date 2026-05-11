/**
 * fuzzy.worker.ts — off-main-thread fuzzy filter for object listings.
 *
 * Receives: { requestId, items, query, prefix }
 * Returns:  { requestId, results }
 *
 * Computes the same visible-basename projection that DetailsView /
 * IconGridView etc. used inline (key with current prefix stripped + trailing
 * "/" trimmed for folder entries) and runs the shared lib/fuzzy matcher.
 *
 * Why a worker: with 10–100 k entries the fuzzy filter on the main thread
 * can drop frames on fast typers. The worker keeps the UI responsive while
 * the filter runs.
 *
 * Why pass items every time rather than caching them in the worker:
 * - Items can change for reasons other than the query (new pages loaded,
 *   sort changed, navigation). Caching needs a stable identity per pane,
 *   which the worker has no way to mint.
 * - structuredClone on a 10 k-entry ObjectEntry array is ~2 ms, dominated
 *   by the filter cost. Worth re-evaluating if entry counts climb past
 *   ~500 k.
 *
 * The request carries a `requestId` so a stale result that arrives after
 * the caller already moved on can be dropped client-side.
 */

import type { ObjectEntry } from "@/api/objects";
import { fuzzyFilter } from "@/lib/fuzzy";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface FuzzyRequest {
  requestId: number;
  items: ObjectEntry[];
  query: string;
  prefix: string;
}

export interface FuzzyResponse {
  requestId: number;
  results: ObjectEntry[];
}

// ---------------------------------------------------------------------------
// Filter (exported for unit tests)
// ---------------------------------------------------------------------------

export function runFuzzyFilter(req: FuzzyRequest): FuzzyResponse {
  const { requestId, items, query, prefix } = req;

  if (!query) return { requestId, results: items };

  const results = fuzzyFilter(items, query, (e) => {
    const tail = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key;
    return tail.endsWith("/") ? tail.slice(0, -1) : tail;
  });

  return { requestId, results };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<FuzzyRequest>) => {
  self.postMessage(runFuzzyFilter(event.data));
};
