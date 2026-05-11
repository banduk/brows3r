/**
 * useDropTarget — makes a pane container accept cross-pane DnD drops.
 *
 * Returns drag event handlers (`onDragOver`, `onDragLeave`, `onDrop`) and an
 * `isOver` boolean for visual feedback.  On drop the handler reads the
 * `application/x-brows3r-dnd` payload and calls `onCrossPaneDrop`.
 *
 * OCP: adding support for new drop targets (e.g. a trash-bin icon) is one
 * new `useDropTarget` call site; the callback wiring is the only change.
 */

import { useCallback, useState } from "react";
import type { DndPayload } from "./useDragSource";
import { DND_MIME } from "./useDragSource";

interface UseDropTargetOptions {
  /** The pane that owns this drop target. */
  paneId: string;
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  /** Current folder prefix for this pane. */
  prefix: string;
  /** Called when a valid in-app drag is dropped here. */
  onCrossPaneDrop: (
    payload: DndPayload,
    targetPaneId: string,
    targetBucket: string,
    targetPrefix: string,
    modifierKeys: { shift: boolean },
  ) => void;
}

interface DropTargetHandlers {
  /** Whether a dragged item is currently over this target. */
  isOver: boolean;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
}

/**
 * Makes the component that spreads these handlers a drop target for
 * in-app cross-pane DnD.
 */
export function useDropTarget({
  paneId,
  bucket,
  prefix,
  onCrossPaneDrop,
}: UseDropTargetOptions): DropTargetHandlers {
  const [isOver, setIsOver] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    // Only accept our custom MIME type.
    if (!e.dataTransfer.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.shiftKey ? "copy" : "move";
    setIsOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    // Only clear when leaving the container itself (not a child element).
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      setIsOver(false);

      const raw = e.dataTransfer.getData(DND_MIME);
      if (!raw) return;

      let payload: DndPayload;
      try {
        payload = JSON.parse(raw) as DndPayload;
      } catch {
        return;
      }

      // Ignore drops onto the same pane.
      if (payload.sourcePaneId === paneId) return;
      if (!bucket) return;

      onCrossPaneDrop(payload, paneId, bucket, prefix, {
        shift: e.shiftKey,
      });
    },
    [paneId, bucket, prefix, onCrossPaneDrop],
  );

  return { isOver, onDragOver, onDragLeave, onDrop };
}
