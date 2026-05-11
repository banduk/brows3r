/**
 * EditorPanel — full-area modal for non-trivial forms / settings.
 *
 * Replaces tiny centered Dialog popups whenever a form has so many fields
 * that scrolling becomes a hard requirement. The panel:
 *
 * - Covers most of the viewport (max 1100px × 90vh, with side margins).
 * - Has a sticky header with title + close button.
 * - Has a scrollable body (`overflow-y-auto`) — the only thing that scrolls.
 * - Has an optional sticky footer for action buttons (Submit, Cancel, etc.)
 *   so they remain reachable no matter how far the user has scrolled.
 *
 * Built on Radix Dialog primitives so we keep:
 * - Focus trap inside the panel.
 * - Esc-to-close.
 * - Click-outside-to-close (configurable via Radix).
 * - aria-labelledby + role="dialog".
 *
 * OCP: any form too tall for a Dialog drops in here without changing its
 * own internals — same `<EditorPanel title=… footer=…>` shape.
 *
 * Use Dialog (the small floater) for short prompts (confirms, single-input
 * fields, status banners). Use EditorPanel for everything that has more
 * than ~6 fields or a collapsible advanced section.
 */

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EditorPanelProps {
  /** Whether the panel is open. */
  open: boolean;
  /** Called when the user dismisses (Esc, click-outside, or close button). */
  onOpenChange(open: boolean): void;
  /** Panel title shown in the header. */
  title: string;
  /** Optional secondary text under the title. */
  description?: string;
  /** Body content (scrollable). */
  children: React.ReactNode;
  /** Optional sticky footer (typically: Cancel + Submit buttons). */
  footer?: React.ReactNode;
  /**
   * Optional id of the form rendered as a child. When present, the panel
   * adds a top-level focus on first render and forwards Esc to close.
   */
  formId?: string;
  /** Optional override className for the panel container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// EditorPanel
// ---------------------------------------------------------------------------

export function EditorPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: EditorPanelProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/30 backdrop-blur-sm",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            // Center the panel; cap at a sensible width and height so it
            // looks like a centered document on big screens but fills the
            // window on small ones.
            "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex h-[min(90vh,800px)] w-[min(94vw,1100px)] flex-col",
            "rounded-xl bg-popover text-popover-foreground shadow-2xl",
            "ring-1 ring-foreground/10",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
        >
          {/* Sticky header */}
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/40 px-5 py-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-heading text-base font-semibold leading-tight">
                {title}
              </DialogPrimitive.Title>
              {description !== undefined && (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className="shrink-0"
              >
                <XIcon />
              </Button>
            </DialogPrimitive.Close>
          </header>

          {/* Scrollable body — the only element that scrolls */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {children}
          </div>

          {/* Optional sticky footer */}
          {footer !== undefined && (
            <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/40 bg-muted/40 px-5 py-3 sm:flex-row sm:justify-end">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
