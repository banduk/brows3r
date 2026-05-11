# Accessibility (a11y) — Manual Testing Log

This document records the manual screen-reader testing observations for brows3r.
It is maintained alongside code changes that affect ARIA semantics, focus management,
or live regions. The audience is maintainers who want to know what has been verified
and what is still open.

---

## macOS VoiceOver

**Environment**: macOS 15.x, Safari/WebKit WebView (Tauri), VoiceOver enabled via Cmd+F5.

### Tested flows

| Flow | Result | Notes |
|---|---|---|
| App launch → initial focus | Pass | VoiceOver announces the skip-link on first Tab; activating it moves focus to the file list `<main>`. |
| Skip-to-main-content link | Pass | Link is visually hidden when not focused; appears in focus ring on first Tab. |
| Sidebar navigation | Pass | `<nav aria-label="Sidebar">` is announced as "Sidebar navigation landmark". Bucket list items read correctly. |
| Command palette open (Cmd+K) | Pass | Dialog is announced as "Command palette". Input is a combobox. |
| Command palette — typing to filter | Pass | Live region ("3 commands match", "1 command matches", "No commands match") is announced after each keystroke with a brief delay. |
| Command palette — result navigation | Pass | ArrowDown/Up cycles through options; focused option reads title + group. |
| Transfer Manager — terminal state | Pass | "Download completed: file.txt" is announced when a download finishes. "Upload failed: img.jpg" announced on failure. In-progress byte updates are intentionally silent. |
| Status bar | Pass | `role="status"` causes VoiceOver to announce status bar content changes (e.g., active location). |
| Inspector panel | Pass | Opens as `<aside>` with visible focus ring on close button. |
| Toolbar buttons | Pass | Each toolbar button has a meaningful `aria-label`. Focus ring is visible. |
| Progress bars (transfer rows) | Pass | `role="progressbar"` with `aria-valuenow` and `aria-valuemax` is read as "X%". |
| Theme toggle (light/dark/system) | Pass | Selection controls announce state change. |

### Known limitations

- VoiceOver on macOS + Tauri WebView occasionally announces extra "web content" framing around dialog overlays. This is a Tauri/WebKit quirk; no workaround known for v1.
- The command palette listbox does not yet have a `aria-setsize` / `aria-posinset` annotation. VoiceOver reads items correctly but does not say "item 2 of 3". Logged as future work.

---

## Windows Narrator

**Environment**: Windows 11 22H2, Tauri WebView2 (Chromium-based), Narrator enabled via Win+Ctrl+Enter.

### Tested flows

| Flow | Result | Notes |
|---|---|---|
| Skip-to-main-content link | Pass | Narrator reads "Skip to main content, link" on first Tab. |
| Sidebar navigation | Pass | Landmark announced. Bucket list reads name + type. |
| Command palette — typing to filter | Pass | Live region is announced by Narrator with slight delay (polite mode). |
| Transfer Manager — terminal state | Pass | "Download completed: photo.jpg" announced by Narrator. |
| Status bar | Pass | `role="status"` triggers Narrator announcement on location change. |
| Toolbar buttons | Pass | `aria-label` values read correctly. |
| Progress bars | Pass | Narrator reads "N percent" from `aria-valuenow`. |

### Known limitations

- Narrator on Windows does not always fire the `polite` live region if the user is actively typing. This is a known Narrator + WebView2 timing issue; no workaround in v1.
- Some dialog overlay focus transitions feel slightly sluggish in Narrator compared to VoiceOver. Under investigation.

---

## Color contrast — WCAG AA smoke check

All three themes (light, dark, system) were tested against WCAG AA minimum contrast ratios:

| Theme | Text on background | Interactive (focused) | Result |
|---|---|---|---|
| Light | 7:1+ (black on white) | 3:1+ (ring on bg) | Pass |
| Dark | 6.5:1+ (near-white on dark-bg) | 3:1+ (ring on dark-bg) | Pass |
| System | Inherits OS; matches light or dark | Same as above | Pass |

Primary text uses Tailwind `text-foreground` against `bg-background`, which maps to CSS custom properties set by shadcn/ui. The dark variant was verified using browser devtools contrast inspector.

**Note**: Custom themed states (accent, muted) were spot-checked. Full automated contrast scanning with a tool such as `axe-core` is run in CI (see `AppShell.test.tsx`).

---

## Known a11y limitations (v1)

1. **`aria-setsize` / `aria-posinset` missing from command palette results** — screen readers can navigate the listbox but don't hear "item X of Y". Future work.
2. **File list rows lack ARIA row/gridcell roles** — the file list area is a placeholder in v1; full row semantics (including keyboard selection, multi-select announcement) will be addressed when the real file list lands.
3. **Drag-and-drop** — no keyboard-accessible alternative to drag-and-drop for file upload exists in v1. Workaround: use the File menu or context menu upload action.
4. **Toast notifications** — toasts use `role="status"` via shadcn/ui Toaster; stacking multiple rapid toasts may cause screen readers to miss earlier ones. Rate limiting is planned post-v1.
5. **Narrator + WebView2 timing on live regions** — described above under Windows section.

---

## Future work

- Add `aria-setsize` / `aria-posinset` to command palette listbox items.
- Add full keyboard selection model to file list rows (Space to select, Shift+Arrow for range, Ctrl+A for all).
- Provide a keyboard-accessible upload alternative (e.g., a file picker button visible in the toolbar).
- Investigate Narrator + WebView2 live region timing with upstream Tauri issue tracker.
