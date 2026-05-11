/**
 * TablePreview — TanStack Table-based tabular preview for CSV, JSON, NDJSON,
 * and Parquet files.
 *
 * Parsing is done off the main thread in a dedicated Web Worker per format so
 * the UI stays responsive on files up to the preview size limit.
 *
 * Architecture:
 *  - objectGetText  → CSV / JSON / NDJSON workers
 *  - objectGetBytes → Parquet worker (receives base64, decodes in wasm)
 *  - Worker result: { headers, rows, totalRows, truncated }
 *  - TanStack Table: sortable columns, client-side, over loaded rows
 *  - Pagination: 50 rows per page
 *  - "First N of M rows" badge + truncation indicator
 *
 * OCP:
 *  - Each parser is a separate worker module — adding TSV / Excel is a new
 *    worker file plus one branch here.
 *  - TablePreview consumes a uniform TabularResult — switching to a
 *    server-side parser is a worker replacement.
 *  - TanStack Table is the render layer; column reordering/virtualization
 *    extends it without touching this component.
 */

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { objectGetBytes, objectGetText } from "@/api/objects";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TableMode = "csv" | "json" | "ndjson" | "parquet";

export interface TablePreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
  mode: TableMode;
}

export interface TabularResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROWS_PER_PAGE = 50;

/**
 * Max bytes to fetch for text-based formats.
 *
 * 10 MB covers most CSV/JSON files in the preview size limit range and gives
 * enough data for a useful preview without excessive transfer cost.
 */
const TEXT_FETCH_BYTES = 10 * 1024 * 1024;

/** Max rows to pass to workers to bound memory usage in the preview. */
const MAX_ROWS = 1000;

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Create a Web Worker for the given table mode.
 *
 * Each worker is loaded via the Vite worker pattern so Vite bundles it into a
 * separate module with its own import map.
 */
