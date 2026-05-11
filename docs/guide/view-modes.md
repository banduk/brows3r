# View modes

Each pane in brows3r renders the current S3 prefix in one of seven view
modes. The mode is per-pane and persists across sessions
(`useUiStore.defaultViewMode`).

## Details

The default. A virtualized table with sortable columns (Name, Size,
Modified, Class), resizable column widths, multi-select (Shift/Cmd+click,
Cmd+A), and a per-row context menu.

The columns to the right of Name are user-resizable — drag the handle
on each column's left edge. Widths persist across sessions. Hover any
filename to see the full key in a tooltip.

## Icons (Cmd+2)

A dense grid of file icons + truncated names. Best for buckets where
you mostly recognise files visually (e.g. exports, screenshots).

## Gallery (Cmd+3)

Like Icons, but the cells are thumbnails for image/video keys (rendered
via the loopback media server) and large file-type chips for everything
else. Best for image-heavy buckets.

## Columns (Cmd+4)

Finder-style multi-column navigation. Drilling into a folder opens a new
column to the right; the cursor moves with arrow keys, with ←/Backspace
going back a column.

## Tree (Cmd+5)

Expandable folder tree. Useful for buckets with deep, branchy
prefixes — the expanded set is per-pane and persists.

## Flat keys (Cmd+6)

Lists every key under the current prefix recursively, with the full key
path visible. Useful when you know the file exists "somewhere" but not
where. Combine with <kbd>/</kbd> to fuzzy-filter the list.

## Dual pane (Cmd+7)

Two file panes side by side, each with its own profile/bucket/prefix.
Drag-and-drop between them copies; with Cmd it moves. Cross-profile
copies stream through Rust (no bytes via the WebView). Same-profile
copies use S3 `CopyObject` server-side.

---

### Persisting per-bucket preferences

The default view mode applies to fresh buckets. Once you change the mode
in a pane it stays for that pane until you change it again. A planned
enhancement (tracked in the design backlog) is per-bucket "remember last
view mode" — not yet shipped.
