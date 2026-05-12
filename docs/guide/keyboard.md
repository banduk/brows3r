# Keyboard shortcuts

brows3r is built keyboard-first. Every view-mode is fully navigable without
a pointer; mouse interactions exist for discoverability and bulk selection.

The status bar's `Keys` chip surfaces a condensed version of this list at
all times.

## Global

| Shortcut | Action |
|---|---|
| <kbd>Cmd</kbd>+<kbd>K</kbd> | Open the command palette |
| <kbd>Cmd</kbd>+<kbd>F</kbd> | Recursive search (current bucket + prefix) |
| <kbd>/</kbd> | Filter the current view (fuzzy) |
| <kbd>Cmd</kbd>+<kbd>/</kbd> | Toggle preview pane |
| <kbd>Cmd</kbd>+<kbd>L</kbd> | Edit breadcrumb path |
| <kbd>Cmd</kbd>+<kbd>I</kbd> | Inspector for the selection |
| <kbd>Cmd</kbd>+<kbd>,</kbd> | Open settings |
| <kbd>Cmd</kbd>+<kbd>[</kbd> | Back |
| <kbd>Cmd</kbd>+<kbd>]</kbd> | Forward |
| <kbd>Cmd</kbd>+<kbd>↑</kbd> | Up one level |

## Activity & notifications

| Shortcut | Action |
|---|---|
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> | Toggle the Activity Center (downloads / uploads) |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> | Toggle the Notifications Center (errors / warnings / info) |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> | Toggle the compact transfer popup |

The two Centers are mutually exclusive destinations — opening one
collapses the other. Transfer events appear only in the Activity
Center, never in the Notifications bell.

## View modes

| Shortcut | View |
|---|---|
| <kbd>Cmd</kbd>+<kbd>1</kbd> | Details |
| <kbd>Cmd</kbd>+<kbd>2</kbd> | Icons |
| <kbd>Cmd</kbd>+<kbd>3</kbd> | Gallery |
| <kbd>Cmd</kbd>+<kbd>4</kbd> | Columns |
| <kbd>Cmd</kbd>+<kbd>5</kbd> | Tree |
| <kbd>Cmd</kbd>+<kbd>6</kbd> | Flat keys |
| <kbd>Cmd</kbd>+<kbd>7</kbd> | Dual pane |

## In any view

| Shortcut | Action |
|---|---|
| <kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>←</kbd> / <kbd>→</kbd> | Move cursor |
| <kbd>Enter</kbd> | Open / drill in |
| <kbd>Backspace</kbd> | Up one level (or back column in Columns view) |
| <kbd>Shift</kbd>+click | Range-select |
| <kbd>Cmd</kbd>+click | Toggle-select |
| <kbd>Cmd</kbd>+<kbd>A</kbd> | Select all in current pane |

## In the editor (Monaco)

| Shortcut | Action |
|---|---|
| <kbd>Cmd</kbd>+<kbd>S</kbd> | Save (with ETag precondition; on conflict you get Refresh / Save-anyway) |
| <kbd>Esc</kbd> | Exit edit mode → back to highlighted view |

## In the PDF preview

| Shortcut | Action |
|---|---|
| <kbd>PageDown</kbd> / <kbd>PageUp</kbd> | Next / previous page |

> On Linux and Windows, <kbd>Ctrl</kbd> substitutes for <kbd>Cmd</kbd> in
> every binding above.

## Customising

Shortcuts are not yet user-customisable in v1. The roadmap entry is in
[`docs/contributing/dev.md`](/contributing/dev) — search for "shortcut
registry".
