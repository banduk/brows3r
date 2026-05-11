/**
 * Extension → Lucide icon mapping.
 *
 * Using only lucide-react icons (already bundled via shadcn). No extra icon
 * library needed for v1 — keeps the bundle lean.
 *
 * OCP: adding a new extension is one line in EXTENSION_ICONS.
 */

import type { LucideProps } from "lucide-react";
import {
  Archive,
  Binary,
  Code2,
  Cpu,
  Database,
  File,
  FileAudio,
  FileCog,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe,
  Package,
} from "lucide-react";
import type { ComponentType } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any Lucide icon component (or compatible functional component). */
export type IconComponent = ComponentType<LucideProps>;

// ---------------------------------------------------------------------------
// Extension map
// ---------------------------------------------------------------------------

/**
 * Map of lowercase file extension → Lucide icon component.
 *
 * Covers the extensions listed in spec §lib/icons.ts.
 */
const EXTENSION_ICONS: Record<string, IconComponent> = {
  // TypeScript / JavaScript
  ts: Code2,
  tsx: Code2,
  js: Code2,
  jsx: Code2,
  // Data / config
  json: FileJson,
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  // Markup
  md: FileText,
  html: Globe,
  css: Globe,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  // Documents
  pdf: FileText,
  txt: FileText,
  csv: FileSpreadsheet,
  // Archives
  zip: Archive,
  tar: Archive,
  gz: Archive,
  // Video
  mp4: FileVideo,
  mov: FileVideo,
  // Audio
  mp3: FileAudio,
  wav: FileAudio,
  // Languages
  rs: Cpu,
  py: Code2,
  go: Code2,
  // Binary / other
  wasm: Binary,
  sql: Database,
  db: Database,
  pkg: Package,
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Return the icon component for a given file extension.
 *
 * @param ext - Lowercase extension without the leading dot (e.g. `"ts"`).
 *              Accepts null/undefined and falls back to the generic file icon.
 */
export function iconForExtension(
  ext: string | null | undefined,
): IconComponent {
  if (!ext) return File;
  return EXTENSION_ICONS[ext.toLowerCase()] ?? File;
}

/**
 * Return the icon component for a given filename.
 *
 * Extracts the extension (last segment after `.`) and delegates to
 * `iconForExtension`. Dotfiles without an extension get the generic icon.
 */
export function iconForFilename(filename: string): IconComponent {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return File; // dotfile or no extension
  return iconForExtension(filename.slice(dot + 1));
}
