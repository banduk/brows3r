/**
 * ContextMenu — right-click + Shift+F10 keyboard context menu for file rows.
 *
 * Design:
 * - Built on the shadcn ContextMenu primitives (Radix UI).
 * - All menu items map to registry command ids from `src/commands/definitions/file.ts`.
 * - Lock-aware: `useLocks(scope)` disables items whose command ids appear in
 *   `blockedActions`. Disabled items show a tooltip "Disabled: {opName} in progress".
 * - Keyboard navigation (Arrow keys, Enter, Escape) is handled by Radix.
 * - Trigger: wrap children with `<ContextMenuTrigger>` (re-exported below).
 *
 * OCP:
 * - Adding a menu item = one new `<ContextMenuItem>` referencing an existing
 *   registry command id.
 * - Lock-aware gating = read `blockedActions` from `useLocks`. No per-item
 *   if-statement needed.
 */

import { useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { registry } from "@/commands/registry";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenu as ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocks } from "@/store/locks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context required for file operation commands. */
export interface FileMenuContext {
  profileId: string;
  bucket: string;
  prefix: string;
  /** Selected S3 keys. */
  keys: string[];
  /** `true` when the right-click was on a blank area (no file selected). */
  isBlankArea?: boolean;
}

interface FileContextMenuProps {
  ctx: FileMenuContext;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Scope string helper
// ---------------------------------------------------------------------------

function makeScope(profileId: string, bucket: string, prefix: string): string {
  return `${profileId}/${bucket}/${prefix}`;
}

// ---------------------------------------------------------------------------
// LockAwareItem
// ---------------------------------------------------------------------------

interface LockAwareItemProps {
  commandId: string;
  label: string;
  blockedActions: string[];
  locks: Array<{ opName: string }>;
  onSelect: () => void;
  /** Additional disabled condition independent of locks. */
  forceDisabled?: boolean;
}

function LockAwareItem({
  commandId,
  label,
  blockedActions,
  locks,
  onSelect,
  forceDisabled = false,
}: LockAwareItemProps) {
  const isLockDisabled = blockedActions.includes(commandId);
  const isDisabled = forceDisabled || isLockDisabled;

  const disabledReason = isLockDisabled
    ? `Disabled: ${locks.map((l) => l.opName).join(", ")} in progress`
    : undefined;

  const item = (
    <ContextMenuItem
      onSelect={isDisabled ? undefined : onSelect}
      disabled={isDisabled}
      aria-disabled={isDisabled}
    >
      {label}
    </ContextMenuItem>
  );

  if (!isDisabled || !disabledReason) return item;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="right">
          <p>{disabledReason}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// FileContextMenu
// ---------------------------------------------------------------------------

export function FileContextMenu({ ctx, children }: FileContextMenuProps) {
  const queryClient = useQueryClient();
  const scope = makeScope(ctx.profileId, ctx.bucket, ctx.prefix);
  const { locks, blockedActions } = useLocks(scope);

  function runCmd(id: string, extra?: Record<string, unknown>) {
    const def = registry.lookupById(id);
    if (!def) return;
    def.run({ ...ctx, queryClient, ...extra });
  }

  const noSelection = ctx.keys.length === 0;
  const multiSelection = ctx.keys.length > 1;

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label="File actions">
        {/* Open */}
        {!ctx.isBlankArea && (
          <LockAwareItem
            commandId="file.open"
            label="Open"
            blockedActions={blockedActions}
            locks={locks}
            onSelect={() => runCmd("file.open")}
            forceDisabled={noSelection}
          />
        )}

        {!ctx.isBlankArea && <ContextMenuSeparator />}

        {/* Copy / Cut / Paste */}
        <ContextMenuLabel>Clipboard</ContextMenuLabel>
        <LockAwareItem
          commandId="file.copy"
          label="Copy"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.copy")}
          forceDisabled={noSelection}
        />
        <LockAwareItem
          commandId="file.cut"
          label="Cut"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.cut")}
          forceDisabled={noSelection}
        />
        <LockAwareItem
          commandId="file.paste"
          label="Paste"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.paste")}
        />

        {/* Copy Presigned URL — closes round-3 finding #1 */}
        <LockAwareItem
          commandId="file.copy_presigned_url"
          label="Copy Presigned URL"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.copy_presigned_url")}
          forceDisabled={noSelection || multiSelection}
        />

        {/* Bookmark — adds the current target (selected item, or the
            current prefix when nothing is selected) to the sidebar. The
            Toolbar's star button listens for this event and routes to
            the same handleBookmark resolver. */}
        <ContextMenuItem
          onSelect={() => {
            window.dispatchEvent(new CustomEvent("bookmark:add"));
          }}
        >
          {ctx.isBlankArea || noSelection
            ? "Bookmark this location"
            : multiSelection
              ? "Bookmark first selected item"
              : "Bookmark this item"}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* File ops */}
        <ContextMenuLabel>Actions</ContextMenuLabel>
        {!multiSelection && !ctx.isBlankArea && (
          <LockAwareItem
            commandId="file.rename"
            label="Rename"
            blockedActions={blockedActions}
            locks={locks}
            onSelect={() => {
              // Open the rename dialog via DOM event; dialog provides destKey.
              window.dispatchEvent(
                new CustomEvent("file:open-rename", {
                  detail: {
                    profileId: ctx.profileId,
                    bucket: ctx.bucket,
                    key: ctx.keys[0],
                  },
                }),
              );
            }}
            forceDisabled={noSelection}
          />
        )}
        <LockAwareItem
          commandId="file.move_to"
          label="Move To…"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.move_to")}
          forceDisabled={noSelection}
        />
        <LockAwareItem
          commandId="file.copy_to"
          label="Copy To…"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.copy_to")}
          forceDisabled={noSelection}
        />
        <LockAwareItem
          commandId="file.delete"
          label="Delete"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.delete")}
          forceDisabled={noSelection}
        />

        {/* Create folder — shown when blank area or always */}
        {ctx.isBlankArea && (
          <LockAwareItem
            commandId="file.create_folder"
            label="Create Folder Here"
            blockedActions={blockedActions}
            locks={locks}
            onSelect={() => {
              window.dispatchEvent(
                new CustomEvent("file:open-create-folder", {
                  detail: {
                    profileId: ctx.profileId,
                    bucket: ctx.bucket,
                    prefix: ctx.prefix,
                  },
                }),
              );
            }}
          />
        )}

        <ContextMenuSeparator />

        {/* Inspector + storage class */}
        <LockAwareItem
          commandId="file.properties"
          label="Properties"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.properties")}
          forceDisabled={noSelection && !ctx.isBlankArea}
        />
        <LockAwareItem
          commandId="storage_class.change"
          label="Storage Class…"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("storage_class.change")}
          forceDisabled={noSelection}
        />

        <ContextMenuSeparator />

        {/* Refresh */}
        <LockAwareItem
          commandId="file.refresh"
          label="Refresh"
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.refresh")}
        />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

// Re-export trigger so consumers only import from this file.
export { ContextMenuTrigger as FileContextMenuTrigger };
