/**
 * SearchBox — search overlay bound to the active pane.
 *
 * Opened by Cmd/Ctrl+F (search.local command) or by the `search:open` custom
 * event.  Closed by Esc or by clicking outside.
 *
 * # Modes
 *
 * - **Filter (current location)** (default): pure local filter over the
 *   caller-supplied `entries` list.  Results update on every keystroke via
 *   `searchLocalFilter`.
 * - **Search bucket**: walks `ListObjectsV2` pages via `searchPrefix`; results
 *   stream in through `search:page` events.  Shows a progress indicator while
 *   the walk is running.  A Cancel button aborts the walk.
 *
 * # A11y
 *
 * - `<search>` semantic landmark.
 * - `aria-label` on the input.
 * - Mode toggle uses `<fieldset>` + `<legend>` for semantic grouping.
 * - Cancel button has a descriptive `aria-label`.
 * - Live region for streaming results (`aria-live="polite"`).
 *
 * # OCP
 *
 * Adding a third mode (e.g. history search) = one new `SearchMode` literal +
 * one new button in the fieldset + one new branch in the query-change handler.
 * Existing modes are unaffected.
 */

import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { EntryRef, SearchPage } from "@/api/search";
import { searchCancel, searchLocalFilter, searchPrefix } from "@/api/search";
import { listen, type UnlistenFn } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearchMode = "filter" | "bucket";

