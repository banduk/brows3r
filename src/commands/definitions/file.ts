/**
 * File operation command definitions.
 *
 * Registers all file-operation commands with the app-level registry so they
 * are reachable from the context menu, command palette, and keyboard shortcuts.
 *
 * Each command's `run(ctx)` extracts the context it needs from the
 * `CommandContext` bag and delegates to the appropriate API + optimistic helper.
 * The context is expected to carry:
 *   - `profileId: string`
 *   - `bucket: string`
 *   - `keys: string[]`     (selected S3 keys, non-empty)
 *   - `prefix: string`     (current prefix for create-folder, paste, refresh)
 *   - `queryClient: QueryClient` (for optimistic helpers)
 *   - `destKey?: string`   (for rename, move_to, copy_to)
 *   - `destBucket?: string`
 *
 * OCP: adding a new file command = one `registry.register(def)` call here.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  type DeleteKey,
  objectCreateFolder,
  objectDeleteBatch,
  objectMove,
  objectPresign,
} from "@/api/objects";
import { writeText } from "@/lib/clipboard";
import { dispatch, present } from "@/lib/errors";
import {
  optimisticCreateFolder,
  optimisticDeleteSingle,
  optimisticRenameSingle,
} from "@/query/optimistic";
import { registry } from "../registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profileId(ctx: Record<string, unknown>): string | undefined {
  return typeof ctx.profileId === "string" ? ctx.profileId : undefined;
}

function bucket(ctx: Record<string, unknown>): string | undefined {
  return typeof ctx.bucket === "string" ? ctx.bucket : undefined;
}

function selectedKeys(ctx: Record<string, unknown>): string[] {
  return Array.isArray(ctx.keys) ? (ctx.keys as string[]) : [];
}

function firstKey(ctx: Record<string, unknown>): string | undefined {
  const k = selectedKeys(ctx);
  return k.length > 0 ? k[0] : undefined;
}

function currentPrefix(ctx: Record<string, unknown>): string {
  return typeof ctx.prefix === "string" ? ctx.prefix : "";
}

function getQueryClient(ctx: Record<string, unknown>): QueryClient | undefined {
  return ctx.queryClient instanceof Object &&
    typeof (ctx.queryClient as { cancelQueries?: unknown }).cancelQueries ===
      "function"
    ? (ctx.queryClient as QueryClient)
    : undefined;
}

// ---------------------------------------------------------------------------
// file.open
// ---------------------------------------------------------------------------

registry.register({
  id: "file.open",
  title: "Open",
  group: "File",
  description: "Open the selected file or navigate into the selected folder.",
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("file:open", {
        detail: { keys: selectedKeys(ctx), profileId: profileId(ctx) },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// file.copy
// ---------------------------------------------------------------------------

registry.register({
  id: "file.copy",
  title: "Copy",
  group: "File",
  description: "Copy the selected items to the clipboard.",
  defaultShortcut: {
    mac: { key: "c", mod: ["meta"] },
    default: { key: "c", mod: ["ctrl"] },
  },
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("clipboard:copy", {
        detail: {
          keys: selectedKeys(ctx),
          profileId: profileId(ctx),
          bucket: bucket(ctx),
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// file.cut
// ---------------------------------------------------------------------------

registry.register({
  id: "file.cut",
  title: "Cut",
  group: "File",
  description: "Cut the selected items (move to clipboard).",
  defaultShortcut: {
    mac: { key: "x", mod: ["meta"] },
    default: { key: "x", mod: ["ctrl"] },
  },
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("clipboard:cut", {
        detail: {
          keys: selectedKeys(ctx),
          profileId: profileId(ctx),
          bucket: bucket(ctx),
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// file.paste
// ---------------------------------------------------------------------------

registry.register({
  id: "file.paste",
  title: "Paste",
  group: "File",
  description: "Paste the clipboard items into the current prefix.",
  defaultShortcut: {
    mac: { key: "v", mod: ["meta"] },
    default: { key: "v", mod: ["ctrl"] },
  },
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("clipboard:paste", {
        detail: {
          destPrefix: currentPrefix(ctx),
          profileId: profileId(ctx),
          bucket: bucket(ctx),
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// file.rename
// ---------------------------------------------------------------------------

registry.register({
  id: "file.rename",
  title: "Rename",
  group: "File",
  description: "Rename the selected item.",
  defaultShortcut: { key: "F2" },
  async run(ctx) {
    const pid = profileId(ctx);
    const bkt = bucket(ctx);
    const key = firstKey(ctx);
    const destKey = typeof ctx.destKey === "string" ? ctx.destKey : undefined;

    if (!pid || !bkt || !key || !destKey) return;

    const qc = getQueryClient(ctx);
    let rollback: (() => void) | undefined;

    try {
      if (qc) {
        ({ rollback } = await optimisticRenameSingle(
          qc,
          pid,
          bkt,
          key,
          destKey,
        ));
      }

      // Rename = move within the same bucket.
      await objectMove(
        pid,
        { bucket: bkt, key },
        { bucket: bkt, key: destKey },
      );
    } catch (err) {
      rollback?.();
      if (
        typeof err === "object" &&
        err !== null &&
        "kind" in err &&
        "message" in err &&
        "retryable" in err
      ) {
        const policy = present(
          err as Parameters<typeof present>[0],
          "userInitiated",
        );
        await dispatch(
          {
            id: `rename-err-${Date.now().toString()}`,
            severity: "error",
            category: "userInitiated",
            title: "Rename failed",
            message: (err as { message: string }).message,
            resource: key,
            operation: "rename",
            timestamp: Date.now(),
            details: err,
          },
          policy.placement,
        );
      }
    }
  },
});

// ---------------------------------------------------------------------------
// file.delete
// ---------------------------------------------------------------------------

registry.register({
  id: "file.delete",
  title: "Delete",
  group: "File",
  description: "Delete the selected items.",
  defaultShortcut: { key: "Delete" },
  async run(ctx) {
    const pid = profileId(ctx);
    const bkt = bucket(ctx);
    const ks = selectedKeys(ctx);

    if (!pid || !bkt || ks.length === 0) return;

    const qc = getQueryClient(ctx);
    const singleKey = ks.length === 1 ? ks[0] : undefined;
    let rollback: (() => void) | undefined;

    try {
      // Optimistic only for single-key delete.
      if (qc && singleKey) {
        ({ rollback } = await optimisticDeleteSingle(qc, pid, bkt, singleKey));
      }

      const deleteKeys: DeleteKey[] = ks.map((k) => ({ key: k }));
      await objectDeleteBatch(pid, bkt, deleteKeys);
    } catch (err) {
      rollback?.();
      if (
        typeof err === "object" &&
        err !== null &&
        "kind" in err &&
        "message" in err &&
        "retryable" in err
      ) {
        const policy = present(
          err as Parameters<typeof present>[0],
          "userInitiated",
        );
        await dispatch(
          {
            id: `delete-err-${Date.now().toString()}`,
            severity: "error",
            category: "userInitiated",
            title: "Delete failed",
            message: (err as { message: string }).message,
            resource: ks.join(", "),
            operation: "delete",
            timestamp: Date.now(),
            details: err,
          },
          policy.placement,
        );
      }
    }
  },
});

// ---------------------------------------------------------------------------
// file.create_folder
// ---------------------------------------------------------------------------

registry.register({
  id: "file.create_folder",
  title: "Create Folder Here",
  group: "File",
  description: "Create a new folder in the current prefix.",
  async run(ctx) {
    const pid = profileId(ctx);
    const bkt = bucket(ctx);
    const folderName =
      typeof ctx.folderName === "string" ? ctx.folderName : undefined;
    const prefix = currentPrefix(ctx);

    if (!pid || !bkt || !folderName) return;

    const newPrefix = prefix ? `${prefix}${folderName}/` : `${folderName}/`;
    const qc = getQueryClient(ctx);
    let rollback: (() => void) | undefined;

    try {
      if (qc) {
        ({ rollback } = await optimisticCreateFolder(qc, pid, bkt, newPrefix));
      }
      await objectCreateFolder(pid, bkt, newPrefix);
    } catch (err) {
      rollback?.();
      if (
        typeof err === "object" &&
        err !== null &&
        "kind" in err &&
        "message" in err &&
        "retryable" in err
      ) {
        const policy = present(
          err as Parameters<typeof present>[0],
          "userInitiated",
        );
        await dispatch(
          {
            id: `mkdir-err-${Date.now().toString()}`,
            severity: "error",
            category: "userInitiated",
            title: "Create folder failed",
            message: (err as { message: string }).message,
            resource: newPrefix,
            operation: "create_folder",
            timestamp: Date.now(),
            details: err,
          },
          policy.placement,
        );
      }
    }
  },
});

// ---------------------------------------------------------------------------
// file.copy_presigned_url
// Closes round-3 finding #1: the explicit home for presigned-URL frontend wiring.
// ---------------------------------------------------------------------------

registry.register({
  id: "file.copy_presigned_url",
  title: "Copy Presigned URL",
  group: "File",
  description:
    "Generate a presigned URL for the selected file and copy it to the clipboard.",
  async run(ctx) {
    const pid = profileId(ctx);
    const bkt = bucket(ctx);
    const key = firstKey(ctx);
    const expiresSec =
      typeof ctx.expiresSec === "number" ? ctx.expiresSec : undefined;

    if (!pid || !bkt || !key) return;

    try {
      const result = await objectPresign(pid, bkt, key, expiresSec);
      await writeText(result.url);

      // Notify success.
      window.dispatchEvent(
        new CustomEvent("toast:show", {
          detail: {
            title: "Presigned URL copied",
            message: "URL copied to clipboard.",
            severity: "success",
          },
        }),
      );
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "kind" in err &&
        "message" in err &&
        "retryable" in err
      ) {
        const policy = present(
          err as Parameters<typeof present>[0],
          "userInitiated",
        );
        await dispatch(
          {
            id: `presign-err-${Date.now().toString()}`,
            severity: "error",
            category: "userInitiated",
            title: "Copy presigned URL failed",
            message: (err as { message: string }).message,
            resource: key,
            operation: "presign",
            timestamp: Date.now(),
            details: err,
          },
          policy.placement,
        );
      }
    }
  },
});

// ---------------------------------------------------------------------------
// file.move_to
// ---------------------------------------------------------------------------

registry.register({
  id: "file.move_to",
  title: "Move To…",
  group: "File",
  description: "Move the selected items to a chosen destination.",
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("file:move-to", {
        detail: {
          keys: selectedKeys(ctx),
          profileId: profileId(ctx),
          bucket: bucket(ctx),
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// file.copy_to
// ---------------------------------------------------------------------------

registry.register({
  id: "file.copy_to",
  title: "Copy To…",
  group: "File",
  description: "Copy the selected items to a chosen destination.",
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("file:copy-to", {
        detail: {
          keys: selectedKeys(ctx),
          profileId: profileId(ctx),
          bucket: bucket(ctx),
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// file.refresh
// ---------------------------------------------------------------------------

registry.register({
  id: "file.refresh",
  title: "Refresh",
  group: "File",
  description: "Refresh the current listing, bypassing the cache.",
  defaultShortcut: {
    mac: { key: "r", mod: ["meta"] },
    default: { key: "r", mod: ["ctrl"] },
  },
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("file:refresh", {
        detail: {
          profileId: profileId(ctx),
          bucket: bucket(ctx),
          prefix: currentPrefix(ctx),
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// view.inspect (also registered by Toolbar task 40, but re-registration is
// guarded by the registry's duplicate-id check — the Toolbar definition
// already registered this id.  This file registers a complementary
// "Properties" entry in the File group that opens the inspector via the same
// store dispatch pattern.
// ---------------------------------------------------------------------------

registry.register({
  id: "file.properties",
  title: "Properties",
  group: "File",
  description: "Open the inspector panel for the selected item.",
  run(ctx) {
    const pid = profileId(ctx);
    const bkt = bucket(ctx);
    const key = firstKey(ctx);
    if (!pid || !bkt) return;
    window.dispatchEvent(
      new CustomEvent("inspector:open", {
        detail: { profileId: pid, bucket: bkt, key },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// storage_class.change
// ---------------------------------------------------------------------------

registry.register({
  id: "storage_class.change",
  title: "Storage Class…",
  group: "File",
  description:
    "Change the storage class of the selected items (opens diff preview).",
  run(ctx) {
    window.dispatchEvent(
      new CustomEvent("storage-class:open-picker", {
        detail: {
          keys: selectedKeys(ctx),
          profileId: profileId(ctx),
          bucket: bucket(ctx),
        },
      }),
    );
  },
});
