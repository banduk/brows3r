/**
 * json.worker.ts — JSON / NDJSON parser for TablePreview.
 *
 * Receives: { body: string; maxRows: number; mode: "json" | "ndjson" }
 * Returns:  { headers: string[]; rows: string[][]; totalRows: number; truncated: boolean }
 *
 * JSON mode: assumes top-level array; flattens each object to columns.
 * NDJSON mode: parses each non-empty line as a separate JSON object.
 *
 * If the top-level JSON value is not an array (e.g. a plain object), the worker
 * returns empty headers so TablePreview shows "no tabular data found".
 *
 * OCP: Adding YAML or XML parsing is a new worker module — message contract
 * is stable.
 */

// ---------------------------------------------------------------------------
// Types (exported for test access)
// ---------------------------------------------------------------------------

export interface JsonParseRequest {
  body: string;
  maxRows: number;
  mode: "json" | "ndjson";
}

export interface TabularResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect union of all top-level keys across a set of objects.
 *
 * We use the first `sampleSize` records to determine the column set so we
 * avoid a full second pass over large datasets.
 */
function collectHeaders(
  records: Record<string, unknown>[],
  sampleSize = 200,
): string[] {
  const seen = new Set<string>();
  const limit = Math.min(records.length, sampleSize);
  for (let i = 0; i < limit; i++) {
    for (const key of Object.keys(records[i] ?? {})) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

/** Stringify a single cell value for table display. */
function cellStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Convert an array of records to a 2D string matrix aligned to `headers`. */
function toRows(
  records: Record<string, unknown>[],
  headers: string[],
): string[][] {
  return records.map((record) => headers.map((h) => cellStr(record[h])));
}

// ---------------------------------------------------------------------------
// Parsers (exported for unit tests)
// ---------------------------------------------------------------------------

export function parseJson(body: string, maxRows: number): TabularResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { headers: [], rows: [], totalRows: 0, truncated: false };
  }

  if (!Array.isArray(parsed)) {
    // Top-level object — not an array; return empty so caller can show "no data".
    return { headers: [], rows: [], totalRows: 0, truncated: false };
  }

  const records = parsed as Record<string, unknown>[];
  const totalRows = records.length;
  const slice = records.slice(0, maxRows);
  const headers = collectHeaders(records);
  const rows = toRows(slice, headers);

  return { headers, rows, totalRows, truncated: totalRows > maxRows };
}

export function parseNdjson(body: string, maxRows: number): TabularResult {
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  const totalRows = lines.length;

  const allRecords: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        allRecords.push(obj);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  const headers = collectHeaders(allRecords);
  const slice = allRecords.slice(0, maxRows);
  const rows = toRows(slice, headers);

  return {
    headers,
    rows,
    totalRows,
    truncated: totalRows > maxRows,
  };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<JsonParseRequest>) => {
  const { body, maxRows, mode } = event.data;

  const result =
    mode === "ndjson" ? parseNdjson(body, maxRows) : parseJson(body, maxRows);

  self.postMessage(result);
};
