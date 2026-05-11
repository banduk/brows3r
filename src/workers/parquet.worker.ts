/**
 * parquet.worker.ts — Parquet parser for TablePreview.
 *
 * Receives: { body: string; maxRows: number }
 *   body: base64-encoded parquet file bytes
 * Returns:  { headers: string[]; rows: string[][]; totalRows: number; truncated: boolean }
 *
 * parquet-wasm and apache-arrow are lazy-imported on first call so the bundle
 * only grows when a user actually opens a Parquet file.
 *
 * OCP: Switching to a streaming/server-side Parquet reader is a worker
 * replacement — the message contract is stable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParquetParseRequest {
  body: string;
  maxRows: number;
}

export interface TabularResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode a base64 string to Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Stringify a cell value for table display. */
function cellStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<ParquetParseRequest>) => {
  const { body, maxRows } = event.data;

  try {
    // Lazy-load parquet-wasm — bundle stays small until first use.
    const [parquet, { tableFromIPC }] = await Promise.all([
      import("parquet-wasm"),
      import("apache-arrow"),
    ]);
    await parquet.default();

    const bytes = base64ToBytes(body);

    // readParquet returns an Arrow table in WebAssembly memory.
    const wasmTable = parquet.readParquet(bytes);

    // Convert to Arrow IPC stream, then parse with apache-arrow.
    const ipcBuffer = wasmTable.intoIPCStream();
    const table = tableFromIPC(ipcBuffer);

    const headers = table.schema.fields.map((f) => f.name);
    const totalRows = table.numRows;

    const collectedRows: string[][] = [];
    const limit = Math.min(totalRows, maxRows);

    for (let i = 0; i < limit; i++) {
      const row = headers.map((h) => {
        const col = table.getChild(h);
        return cellStr(col?.get(i));
      });
      collectedRows.push(row);
    }

    const result: TabularResult = {
      headers,
      rows: collectedRows,
      totalRows,
      truncated: totalRows > maxRows,
    };

    self.postMessage(result);
  } catch (err) {
    // Post an error-shaped message so TablePreview can show an error state.
    const result: TabularResult = {
      headers: [],
      rows: [],
      totalRows: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(result);
  }
};
