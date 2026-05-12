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
import { surfaceUnknownError } from "@/lib/errors";
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
      await surfaceUnknownError(err, {
        operation: "rename",
        resource: key,
        title: "Rename failed",
      });
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
      await surfaceUnknownError(err, {
        operation: "delete",
        resource: ks.join(", "),
        title: "Delete failed",
      });
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
      await surfaceUnknownError(err, {
        operation: "create_folder",
        resource: newPrefix,
        title: "Create folder failed",
      });
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
      await surfaceUnknownError(err, {
        operation: "presign",
        resource: key,
        title: "Copy presigned URL failed",
      });
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
    // Direct store call — the previous `inspector:open` CustomEvent had
    // no listener anywhere in production code, so the menu item was
    // silently dead. The dynamic import keeps `file.ts` free of a
    // direct `@/store/inspector` dep at module-load time (matters for
    // the test seam — the registry is constructed before the store
    // bundle is parsed).
    void import("@/store/inspector").then(({ useInspectorStore }) => {
      useInspectorStore.getState().openInspector({
        profileId: pid,
        bucket: bkt,
        key,
      });
    });
  },
});

// ---------------------------------------------------------------------------
// file.download — save the selected object(s) locally
// ---------------------------------------------------------------------------
//
// Mirrors the toolbar's Download button without duplicating UI state.
// Three branches:
//
//   1. exactly one OBJECT key selected → native Save dialog → single
//      `transferDownloadMany([{...}])`.
//   2. exactly one FOLDER prefix selected → confirm + pick destination
//      directory → enumerate via `objectsListFlat` → bulk transfer
//      mirroring the S3 layout under the chosen dir.
//   3. multiple keys (any mix of objects/folders) → same as (2) but
//      enumerating *each* selected prefix + each object key.
//
// Errors at any step surface via `surfaceUnknownError` in the toolbar
// pattern.

registry.register({
  id: "file.download",
  title: "Download",
  group: "File",
  description: "Save the selected object(s) to a local path.",
  async run(ctx) {
    const pid = profileId(ctx);
    const bkt = bucket(ctx);
    const ks = selectedKeys(ctx);
    if (!pid || !bkt || ks.length === 0) return;

    // Resolve Tauri dialog + transfers API lazily so commandPalette
    // tests do not need to mock the entire Tauri bridge to import
    // this file.
    const [
      { save: saveDialog, open: openDialog },
      { transferDownloadMany },
      { objectsListFlat: listFlat },
    ] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@/api/transfers"),
      import("@/api/objects"),
    ]);

    const onlyKey = ks.length === 1 ? ks[0] : undefined;
    const isSingleObject = onlyKey !== undefined && !onlyKey.endsWith("/");

    try {
      if (isSingleObject && onlyKey) {
        const basename = onlyKey.split("/").pop() ?? onlyKey;
        const dest = await saveDialog({ defaultPath: basename });
        if (!dest) return;
        await transferDownloadMany([
          { profileId: pid, bucket: bkt, key: onlyKey, destPath: dest },
        ]);
        return;
      }

      // Bulk path: prompt for a destination directory, open the dialog
      // in "Counting…" mode, run enumeration in parallel and push the
      // final summary once it completes. The dialog gates Confirm until
      // we report a non-null estimate, so there is no race between
      // listing and the user clicking Start.
      const root = await openDialog({ directory: true, multiple: false });
      if (!root || Array.isArray(root)) return;

      const specs: Array<{
        profileId: string;
        bucket: string;
        key: string;
        destPath: string;
      }> = [];

      const { openBulkDownloadDialog } = await import(
        "@/views/transfers/BulkDownloadHost"
      );
      const dialog = openBulkDownloadDialog({
        destination: root,
        initialEstimate: null,
      });

      // Join base + relative path. S3 keys always use forward slashes;
      // Tauri's backend create_dir_all handles both separators per
      // platform, so we just use "/" here.
      const joinPath = (base: string, rel: string): string =>
        base.endsWith("/") || base.endsWith("\\")
          ? `${base}${rel}`
          : `${base}/${rel}`;

      let files = 0;
      let bytes = 0;
      try {
        for (const k of ks) {
          if (k.endsWith("/")) {
            let cursor: string | undefined;
            do {
              const page = await listFlat(pid as string, bkt as string, k, {
                continuationToken: cursor,
              });
              for (const entry of page.entries) {
                if (entry.isPrefix) continue;
                const rel = entry.key.startsWith(k)
                  ? entry.key.slice(k.length)
                  : entry.key;
                specs.push({
                  profileId: pid as string,
                  bucket: bkt as string,
                  key: entry.key,
                  destPath: joinPath(root, rel),
                });
                files += 1;
                bytes += entry.size ?? 0;
              }
              cursor = page.nextContinuationToken;
            } while (cursor);
          } else {
            const basename = k.split("/").pop() ?? k;
            specs.push({
              profileId: pid as string,
              bucket: bkt as string,
              key: k,
              destPath: joinPath(root, basename),
            });
            files += 1;
          }
        }
        dialog.update({ estimate: { files, bytes }, error: null });
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : "Failed to list files.";
        dialog.update({ estimate: { files, bytes }, error: msg });
      }

      const confirmed = await dialog.decision;
      if (!confirmed) return;

      if (specs.length === 0) {
        const { notify } = await import("@/lib/errors");
        const { default: i18n } = await import("@/i18n");
        notify({
          id: `bulk-download-empty-${Date.now().toString()}`,
          title: i18n.t("bulkDownload.emptyTitle"),
          message: i18n.t("bulkDownload.emptyMessage"),
          severity: "info",
        });
        return;
      }

      await transferDownloadMany(specs);
      // Surface the transfer manager so the user can monitor + cancel.
      const { useTransfersStore } = await import("@/store/transfers");
      useTransfersStore.getState().openPanel();
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "file.download",
        resource: ks.length === 1 ? (ks[0] ?? null) : `${ks.length} items`,
        title: "Failed to start download",
      });
    }
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