export interface SearchBoxProps {
  /** Active pane identifier — passed to searchLocalFilter. */
  paneId: string;
  /** Profile for bucket-wide search. */
  profileId: string;
  /** Bucket for bucket-wide search. */
  bucket: string;
  /** Prefix for bucket-wide search (current pane location). */
  prefix: string;
  /** Current cached entries to filter in "filter" mode. */
  entries: EntryRef[];
  /** Called when the overlay should be closed (Esc, outside click). */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// SearchBox
// ---------------------------------------------------------------------------

export function SearchBox({
  paneId,
  profileId,
  bucket,
  prefix,
  entries,
  onClose,
}: SearchBoxProps): React.ReactElement {
  const [mode, setMode] = useState<SearchMode>("filter");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntryRef[]>([]);
  const [running, setRunning] = useState(false);

  // Stable refs to avoid stale closures in effects.
  const requestIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input on mount.
  useEffect(() => {
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // Listen for the `search:open` custom event to allow external triggers.
  useEffect(() => {
    function handleOpen() {
      inputRef.current?.focus();
    }
    window.addEventListener("search:open", handleOpen);
    return () => window.removeEventListener("search:open", handleOpen);
  }, []);

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      // Unsubscribe from event stream if active.
      unlistenRef.current?.();
      // Cancel any running prefix search.
      if (requestIdRef.current) {
        searchCancel(requestIdRef.current).catch(() => {});
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const cancelRunningSearch = useCallback(async () => {
    if (requestIdRef.current) {
      await searchCancel(requestIdRef.current).catch(() => {});
      requestIdRef.current = null;
    }
    unlistenRef.current?.();
    unlistenRef.current = null;
    setRunning(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Local filter mode
  // ---------------------------------------------------------------------------

  const runLocalFilter = useCallback(
    async (q: string) => {
      const filtered = await searchLocalFilter(paneId, q, entries).catch(
        () => [] as EntryRef[],
      );
      setResults(filtered);
    },
    [paneId, entries],
  );

  // ---------------------------------------------------------------------------
  // Prefix search mode
  // ---------------------------------------------------------------------------

  const startPrefixSearch = useCallback(
    async (q: string) => {
      // Cancel any previous prefix search.
      await cancelRunningSearch();

      if (!profileId || !bucket) {
        return;
      }

      const rid = `search-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
      requestIdRef.current = rid;

      const accumulated: EntryRef[] = [];
      setResults([]);
      setRunning(true);

      // Subscribe to search:page events before calling searchPrefix so we
      // don't miss the first page if the search returns synchronously.
      const unlisten = await listen("search:page", (page: SearchPage) => {
        if (page.requestId !== rid) return;
        accumulated.push(...page.results);
        setResults([...accumulated]);
        if (page.isFinal) {
          setRunning(false);
          unlistenRef.current?.();
          unlistenRef.current = null;
          requestIdRef.current = null;
        }
      });
      unlistenRef.current = unlisten;

      searchPrefix(profileId, bucket, prefix, q, rid).catch(() => {
        setRunning(false);
      });
    },
    [cancelRunningSearch, profileId, bucket, prefix],
  );

  // ---------------------------------------------------------------------------
  // Query change handler
  // ---------------------------------------------------------------------------

  const handleQueryChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value;
      setQuery(q);

      if (mode === "filter") {
        await runLocalFilter(q);
      } else {
        await startPrefixSearch(q);
      }
    },
    [mode, runLocalFilter, startPrefixSearch],
  );

  // ---------------------------------------------------------------------------
  // Mode toggle
  // ---------------------------------------------------------------------------

  const handleModeChange = useCallback(
    async (newMode: SearchMode) => {
      if (newMode === mode) return;
      setMode(newMode);

      // Cancel any running search from the previous mode.
      await cancelRunningSearch();
      setResults([]);

      if (query) {
        if (newMode === "filter") {
          await runLocalFilter(query);
        } else {
          await startPrefixSearch(query);
        }
      }
    },
    [mode, query, cancelRunningSearch, runLocalFilter, startPrefixSearch],
  );

  // ---------------------------------------------------------------------------
  // Keyboard handler
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <search
      aria-label="Search files"
      data-testid="search-box"
      className="fixed inset-x-0 top-0 z-50 flex flex-col gap-2 border-b bg-background px-4 py-3 shadow-md"
    >
      {/* Mode toggle — fieldset for semantic grouping of toggle buttons */}
      <fieldset className="flex gap-2 border-0 p-0 text-sm">
        <legend className="sr-only">Search mode</legend>
        <button
          type="button"
          aria-pressed={mode === "filter"}
          data-testid="mode-filter"
          onClick={() => handleModeChange("filter")}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            mode === "filter"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Filter (current location)
        </button>
        <button
          type="button"
          aria-pressed={mode === "bucket"}
          data-testid="mode-bucket"
          onClick={() => handleModeChange("bucket")}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            mode === "bucket"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Search bucket
        </button>
      </fieldset>

      {/* Search input row */}
      <div className="flex items-center gap-2">
        <input
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          ref={inputRef}
          type="search"
          aria-label={
            mode === "filter"
              ? "Filter current listing"
              : "Search bucket prefix"
          }
          data-testid="search-input"
          value={query}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          placeholder={mode === "filter" ? "Filter by name…" : "Search bucket…"}
          className="flex-1 rounded border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />

        {/* Cancel button — only shown during a running prefix search */}
        {running && (
          <button
            type="button"
            aria-label="Cancel bucket search"
            data-testid="search-cancel"
            onClick={() => cancelRunningSearch()}
            className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
          >
            Cancel
          </button>
        )}

        {/* Close button */}
        <button
          type="button"
          aria-label="Close search"
          data-testid="search-close"
          onClick={onClose}
          className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
        >
          ✕
        </button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div
          data-testid="search-results"
          className="max-h-64 overflow-y-auto rounded border bg-popover text-sm shadow"
        >
          {results.map((entry) => (
            <div
              key={entry.key}
              data-testid="search-result-item"
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent hover:text-accent-foreground"
            >
              {entry.isPrefix ? (
                <span aria-hidden="true">📁</span>
              ) : (
                <span aria-hidden="true">📄</span>
              )}
              <span className="min-w-0 truncate">{entry.key}</span>
            </div>
          ))}
        </div>
      )}

      {/* Live region for screen readers */}
      <div aria-live="polite" aria-atomic="false" className="sr-only">
        {running && "Searching…"}
        {!running &&
          results.length > 0 &&
          `${results.length.toString()} results found`}
      </div>
    </search>
  );
}
