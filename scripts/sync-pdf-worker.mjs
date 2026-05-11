#!/usr/bin/env node
/**
 * Copy `pdfjs-dist/build/pdf.worker.min.mjs` into `public/` so it is served
 * as a static asset by both `vite` and the Tauri build. PdfPreview points
 * its `pdfjs.GlobalWorkerOptions.workerSrc` at `/pdf.worker.min.mjs`.
 *
 * Why this script exists:
 *   - `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`
 *     resolves into `node_modules` and the Tauri WebView refuses to load
 *     that path as a module worker ("Importing a module script failed").
 *   - `import "...?url"` works in Vite dev but breaks vitest, because
 *     vitest's resolver doesn't honour `?url` for that specific module.
 *   - A static asset under `public/` is served from `/` in every
 *     environment, so it dodges both problems.
 *
 * Runs in `postinstall`, so a fresh `pnpm install` always lands a worker
 * file whose internals match the resolved pdfjs-dist version. Skips when
 * pdfjs-dist isn't installed yet (e.g. inside a partial repo clone for
 * a doc-only PR).
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DEST = resolve(ROOT, "public", "pdf.worker.min.mjs");

// createRequire is scoped to a file: anchor it at the project root so it
// resolves against the workspace's node_modules (pnpm hoists certain deps
// there). Anchoring at the script location instead would miss them.
const requireFromRoot = createRequire(resolve(ROOT, "package.json"));

function resolveWorker() {
  // pdfjs-dist is a transitive dep of react-pdf, so pnpm does not hoist it
  // to the top-level node_modules. Anchor the resolver at react-pdf's
  // install location — pdfjs-dist is hoisted into its peer node_modules.
  let reactPdfEntry;
  try {
    reactPdfEntry = requireFromRoot.resolve("react-pdf");
  } catch {
    return null;
  }
  const reactPdfRoot = dirname(reactPdfEntry).replace(/\/dist$/, "");
  const requireFromReactPdf = createRequire(
    resolve(reactPdfRoot, "package.json"),
  );
  let pdfjsEntry;
  try {
    pdfjsEntry = requireFromReactPdf.resolve("pdfjs-dist");
  } catch {
    return null;
  }
  const pdfjsRoot = pdfjsEntry.replace(/\/build\/pdf\.mjs$/, "");
  return `${pdfjsRoot}/build/pdf.worker.min.mjs`;
}

const source = resolveWorker();
if (!source) {
  console.warn(
    "[sync-pdf-worker] pdfjs-dist not installed yet, skipping. The PDF preview will fail until you reinstall.",
  );
  process.exit(0);
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(source, DEST);

const sourceShort = source.replace(`${ROOT}/`, "");
console.log(`[sync-pdf-worker] ${sourceShort} → public/pdf.worker.min.mjs`);
