/**
 * TreeView — hierarchical tree with lazy-loaded prefix expansion.
 *
 * Folders (CommonPrefix entries) can be expanded/collapsed via triangle
 * chevrons or ArrowRight/ArrowLeft keyboard shortcuts. Expanding a folder
 * triggers `useObjects` for that prefix; children render indented below.
 *
 * State: `expanded: Set<string>` lives in pane state (panes.ts) so it
 * survives view-mode switches that preserve it (e.g. Tree→Tree). The prop
 * `expanded` and `onExpand`/`onCollapse` are the seam between this component
 * and the store.
 *
 * Virtualisation: visible tree nodes are flattened into an array and rendered
 * through `Virtualized` for O(1) DOM size.
 *
 * Selection: `useSelection` from selection.ts — same model as DetailsView.
 *
 * OCP:
 * - Lazy loading per node: only the entries for a given prefix are fetched
 *   when expanded. Infinite-depth navigation without pre-fetching.
 * - `TreeView` does not import panes.ts; the store wires the `expanded` prop.
 *
 * NOTE: Biome useSemanticElements, useKeyWithClickEvents,
 * useFocusableInteractive, and noArrayIndexKey are suppressed via biome.json.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ObjectEntry } from "@/api/objects";
import { FileIcon } from "@/components/FileIcon";
import { Virtualized } from "@/components/Virtualized";
import { useSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import {
  useObjects,
  useValidatedProfile,
} from "@/query/hooks/useValidatedProfile";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single visible row in the flattened tree list. */
export interface TreeNode {
  entry: ObjectEntry;
  /** Nesting depth (0 = root). */
  depth: number;
  /** Whether this node is currently expanded (only meaningful for folders). */
  isExpanded: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 32;
const INDENT_PX = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryName(entry: ObjectEntry): string {
  if (entry.isPrefix) {
    const parts = entry.key.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] ?? entry.key;
  }
  const parts = entry.key.split("/");
  return parts[parts.length - 1] ?? entry.key;
}

function entryExtension(entry: ObjectEntry): string | null {
  if (entry.isPrefix) return null;
  const name = entryName(entry);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// useChildEntries — fetches children for an expanded prefix
// ---------------------------------------------------------------------------

/**
 * Fetches children for a given prefix. Mounts when the parent prefix is
 * expanded and unmounts when collapsed.
 */
function useChildEntries(
  profileId: string | null | undefined,
  bucket: string | null | undefined,
  prefix: string,
) {
  const { data, isLoading } = useObjects(profileId, bucket, prefix);
  return { entries: data ?? [], isLoading };
}

// ---------------------------------------------------------------------------
// Tree Row
// ---------------------------------------------------------------------------

interface TreeRowProps {
  node: TreeNode;
  flatIndex: number;
  isSelected: boolean;
  isCursor: boolean;
  onClick: (item: ObjectEntry, index: number, e: React.MouseEvent) => void;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
}

function TreeRow({
  node,
  flatIndex,
  isSelected,
  isCursor,
  onClick,
  onExpand,
  onCollapse,
}: TreeRowProps) {
  const { entry, depth, isExpanded } = node;
  const name = entryName(entry);
  const ext = entryExtension(entry);
  const indent = depth * INDENT_PX;

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isExpanded) {
        onCollapse(entry.key);
      } else {
        onExpand(entry.key);
      }
    },
    [entry.key, isExpanded, onExpand, onCollapse],
  );

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={entry.isPrefix ? isExpanded : undefined}
      aria-level={depth + 1}
      tabIndex={isCursor ? 0 : -1}
      className={cn(
        "flex items-center gap-1 pr-3 cursor-default select-none text-sm",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
        isCursor && !isSelected && "ring-1 ring-inset ring-ring",
      )}
      style={{ height: ROW_HEIGHT, paddingLeft: indent + 4 }}
      onClick={(e) => onClick(entry, flatIndex, e)}
      data-testid={`tree-row-${flatIndex.toString()}`}
    >
      {/* Chevron (folders only) */}
      {entry.isPrefix ? (
        <button
          type="button"
          onClick={handleChevronClick}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
          data-testid={`tree-chevron-${entry.key}`}
        >
          <span
            className="text-[10px]"
            style={{
              display: "inline-block",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 120ms",
            }}
          >
            ▶
          </span>
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" aria-hidden="true" />
      )}

      {/* Icon + name */}
      <FileIcon
        extension={ext ?? undefined}
        isFolder={entry.isPrefix}
        className="shrink-0 text-muted-foreground"
        size={14}
      />
      <span className="ml-1 truncate" title={name}>
        {name}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive flat-tree builder
