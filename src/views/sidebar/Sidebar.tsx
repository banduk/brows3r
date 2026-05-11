/**
 * Sidebar panel.
 *
 * Layout: a single vertical scroll container holding three labeled sections.
 *
 * - **Profiles** — scrollable list with the "Add profile" button pinned at
 *   the top (always visible, no matter how many profiles there are).
 * - **Bookmarks** — collapsible `<details>` block with its own bounded
 *   scroll area.
 * - **Recents** — collapsible `<details>` block with its own bounded
 *   scroll area.
 *
 * Why this shape:
 * - Resizing the sidebar narrower never hides the Add button (it's at the
 *   top of the Profiles section, not pushed down by long lists).
 * - Bookmarks/Recents can collapse to save vertical space.
 * - Each section has an explicit `max-h` so a long list never starves the
 *   sections below it.
 * - All buttons live INSIDE their section's body, so the row content
 *   (icon + label + ellipsis menu) flows in one direction without
 *   overlapping anything outside.
 *
 * A11y:
 * - `nav` landmark, `aria-label="Sidebar"`.
 * - Each section is a `<section>` with an `aria-labelledby` heading.
 * - `<details>` provides built-in keyboard-toggle behavior and announces
 *   open/closed state to screen readers.
 *
 * OCP: a new sidebar section = one new `<section>` block. Layout is unchanged.
 */

import { BookmarkIcon, ClockIcon, UserCircleIcon } from "lucide-react";
import { Bookmarks } from "./Bookmarks";
import { Profiles } from "./Profiles";
import { Recents } from "./Recents";

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className = "" }: SidebarProps) {
  return (
    <nav
      aria-label="Sidebar"
      className={`flex h-full min-h-0 flex-col overflow-hidden ${className}`}
    >
      {/* Profiles section — flex-1 so it owns the bulk of vertical space.
          Has its own scroll container; Add button is always at the top. */}
      <section
        aria-labelledby="profiles-heading"
        className="flex min-h-0 flex-1 flex-col"
      >
        <SectionHeading id="profiles-heading" icon={<UserCircleIcon />}>
          Profiles
        </SectionHeading>
        {/* The Profiles component renders its own Add button + scrollable list. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <Profiles />
        </div>
      </section>

      {/* Bookmarks — collapsible to save space when unused. */}
      <CollapsibleSection
        title="Bookmarks"
        icon={<BookmarkIcon />}
        headingId="bookmarks-heading"
      >
        <Bookmarks />
      </CollapsibleSection>

      {/* Recents — collapsible. */}
      <CollapsibleSection
        title="Recents"
        icon={<ClockIcon />}
        headingId="recents-heading"
      >
        <Recents />
      </CollapsibleSection>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// SectionHeading — uniform sticky header used by Profiles
// ---------------------------------------------------------------------------

interface SectionHeadingProps {
  id: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function SectionHeading({ id, icon, children }: SectionHeadingProps) {
  return (
    <h2
      id={id}
      className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </h2>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleSection — used by Bookmarks and Recents
// ---------------------------------------------------------------------------

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  headingId: string;
  children: React.ReactNode;
}

function CollapsibleSection({
  title,
  icon,
  headingId,
  children,
}: CollapsibleSectionProps) {
  return (
    <section
      aria-labelledby={headingId}
      className="shrink-0 border-t border-border/40"
    >
      <details className="group">
        <summary
          id={headingId}
          className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/30 [&::-webkit-details-marker]:hidden"
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">
            {icon}
          </span>
          <span className="flex-1 truncate text-left">{title}</span>
          <span
            aria-hidden="true"
            className="text-muted-foreground/60 transition-transform group-open:rotate-90"
          >
            ›
          </span>
        </summary>
        {/* Constrain each collapsible section so a long list never starves
            the rest of the sidebar. Internal scroll inside the bounded box. */}
        <div className="max-h-64 overflow-y-auto">{children}</div>
      </details>
    </section>
  );
}
