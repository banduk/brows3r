/**
 * csv.worker.ts — CSV parser for TablePreview.
 *
 * Receives: { body: string; maxRows: number }
 * Returns:  { headers: string[]; rows: string[][]; totalRows: number; truncated: boolean }
 *
 * Parsing is done off the main thread via PapaParse so the UI stays responsive
 * on files up to the preview size limit (default 50 MB).
 *
 * OCP: Switching to a server-side parser is a worker-replacement — the message
 * contract (headers/rows/totalRows/truncated) is stable.
 */

import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Types (exported for test access)
// ---------------------------------------------------------------------------

export interface CsvParseRequest {
  body: string;
  maxRows: number;
}

export interface TabularResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Parser (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into a TabularResult.
 *
 * The first row is treated as headers. Subsequent rows are collected up to
 * `maxRows`. `totalRows` reflects the true row count (excluding the header).
 */
export function parseCsv(body: string, maxRows: number): TabularResult {
  let totalRows = 0;
  const collectedRows: string[][] = [];
  let headers: string[] = [];
  let headersSet = false;

  Papa.parse<string[]>(body, {
    skipEmptyLines: true,
    step(result) {
      const row = result.data;
      if (!headersSet) {
        headers = row;
        headersSet = true;
        return;
      }
      totalRows++;
      if (collectedRows.length < maxRows) {
        collectedRows.push(row);
      }
    },
  });

  return {
    headers,
    rows: collectedRows,
    totalRows,
    truncated: totalRows > maxRows,
  };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<CsvParseRequest>) => {
  const { body, maxRows } = event.data;
  self.postMessage(parseCsv(body, maxRows));
};
