/**
 * Extension → Monaco language ID map.
 *
 * Monaco ships a fixed set of built-in language IDs. This map mirrors the
 * Shiki extension map but uses Monaco's identifiers (which mostly match —
 * "shell" instead of "bash", no "hcl"/"protobuf"). Unknown extensions fall
 * back to "plaintext" so the editor still renders with line numbers and
 * search but without syntax colours.
 */

const EXT_TO_MONACO: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".json": "json",
  ".jsonc": "json",
  ".geojson": "json",
  ".ndjson": "json",
  ".jsonl": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".svg": "xml",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "ini",
  ".ini": "ini",
  ".conf": "ini",
  ".cfg": "ini",
  ".properties": "ini",
  ".env": "shell",
  ".rs": "rust",
  ".go": "go",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".sql": "sql",
  ".xml": "xml",
  ".plist": "xml",
  ".dockerfile": "dockerfile",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".lua": "lua",
  ".r": "r",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "proto",
  ".pl": "perl",
  ".pm": "perl",
  ".dart": "dart",
  ".scala": "scala",
  ".clj": "clojure",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".vb": "vb",
  ".fs": "fsharp",
  ".pas": "pascal",
  ".ps1": "powershell",
  ".bat": "bat",
  ".cmd": "bat",
  ".tex": "latex",
  ".diff": "diff",
  ".patch": "diff",
  ".log": "log",
  ".csv": "plaintext",
  ".tsv": "plaintext",
  ".txt": "plaintext",
};

const BASENAME_TO_MONACO: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  procfile: "yaml",
  vagrantfile: "ruby",
  jenkinsfile: "groovy",
  brewfile: "ruby",
  podfile: "ruby",
};

/**
 * Map a key to a Monaco language ID. Returns "plaintext" for unknown
 * extensions so the editor still renders cleanly.
 */
export function keyToMonacoLanguage(key: string): string {
  const basename = (key.split("/").pop() ?? "").toLowerCase();
  if (!basename.includes(".")) {
    return BASENAME_TO_MONACO[basename] ?? "plaintext";
  }
  const dot = basename.lastIndexOf(".");
  const ext = basename.slice(dot);
  return EXT_TO_MONACO[ext] ?? "plaintext";
}
