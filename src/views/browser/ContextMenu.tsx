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
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const isLockDisabled = blockedActions.includes(commandId);
  const isDisabled = forceDisabled || isLockDisabled;

  const disabledReason = isLockDisabled
    ? `${locks.map((l) => l.opName).join(", ")} ${t("menu.tooltip.disabledLockSuffix")}`
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
  const { t } = useTranslation();
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
            label={t("menu.file.open")}
            blockedActions={blockedActions}
            locks={locks}
            onSelect={() => runCmd("file.open")}
            forceDisabled={noSelection}
          />
        )}

        {!ctx.isBlankArea && <ContextMenuSeparator />}

        {/* Download — single object: native save dialog, multi/folder:
            destination picker + bulk transfer. Implemented by the
            `file.download` command. */}
        <LockAwareItem
          commandId="file.download"
          label={t("menu.file.download")}
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.download")}
          forceDisabled={noSelection}
        />

        {/* Copy Presigned URL — closes round-3 finding #1 */}
        <LockAwareItem
          commandId="file.copy_presigned_url"
          label={t("menu.file.copyPresignedUrl")}
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.copy_presigned_url")}
          forceDisabled={noSelection || multiSelection}
        />

        {/* Copy / Cut / Paste removed for v0.2.6 — the underlying
            registry commands dispatch `clipboard:copy/cut/paste`
            events that nothing in the app listens for, so the items
            looked active but were no-ops. They stay registered (so
            the palette + tests are unaffected) but are intentionally
            absent from the right-click surface until a clipboard
            store + paste handler land. */}

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
            ? t("menu.file.bookmarkLocation")
            : multiSelection
              ? t("menu.file.bookmarkFirst")
              : t("menu.file.bookmarkItem")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* File ops */}
        <ContextMenuLabel>{t("menu.file.actions")}</ContextMenuLabel>
        {/* Rename / Move To / Copy To / Storage Class are also removed
            for v0.2.6: their event listeners (file:open-rename,
            file:move-to, file:copy-to, storage-class:open-picker) are
            not implemented anywhere. They remain in the registry
            (palette + tests rely on them) but are hidden from the
            right-click menu until the corresponding modal flows ship. */}
        <LockAwareItem
          commandId="file.delete"
          label={t("menu.file.delete")}
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.delete")}
          forceDisabled={noSelection}
        />

        {/* Create folder — shown when blank area or always */}
        {ctx.isBlankArea && (
          <LockAwareItem
            commandId="file.create_folder"
            label={t("menu.file.createFolder")}
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

        {/* Inspector — opens the properties panel for the selected
            item (or the bucket when nothing is selected on a blank
            area). `file.properties` now calls
            `useInspectorStore.openInspector(...)` directly. */}
        <LockAwareItem
          commandId="file.properties"
          label={t("menu.file.properties")}
          blockedActions={blockedActions}
          locks={locks}
          onSelect={() => runCmd("file.properties")}
          forceDisabled={noSelection && !ctx.isBlankArea}
        />

        <ContextMenuSeparator />

        {/* Refresh */}
        <LockAwareItem
          commandId="file.refresh"
          label={t("menu.file.refresh")}
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
