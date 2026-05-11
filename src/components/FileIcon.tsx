/**
 * FileIcon — renders a Lucide icon based on file extension or folder status.
 *
 * OCP: switching to a richer icon set later is one change in `icons.ts`;
 * this component just delegates to `iconForExtension`.
 */

import type { LucideProps } from "lucide-react";
import { Folder } from "lucide-react";
import { iconForExtension } from "@/lib/icons";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileIconProps {
  /** File extension without the leading dot (e.g. `"ts"`). Ignored for folders. */
  extension?: string | null;
  /** When true renders a folder icon regardless of extension. */
  isFolder: boolean;
  className?: string;
  size?: LucideProps["size"];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the appropriate Lucide icon for a file or folder entry.
 *
 * @example
 *   <FileIcon extension="ts" isFolder={false} />
 *   <FileIcon isFolder={true} />
 */
export function FileIcon({
  extension,
  isFolder,
  className,
  size = 16,
}: FileIconProps) {
  if (isFolder) {
    return <Folder className={className} size={size} aria-hidden="true" />;
  }

  const Icon = iconForExtension(extension);
  return <Icon className={className} size={size} aria-hidden="true" />;
}
