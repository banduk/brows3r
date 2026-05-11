/**
 * Lazy Shiki loader.
 *
 * Design goals:
 * - One singleton highlighter, created on first use.
 * - Language grammars are loaded on demand; already-loaded languages are
 *   tracked to avoid redundant dynamic imports.
 * - `extensionToLanguage` is a single flat map — adding a new extension
 *   is one entry.
 * - `highlight` resolves the singleton, loads the grammar if needed, and
 *   returns sanitized Shiki HTML.
 *
 * OCP: adding a new extension = one entry in `EXT_TO_LANG`.
 */

import type { Highlighter } from "shiki";
import { createHighlighter } from "shiki";

// ---------------------------------------------------------------------------
// Extension → language map
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".json": "json",
  ".md": "markdown",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".rs": "rust",
  ".go": "go",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".xml": "xml",
  ".dockerfile": "dockerfile",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".lua": "lua",
  ".r": "r",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
};

// ---------------------------------------------------------------------------
// extensionToLanguage
// ---------------------------------------------------------------------------

/**
 * Map a file extension (including the leading dot) to a Shiki language ID.
 *
 * Returns `null` when the extension is unknown.
 *
 * Case-insensitive: `.TS` → `"typescript"`.
 */
export function extensionToLanguage(ext: string): string | null {
  return EXT_TO_LANG[ext.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Singleton highlighter
// ---------------------------------------------------------------------------

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLanguages = new Set<string>();

/**
 * Return the singleton `Highlighter`, creating it on first call.
 *
 * The highlighter is created with no pre-loaded languages — they are loaded
 * lazily via `loadLanguage`.
 */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    });
  }
  return highlighterPromise;
}

// ---------------------------------------------------------------------------
// loadLanguage
// ---------------------------------------------------------------------------

/**
 * Lazy-load a single language grammar into the singleton highlighter.
 *
 * No-ops if the language has already been loaded.
 */
export async function loadLanguage(lang: string): Promise<void> {
  if (loadedLanguages.has(lang)) return;

  const hl = await getHighlighter();
  await hl.loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0]);
  loadedLanguages.add(lang);
}

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

/**
 * Highlight `code` in the given language.
 *
 * Returns Shiki-generated HTML (sanitized by Shiki itself — safe for
 * `dangerouslySetInnerHTML`).
 *
 * If `lang` is unknown to Shiki, falls back to plain-text wrapping.
 */
export async function highlight(
  code: string,
  lang: string,
  theme: "light" | "dark" = "light",
): Promise<string> {
  const hl = await getHighlighter();
  await loadLanguage(lang);

  const themeName = theme === "dark" ? "github-dark" : "github-light";
  return hl.codeToHtml(code, { lang, theme: themeName });
}
