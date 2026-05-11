# Bookmarks & recents

The sidebar carries two persistent navigation lists: **Bookmarks** (user-
managed) and **Recents** (auto-tracked).

## Bookmarks

Bookmarks point at any level of the hierarchy:

- **Bucket**: opens the bucket root.
- **Folder prefix**: opens that folder.
- **Object key**: opens the parent prefix and pre-selects the key (so the
  preview pane loads automatically).

Add a bookmark from the toolbar star button (matches the active pane's
location) or right-click any entry → "Bookmark". Labels are optional; if
unset the row shows the prefix itself.

The active bookmark — i.e. the one matching the focused pane — gets a
visible highlight so you always know "where you are" relative to your
favourites.

### Auto-prune

When a profile is deleted, any bookmark referencing it would otherwise
become a dead row. brows3r removes orphan bookmarks automatically the
next time both lists are loaded — the user never has to clean up.

### Schema

Bookmarks are stored in the Rust-side `redb` settings store under the
`bookmarks` table. The on-disk shape:

```json
{
  "id": "uuid",
  "profileId": "uuid",
  "bucket": "my-bucket",
  "prefix": "data/2026/q2/report.pdf",
  "label": "Q2 report"
}
```

## Recents

The Recents list mirrors the last 20 distinct locations the user visited,
sorted by most recent. It's automatically maintained — every successful
`setLocation` call commits to the list, with deduplication so revisits
re-surface entries instead of duplicating them.

You can't add to Recents manually; you can only clear it. The intent is
"history", not "favourites" — that's what Bookmarks are for.

### Persistence

Recents persist alongside the rest of the UI state in localStorage (the
Zustand persist middleware). Resetting the app via the ErrorBoundary's
"Reset app state and reload" button wipes it.