function createWorker(mode: TableMode): Worker {
  switch (mode) {
    case "csv":
      return new Worker(
        new URL("../../workers/csv.worker.ts", import.meta.url),
        { type: "module" },
      );
    case "json":
    case "ndjson":
      return new Worker(
        new URL("../../workers/json.worker.ts", import.meta.url),
        { type: "module" },
      );
    case "parquet":
      return new Worker(
        new URL("../../workers/parquet.worker.ts", import.meta.url),
        { type: "module" },
      );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// TablePreview
// ---------------------------------------------------------------------------

export function TablePreview({
  profileId,
  bucket,
  objectKey,
  mode,
}: TablePreviewProps): React.ReactElement {
  const [result, setResult] = useState<TabularResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const workerRef = useRef<Worker | null>(null);

  // Reset page on key / mode change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: objectKey/mode are props, reset is intentional
  useEffect(() => {
    setPageIndex(0);
  }, [objectKey, mode]);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setResult(null);

    async function run() {
      try {
        if (mode === "parquet") {
          const payload = await objectGetBytes(
            profileId,
            bucket,
            objectKey,
            TEXT_FETCH_BYTES,
          );

          if (cancelled) return;

          const worker = createWorker(mode);
          workerRef.current = worker;

          worker.onmessage = (e: MessageEvent<TabularResult>) => {
            if (cancelled) {
              worker.terminate();
              return;
            }
            if (e.data.error) {
              setError(e.data.error);
            } else {
              setResult(e.data);
            }
            setLoading(false);
            worker.terminate();
          };

          worker.onerror = (e) => {
            if (!cancelled) {
              setError(e.message ?? "Worker error");
              setLoading(false);
            }
            worker.terminate();
          };

          worker.postMessage({ body: payload.body, maxRows: MAX_ROWS });
        } else {
          const payload = await objectGetText(
            profileId,
            bucket,
            objectKey,
            TEXT_FETCH_BYTES,
          );

          if (cancelled) return;

          const worker = createWorker(mode);
          workerRef.current = worker;

          worker.onmessage = (e: MessageEvent<TabularResult>) => {
            if (cancelled) {
              worker.terminate();
              return;
            }
            if (e.data.error) {
              setError(e.data.error);
            } else {
              setResult(e.data);
            }
            setLoading(false);
            worker.terminate();
          };

          worker.onerror = (e) => {
            if (!cancelled) {
              setError(e.message ?? "Worker error");
              setLoading(false);
            }
            worker.terminate();
          };

          const msg: Record<string, unknown> = {
            body: payload.body,
            maxRows: MAX_ROWS,
          };
          if (mode === "ndjson") msg.mode = "ndjson";
          if (mode === "json") msg.mode = "json";

          worker.postMessage(msg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(extractMessage(err, "Failed to load file"));
          setLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
      workerRef.current?.terminate();
    };
  }, [profileId, bucket, objectKey, mode]);

  // ---------------------------------------------------------------------------
  // TanStack Table setup
  // ---------------------------------------------------------------------------

  const columns = useMemo<ColumnDef<string[]>[]>(() => {
    if (!result?.headers.length) return [];
    return result.headers.map((header, colIdx) => ({
      id: `col-${colIdx}`,
      accessorFn: (row: string[]) => row[colIdx] ?? "",
      header,
      cell: (info) => info.getValue<string>(),
    }));
  }, [result?.headers]);

  const table = useReactTable({
    data: result?.rows ?? [],
    columns,
    state: { sorting, pagination: { pageIndex, pageSize: ROWS_PER_PAGE } },
    onSortingChange: setSorting,
    onPaginationChange: (updater) => {
      if (typeof updater === "function") {
        const next = updater({ pageIndex, pageSize: ROWS_PER_PAGE });
        setPageIndex(next.pageIndex);
      }
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: false,
  });

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center"
        role="status"
        aria-label="Loading table preview"
        data-testid="table-loading-skeleton"
      >
        <div
          className="h-8 w-40 animate-pulse rounded bg-muted"
          aria-hidden="true"
        />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-destructive"
        role="alert"
        data-testid="table-error"
      >
        <p>Failed to parse file: {error}</p>
      </div>
    );
  }

  if (!result || result.headers.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
        data-testid="table-empty"
      >
        <p className="text-sm">No tabular data found in this file</p>
      </div>
    );
  }

  const { totalRows, truncated } = result;
  const loadedRows = result.rows.length;
  const pageCount = table.getPageCount();

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="table-preview"
    >
      {/* Info bar */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span data-testid="table-row-badge">
          First {loadedRows} of {totalRows} row{totalRows !== 1 ? "s" : ""}
          {truncated && (
            <span
              className="ml-1 rounded bg-muted px-1 py-0.5 text-xs font-medium"
              data-testid="table-truncated-indicator"
            >
              truncated
            </span>
          )}
        </span>
        <span>
          {table.getRowModel().rows.length} displayed &mdash; page{" "}
          {pageIndex + 1} of {pageCount}
        </span>
      </div>

      {/* Scrollable table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="w-full border-collapse text-xs"
          aria-label={`Tabular data: ${objectKey}`}
        >
          <thead className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="cursor-pointer select-none whitespace-nowrap border-r px-2 py-1.5 text-left font-medium last:border-r-0 hover:bg-accent"
                    onClick={header.column.getToggleSortingHandler()}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                    data-testid={`table-header-${header.id}`}
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                    {header.column.getIsSorted() === "asc" && (
                      <span aria-hidden="true"> ↑</span>
                    )}
                    {header.column.getIsSorted() === "desc" && (
                      <span aria-hidden="true"> ↓</span>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b hover:bg-accent/50"
                data-testid="table-row"
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="max-w-[200px] truncate border-r px-2 py-1 last:border-r-0"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t px-3 py-1.5 text-xs">
          <button
            type="button"
            className="rounded px-2 py-0.5 hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
            data-testid="table-prev-page"
          >
            &#8592;
          </button>
          <span>
            {pageIndex + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="rounded px-2 py-0.5 hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
            data-testid="table-next-page"
          >
            &#8594;
          </button>
        </div>
      )}
    </div>
  );
}