// ---------------------------------------------------------------------------

interface BuildNodesProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  depth: number;
  expanded: Set<string>;
  /** Accumulates nodes into this array (mutated in-place). */
  acc: TreeNode[];
  /** Map of prefix → loaded entries, populated by LazyLoader hooks. */
  childMap: Map<string, ObjectEntry[]>;
  /** Visited prefix set to guard against cycles in malformed data. */
  visited?: Set<string>;
}

function buildNodes({
  prefix,
  depth,
  expanded,
  acc,
  childMap,
  visited = new Set<string>(),
}: BuildNodesProps): void {
  // Guard against cycles (e.g. during tests where a mock returns same data
  // for all prefix queries, which would cause infinite recursion).
  if (visited.has(prefix)) return;
  visited.add(prefix);

  const entries = childMap.get(prefix) ?? [];
  for (const entry of entries) {
    const isExpanded = entry.isPrefix && expanded.has(entry.key);
    acc.push({ entry, depth, isExpanded });
    if (isExpanded) {
      buildNodes({
        profileId: null,
        bucket: null,
        prefix: entry.key,
        depth: depth + 1,
        expanded,
        acc,
        childMap,
        visited,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// ChildLoader — mounts per expanded prefix, populates childMap
// ---------------------------------------------------------------------------

interface ChildLoaderProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  onLoad: (prefix: string, entries: ObjectEntry[]) => void;
}

function ChildLoader({ profileId, bucket, prefix, onLoad }: ChildLoaderProps) {
  const { entries } = useChildEntries(profileId, bucket, prefix);

  // useEffect (not useMemo) so the state update happens after render, not
  // during it — avoids the "setState during render" React warning.
  useEffect(() => {
    if (entries.length > 0) {
      onLoad(prefix, entries);
    }
  }, [entries, prefix, onLoad]);

  return null;
}

// ---------------------------------------------------------------------------
// Validation gate + Empty state
// ---------------------------------------------------------------------------

function ValidationGate({ onValidate }: { onValidate?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">Validate this profile to see contents</p>
      {onValidate && (
        <button
          type="button"
          onClick={onValidate}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          Validate profile
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">This prefix is empty</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreeView
// ---------------------------------------------------------------------------

export interface TreeViewProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  /** Current set of expanded prefix keys. Managed by the pane/store. */
  expanded: Set<string>;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
  onOpen?: (entry: ObjectEntry) => void;
  onNavigateUp?: () => void;
  onValidateProfile?: () => void;
}

export function TreeView({
  profileId,
  bucket,
  prefix,
  expanded,
  onExpand,
  onCollapse,
  onOpen,
  onNavigateUp,
  onValidateProfile,
}: TreeViewProps) {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const {
    data: rootEntries,
    isLoading: rootLoading,
    isGated,
  } = useObjects(profileId, bucket, prefix);

  // childMap holds entries for all loaded prefixes (root + expanded folders).
  const [childMap, setChildMap] = useState<Map<string, ObjectEntry[]>>(
    () => new Map(),
  );

  const handleChildLoad = useCallback(
    (loadedPrefix: string, entries: ObjectEntry[]) => {
      setChildMap((prev) => {
        const next = new Map(prev);
        next.set(loadedPrefix, entries);
        return next;
      });
    },
    [],
  );

  // Keep root entries in childMap under the root prefix key.
  const mapWithRoot = useMemo(() => {
    if (!rootEntries) return childMap;
    const next = new Map(childMap);
    next.set(prefix, rootEntries);
    return next;
  }, [rootEntries, childMap, prefix]);

  // Flatten visible tree into a list.
  const flatNodes = useMemo<TreeNode[]>(() => {
    const acc: TreeNode[] = [];
    buildNodes({
      profileId,
      bucket,
      prefix,
      depth: 0,
      expanded,
      acc,
      childMap: mapWithRoot,
    });
    return acc;
  }, [profileId, bucket, prefix, expanded, mapWithRoot]);

  const { isSelected, onClick, onKeyDown, cursor, setCursor } =
    useSelection<ObjectEntry>(
      flatNodes.map((n) => n.entry),
      (e) => e.key,
    );

  // Collect expanded prefixes so we can mount ChildLoaders.
  const expandedPrefixes = useMemo(() => Array.from(expanded), [expanded]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown(e);

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setCursor(Math.min(cursor + 1, flatNodes.length - 1));
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          setCursor(Math.max(cursor - 1, 0));
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const node = flatNodes[cursor];
          if (node?.entry.isPrefix) {
            if (!node.isExpanded) {
              onExpand(node.entry.key);
            } else {
              // Already expanded: move cursor to first child.
              const firstChildIndex = cursor + 1;
              if (firstChildIndex < flatNodes.length) {
                setCursor(firstChildIndex);
              }
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const currentNode = flatNodes[cursor];
          if (currentNode?.entry.isPrefix && currentNode.isExpanded) {
            // Collapse current folder.
            onCollapse(currentNode.entry.key);
          } else {
            // Move to parent: find nearest ancestor at depth - 1.
            const targetDepth = (currentNode?.depth ?? 1) - 1;
            if (targetDepth >= 0) {
              for (let i = cursor - 1; i >= 0; i--) {
                if ((flatNodes[i]?.depth ?? 0) === targetDepth) {
                  setCursor(i);
                  break;
                }
              }
            }
          }
          break;
        }
        case " ":

        case "Enter": {
          e.preventDefault();
          const node = flatNodes[cursor];
          if (node) onOpen?.(node.entry);
          break;
        }
        case "Backspace": {
          e.preventDefault();
          onNavigateUp?.();
          break;
        }
      }
    },
    [
      onKeyDown,
      cursor,
      flatNodes,
      setCursor,
      onExpand,
      onCollapse,
      onOpen,
      onNavigateUp,
    ],
  );

  // -- Gate -------------------------------------------------------------------
  if (!profileLoading && !isValidated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  // -- Loading ----------------------------------------------------------------
  if (profileLoading || (rootLoading && !rootEntries)) {
    return (
      <div className="flex h-full flex-col" aria-busy="true">
        <span className="sr-only">Loading file tree</span>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="h-8 animate-pulse rounded bg-muted mx-2 my-0.5"
            style={{ width: `${((i % 4) + 3) * 15}%` }}
          />
        ))}
      </div>
    );
  }

  // -- Gated ------------------------------------------------------------------
  if (isGated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  // -- Empty ------------------------------------------------------------------
  if (flatNodes.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState />
      </div>
    );
  }

  // -- Tree -------------------------------------------------------------------
  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="tree"
      aria-label="File tree"
    >
      {/* Mount a ChildLoader for each expanded prefix so data is fetched. */}
      {expandedPrefixes.map((ep) => (
        <ChildLoader
          key={ep}
          profileId={profileId}
          bucket={bucket}
          prefix={ep}
          onLoad={handleChildLoad}
        />
      ))}

      <Virtualized
        items={flatNodes}
        rowHeight={ROW_HEIGHT}
        overscan={8}
        className="flex-1"
        renderRow={(node, index) => (
          <TreeRow
            key={node.entry.key}
            node={node}
            flatIndex={index}
            isSelected={isSelected(node.entry.key)}
            isCursor={cursor === index}
            onClick={onClick}
            onExpand={onExpand}
            onCollapse={onCollapse}
          />
        )}
      />
    </div>
  );
}
