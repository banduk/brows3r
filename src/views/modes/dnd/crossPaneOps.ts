/**
 * crossPaneOps — decides and executes S3-to-S3 cross-pane operations.
 *
 * `handleCrossPaneDrop` is the single decision point:
 * - Default (no modifier): Move  → `objectMove`
 * - Shift held            : Copy  → `objectCopy`
 *
 * OCP: adding Cmd = "symlink-equivalent" is one new branch inside
 * `handleCrossPaneDrop`.
 */

import { objectCopy, objectMove } from "@/api/objects";
import type { DndPayload } from "./useDragSource";

interface CrossPaneDropArgs {
  payload: DndPayload;
  targetPaneId: string;
  targetBucket: string;
  targetPrefix: string;
  modifierKeys: { shift: boolean };
}

/**
 * Fire the right Rust command for every key in the drag payload.
 *
 * Each key is copied/moved independently.  The destination key replaces the
 * source prefix with `targetPrefix` so folder structure is preserved within
 * the prefix.
 *
 * Errors are not surfaced here — the Transfer Manager panel picks them up via
 * `transfer:state` events emitted by the backend.
 */
export async function handleCrossPaneDrop({
  payload,
  targetBucket,
  targetPrefix,
  modifierKeys,
}: CrossPaneDropArgs): Promise<void> {
  const { profileId, bucket: srcBucket, prefix: srcPrefix, keys } = payload;

  const ops = keys.map((srcKey) => {
    // Derive dest key: strip source prefix, prepend target prefix.
    const parts = srcKey.split("/");
    const relative = srcKey.startsWith(srcPrefix)
      ? srcKey.slice(srcPrefix.length)
      : (parts[parts.length - 1] ?? srcKey);
    const destKey = targetPrefix ? `${targetPrefix}${relative}` : relative;

    const source = { bucket: srcBucket, key: srcKey };
    const destination = { bucket: targetBucket, key: destKey };

    if (modifierKeys.shift) {
      return objectCopy(profileId, source, destination);
    }
    return objectMove(profileId, source, destination);
  });

  // Run concurrently; ignore individual errors (Transfer Manager shows them).
  await Promise.allSettled(ops);
}
