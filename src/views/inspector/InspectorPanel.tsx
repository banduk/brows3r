/**
 * InspectorPanel — slide-in side panel from the right.
 *
 * Toggleable via `useInspectorStore`. Renders either <BucketInspector /> or
 * <ObjectInspector /> based on the `target`:
 *  - target.key is null/undefined → BucketInspector
 *  - target.key is a string → ObjectInspector
 *
 * A11y:
 * - `role="region" aria-label="Inspector"` on the panel element.
 * - Focus is moved to the panel heading when the panel opens.
 * - Esc key closes the panel.
 *
 * OCP: adding a "multi-object inspector" is a third branch in the target
 * check below. The panel shell and store are unaffected.
 */

import { useCallback, useEffect, useRef } from "react";
import { useInspectorStore } from "@/store/inspector";
import { BucketInspector } from "./BucketInspector";
import { ObjectInspector } from "./ObjectInspector";

// ---------------------------------------------------------------------------
// InspectorPanel
// ---------------------------------------------------------------------------

export function InspectorPanel(): React.ReactElement | null {
  const { open, target, closeInspector } = useInspectorStore();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the panel heading when it opens.
  useEffect(() => {
    if (open && headingRef.current) {
      headingRef.current.focus();
    }
  }, [open]);

  // Close on Escape.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeInspector();
      }
    },
    [closeInspector],
  );

  if (!open || !target) {
    return null;
  }

  const isObject =
    target.key !== undefined && target.key !== null && target.key !== "";

  const panelTitle = isObject
    ? (target.key?.split("/").pop() ?? target.key)
    : target.bucket;

  return (
    <section
      aria-label="Inspector"
      onKeyDown={handleKeyDown}
      className="flex h-full w-80 flex-col border-l bg-background"
      data-testid="inspector-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="truncate text-sm font-semibold outline-none"
        >
          {panelTitle}
        </h2>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={closeInspector}
          className="ml-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isObject && target.key ? (
          <ObjectInspector
            profileId={target.profileId}
            bucket={target.bucket}
            objectKey={target.key}
          />
        ) : (
          <BucketInspector
            profileId={target.profileId}
            bucket={target.bucket}
          />
        )}
      </div>
    </section>
  );
}
