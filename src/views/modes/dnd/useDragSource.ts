/**
 * useDragSource — makes a file-list row draggable within the app.
 *
 * Returns HTML drag event handlers that the row component spreads onto its
 * root element.  The drag payload encodes the source pane, profile, bucket,
 * prefix and selected entry keys as JSON on the `application/x-brows3r-dnd`
 * MIME type so `useDropTarget` can identify in-app drags.
 *
 * OCP: adding a new drag payload field is one key addition to `DndPayload`.
 */

import type { ObjectEntry } from "@/api/objects";

/** Payload serialised on the drag dataTransfer for cross-pane DnD. */
export interface DndPayload {
  /** The pane from which the drag originates. */
  sourcePaneId: string;
  profileId: string;
  bucket: string;
  /** S3 key prefix (the current folder path). */
  prefix: string;
  /** Keys of the dragged entries. */
  keys: string[];
}

export const DND_MIME = "application/x-brows3r-dnd";

interface UseDragSourceOptions {
  paneId: string;
  profileId: string;
  bucket: string;
  prefix: string;
  /** All currently selected entries. When non-empty, the dragged row's key is
   *  merged with the existing selection so that multi-select drag works. */
  selectedKeys: Set<string>;
  entry: ObjectEntry;
}

interface DragSourceHandlers {
  draggable: true;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
}

/**
 * Return `draggable` and `onDragStart` handlers for an entry row.
 *
 * If the row is part of the current selection all selected keys are dragged.
 * If the row is not selected only that single row is dragged.
 */
export function useDragSource({
  paneId,
  profileId,
  bucket,
  prefix,
  selectedKeys,
  entry,
}: UseDragSourceOptions): DragSourceHandlers {
  function onDragStart(e: React.DragEvent<HTMLElement>) {
    const keys =
      selectedKeys.has(entry.key) && selectedKeys.size > 0
        ? [...selectedKeys]
        : [entry.key];

    const payload: DndPayload = {
      sourcePaneId: paneId,
      profileId,
      bucket,
      prefix,
      keys,
    };

    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copyMove";
  }

  return { draggable: true, onDragStart };
}
