/**
 * Clipboard helpers with Tauri 2 fallback.
 *
 * The browser `navigator.clipboard` API requires a secure context (HTTPS) or
 * localhost.  In a Tauri WebView the origin is usually `tauri://localhost`, so
 * the browser API should work.  The Tauri 2 clipboard plugin
 * (`@tauri-apps/plugin-clipboard-manager`) is the preferred path when the
 * browser API is unavailable.
 *
 * OCP: adding MIME-typed clipboard support (system file clipboard) = one new
 * function here; no consumers need to change for the current text-only use case.
 */

// ---------------------------------------------------------------------------
// writeText
// ---------------------------------------------------------------------------

/**
 * Write a text string to the OS clipboard.
 *
 * Tries `navigator.clipboard.writeText` first (available in Tauri WebView
 * under `tauri://localhost`).  Falls back to a Tauri IPC call if the browser
 * API is not available or throws.
 */
export async function writeText(text: string): Promise<void> {
  // Primary: browser Clipboard API.
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Fall through to Tauri fallback.
    }
  }

  // Fallback: Tauri clipboard plugin (dynamic import; plugin may not be installed).
  try {
    // Use Function constructor to bypass TypeScript module resolution while
    // allowing Vite to skip the bundle step at build time.
    // Function constructor bypasses TypeScript module resolution so this
    // optional plugin import does not cause TS2307 when the package is absent.
    // eslint-disable-next-line no-new-func
    const load = new Function("m", "return import(m)");
    const mod = await load("@tauri-apps/plugin-clipboard-manager").catch(
      () => null,
    );
    if (mod) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic plugin shape
      await (mod as any).writeText(text);
      return;
    }
  } catch (_) {
    // Last resort: execCommand for very old environments.
  }

  // execCommand fallback (synchronous, deprecated but universally available).
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}

// ---------------------------------------------------------------------------
// writeFiles
// ---------------------------------------------------------------------------

/**
 * Write file paths to the OS clipboard.
 *
 * If a native file clipboard API (Tauri plugin) is unavailable, the paths are
 * encoded as a newline-separated `text/uri-list` string and written as text.
 * This ensures at minimum the paths are accessible on paste in text form.
 *
 * Future: when Tauri 2's clipboard plugin exposes file-list clipboard, swap
 * the primary branch here without changing any call sites.
 */
export async function writeFiles(paths: string[]): Promise<void> {
  // Try Tauri clipboard plugin with file support.
  try {
    // Function constructor bypasses TypeScript module resolution so this
    // optional plugin import does not cause TS2307 when the package is absent.
    // eslint-disable-next-line no-new-func
    const load = new Function("m", "return import(m)");
    const mod = await load("@tauri-apps/plugin-clipboard-manager").catch(
      () => null,
    );
    if (mod) {
      // Encode as RFC 2483 text/uri-list (file:// URIs, one per line).
      const uriList = paths
        .map((p) => (p.startsWith("file://") ? p : `file://${p}`))
        .join("\r\n");
      // biome-ignore lint/suspicious/noExplicitAny: dynamic plugin shape
      await (mod as any).writeText(uriList);
      return;
    }
  } catch (_) {
    // Fall through to text fallback.
  }

  // Text fallback: one path per line.
  await writeText(paths.join("\n"));
}
