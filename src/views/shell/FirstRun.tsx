/**
 * FirstRun — welcome modal shown on the first app launch.
 *
 * Reads `firstRunCompleted` from `useUiStore`. When false (i.e. the first
 * time the app runs), the modal is shown with a 3-step quick-start guide.
 * Dismissing via the button or the Esc key sets `firstRunCompleted = true`
 * so the modal never appears again.
 *
 * OCP: the modal content is a self-contained component. Adding onboarding
 * tour steps later means extending this component, not changing any caller.
 *
 * A11y: Dialog with labelled title and description. Esc handled by Radix
 * Dialog's built-in `onOpenChange`.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUiStore } from "@/store/ui";

// ---------------------------------------------------------------------------
// FirstRun — component
// ---------------------------------------------------------------------------

interface FirstRunProps {
  /** Callback to open the ProfileEditor from the parent shell. */
  onOpenProfileEditor?(): void;
}

export function FirstRun({ onOpenProfileEditor }: FirstRunProps) {
  const firstRunCompleted = useUiStore((s) => s.firstRunCompleted);
  const markFirstRunCompleted = useUiStore((s) => s.markFirstRunCompleted);

  // Track whether the user explicitly opened the ProfileEditor from this
  // modal so we can skip re-showing on next render cycles.
  const [dismissed, setDismissed] = useState(false);

  const open = !firstRunCompleted && !dismissed;

  function handleDismiss() {
    markFirstRunCompleted();
    setDismissed(true);
  }

  function handleAddProfile() {
    handleDismiss();
    onOpenProfileEditor?.();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleDismiss()}>
      <DialogContent aria-describedby="first-run-description">
        <img
          src="/brows3r-banner.png"
          alt="brows3r"
          className="-mx-6 -mt-6 mb-2 w-[calc(100%+3rem)] rounded-t-lg"
        />
        <DialogHeader>
          <DialogTitle>Welcome to brows3r</DialogTitle>
          <DialogDescription id="first-run-description">
            A native S3 browser. Get started in three steps.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-col gap-4 py-2 text-sm">
          <li className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              1
            </span>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium">Add a profile</span>
              <p className="text-muted-foreground">
                Connect an AWS profile or enter credentials manually to access
                your S3 buckets.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={handleAddProfile}
              >
                Add profile
              </Button>
            </div>
          </li>

          <li className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              2
            </span>
            <div className="flex flex-col gap-1">
              <span className="font-medium">Validate it</span>
              <p className="text-muted-foreground">
                Use the validate action in the sidebar to confirm your
                credentials are working before browsing.
              </p>
            </div>
          </li>

          <li className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              3
            </span>
            <div className="flex flex-col gap-1">
              <span className="font-medium">Browse buckets</span>
              <p className="text-muted-foreground">
                Once validated, your buckets appear in the sidebar. Click any
                bucket to start exploring objects.
              </p>
            </div>
          </li>
        </ol>

        <DialogFooter>
          <Button onClick={handleDismiss}>Don't show again</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
