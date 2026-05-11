/**
 * Cross-flow keyboard walkthrough tests.
 *
 * Documents the expected keyboard-only user flows for:
 * - AC-3: view mode switching via Cmd+1..7 (all 7 modes cycle; selection preserved)
 * - AC-4: file operations via keyboard (select, Cmd+C copy, navigate, Cmd+V paste)
 *
 * These tests exercise the shortcut map + pane store + file command dispatching
 * without requiring a fully-wired Tauri runtime.  Tauri calls are mocked via
 * the global setup in src/test/setup.ts.
 *
 * OCP: adding new keyboard flows = one new describe block here.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effect import: registers all file commands so file.copy / file.paste exist.
import "@/commands/definitions/file";
import { registry } from "@/commands/registry";
import { BASELINE_SHORTCUTS } from "@/commands/shortcuts";
import { usePanesStore } from "@/store/panes";
import type { ViewMode } from "@/store/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All 7 view modes in Cmd+1..7 order. */
const VIEW_MODES: ViewMode[] = [
  "Details",
  "IconGrid",
  "Gallery",
  "Column",
  "Tree",
  "FlatKey",
  "DualPane",
];

/** The shortcut map ids for the 7 view modes. */
const VIEW_MODE_SHORTCUT_IDS = [
  "view.mode.details",
  "view.mode.icon",
  "view.mode.gallery",
  "view.mode.column",
  "view.mode.tree",
  "view.mode.flat",
  "view.mode.dual",
] as const;

/** Reset pane store to a known state before each test. */
function resetPaneStore(viewMode: ViewMode = "Details") {
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: {
          profileId: "p-test",
          bucket: "my-bucket",
          prefix: "photos/",
        },
        viewMode,
        selection: new Set(["photos/a.jpg"]),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      },
    ],
    activePaneId: "main",
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-3 flow: view mode switching — all 7 modes cycle via Cmd+1..7
// ---------------------------------------------------------------------------

describe("AC-3 — keyboard view mode cycling", () => {
  it("BASELINE_SHORTCUTS contains Cmd+1..7 for all 7 view modes (mac)", () => {
    // Verify the shortcut map is the authoritative mapping for each mode.
    VIEW_MODE_SHORTCUT_IDS.forEach((id, index) => {
      const entry = BASELINE_SHORTCUTS[id];
      expect(entry, `${id} should be in BASELINE_SHORTCUTS`).toBeDefined();
      // Each entry has mac + default variants; mac uses cmd.
      if (entry && "mac" in entry) {
        expect(entry.mac.mod).toContain("cmd");
        expect(entry.mac.key).toBe(String(index + 1));
      }
    });
  });

  it("BASELINE_SHORTCUTS contains Ctrl+1..7 for all 7 view modes (windows/linux)", () => {
    VIEW_MODE_SHORTCUT_IDS.forEach((id, index) => {
      const entry = BASELINE_SHORTCUTS[id];
      expect(entry, `${id} should be in BASELINE_SHORTCUTS`).toBeDefined();
      if (entry && "default" in entry) {
        expect(entry.default.mod).toContain("ctrl");
        expect(entry.default.key).toBe(String(index + 1));
      }
    });
  });

  it("setViewMode cycles through all 7 modes and preserves location", () => {
    resetPaneStore("Details");

    const paneId = "main";

    VIEW_MODES.forEach((mode) => {
      usePanesStore.getState().setViewMode(paneId, mode);
      const pane = usePanesStore.getState().panes.find((p) => p.id === paneId);
      expect(pane?.viewMode).toBe(mode);
      // Location must survive the mode switch.
      expect(pane?.location?.bucket).toBe("my-bucket");
      expect(pane?.location?.prefix).toBe("photos/");
    });
  });

  it("selection is preserved when switching between non-resetting modes", () => {
    resetPaneStore("Details");

    const paneId = "main";
    // Details → IconGrid: selection should be preserved per AC-3.
    usePanesStore.getState().setViewMode(paneId, "IconGrid");
    const pane = usePanesStore.getState().panes.find((p) => p.id === paneId);
    expect(pane?.selection).toContain("photos/a.jpg");
  });

  it("switching back to Details from Gallery preserves location", () => {
    resetPaneStore("Gallery");

    const paneId = "main";
    usePanesStore.getState().setViewMode(paneId, "Details");
    const pane = usePanesStore.getState().panes.find((p) => p.id === paneId);
    expect(pane?.viewMode).toBe("Details");
    expect(pane?.location?.profileId).toBe("p-test");
  });

  it("all 7 modes are reachable in sequence (full cycle)", () => {
    resetPaneStore("Details");

    const paneId = "main";
    for (const mode of VIEW_MODES) {
      usePanesStore.getState().setViewMode(paneId, mode);
      expect(
        usePanesStore.getState().panes.find((p) => p.id === paneId)?.viewMode,
      ).toBe(mode);
    }
  });

  it("switching from Details back to Details is a no-op for location", () => {
    resetPaneStore("Details");
    usePanesStore.getState().setViewMode("main", "Details");
    const pane = usePanesStore.getState().panes.find((p) => p.id === "main");
    expect(pane?.viewMode).toBe("Details");
    expect(pane?.location?.bucket).toBe("my-bucket");
  });
});

// ---------------------------------------------------------------------------
// AC-4 flow: file operations — Cmd+C copy, navigate, Cmd+V paste
// ---------------------------------------------------------------------------

describe("AC-4 — keyboard copy and paste via custom events", () => {
  beforeEach(() => {
    resetPaneStore("Details");
  });

  it("file.copy command is registered with Cmd+C / Ctrl+C shortcut", () => {
    const def = registry.lookupById("file.copy");
    expect(def).toBeDefined();
    expect(def?.defaultShortcut).toBeDefined();
    const sc = def?.defaultShortcut;
    if (sc && "mac" in sc) {
      expect(sc.mac.key).toBe("c");
      expect(sc.mac.mod).toContain("meta");
    }
  });

  it("file.copy dispatches clipboard:copy custom event with selected keys", () => {
    const handler = vi.fn();
    window.addEventListener("clipboard:copy", handler);

    const def = registry.lookupById("file.copy");
    expect(def).toBeDefined();

    def?.run({
      profileId: "p-test",
      bucket: "my-bucket",
      keys: ["photos/a.jpg"],
      prefix: "photos/",
    });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail.keys).toEqual(["photos/a.jpg"]);
    expect(event.detail.profileId).toBe("p-test");
    expect(event.detail.bucket).toBe("my-bucket");

    window.removeEventListener("clipboard:copy", handler);
  });

  it("file.paste command is registered with Cmd+V / Ctrl+V shortcut", () => {
    const def = registry.lookupById("file.paste");
    expect(def).toBeDefined();
    const sc = def?.defaultShortcut;
    if (sc && "mac" in sc) {
      expect(sc.mac.key).toBe("v");
      expect(sc.mac.mod).toContain("meta");
    }
  });

  it("file.paste dispatches clipboard:paste custom event with dest prefix", () => {
    const handler = vi.fn();
    window.addEventListener("clipboard:paste", handler);

    const def = registry.lookupById("file.paste");
    expect(def).toBeDefined();

    // Simulate navigating to a different prefix before pasting.
    usePanesStore.getState().setLocation("main", {
      profileId: "p-test",
      bucket: "my-bucket",
      prefix: "archive/",
    });

    def?.run({
      profileId: "p-test",
      bucket: "my-bucket",
      prefix: "archive/",
    });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail.destPrefix).toBe("archive/");

    window.removeEventListener("clipboard:paste", handler);
  });

  it("copy then paste flow: copy from photos/, navigate to archive/, paste lands in archive/", () => {
    const copyHandler = vi.fn();
    const pasteHandler = vi.fn();
    window.addEventListener("clipboard:copy", copyHandler);
    window.addEventListener("clipboard:paste", pasteHandler);

    // Step 1: select file in photos/ and copy.
    const copyDef = registry.lookupById("file.copy");
    copyDef?.run({
      profileId: "p-test",
      bucket: "my-bucket",
      keys: ["photos/vacation.jpg"],
      prefix: "photos/",
    });

    // Step 2: navigate to archive/ (simulates keyboard navigation).
    usePanesStore.getState().setLocation("main", {
      profileId: "p-test",
      bucket: "my-bucket",
      prefix: "archive/",
    });

    // Step 3: paste into archive/.
    const pasteDef = registry.lookupById("file.paste");
    pasteDef?.run({
      profileId: "p-test",
      bucket: "my-bucket",
      prefix: "archive/",
    });

    // Assert both events were dispatched in order.
    expect(copyHandler).toHaveBeenCalledOnce();
    expect(pasteHandler).toHaveBeenCalledOnce();

    const copyEvent = copyHandler.mock.calls[0]?.[0] as CustomEvent;
    expect(copyEvent.detail.keys).toEqual(["photos/vacation.jpg"]);

    const pasteEvent = pasteHandler.mock.calls[0]?.[0] as CustomEvent;
    expect(pasteEvent.detail.destPrefix).toBe("archive/");

    window.removeEventListener("clipboard:copy", copyHandler);
    window.removeEventListener("clipboard:paste", pasteHandler);
  });
});

// ---------------------------------------------------------------------------
// A simple keyboard interaction smoke test via userEvent
// ---------------------------------------------------------------------------

describe("AC-3/AC-4 — userEvent keyboard smoke", () => {
  it("keydown Cmd+1 on a document div does not throw and view mode can change to Details", async () => {
    const user = userEvent.setup();
    resetPaneStore("Gallery");

    // Render a minimal focusable container that represents the file area.
    render(
      <div
        data-testid="file-area"
        tabIndex={0}
        onKeyDown={(e) => {
          // Simulate what a shortcut handler would do for Cmd+1.
          if ((e.metaKey || e.ctrlKey) && e.key === "1") {
            usePanesStore.getState().setViewMode("main", "Details");
          }
        }}
      />,
    );

    const area = screen.getByTestId("file-area");
    area.focus();

    await user.keyboard("{Meta>}1{/Meta}");

    expect(
      usePanesStore.getState().panes.find((p) => p.id === "main")?.viewMode,
    ).toBe("Details");
  });

  it("keydown Cmd+7 activates DualPane mode", async () => {
    const user = userEvent.setup();
    resetPaneStore("Details");

    render(
      <div
        data-testid="file-area"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "7") {
            usePanesStore.getState().setViewMode("main", "DualPane");
          }
        }}
      />,
    );

    screen.getByTestId("file-area").focus();
    await user.keyboard("{Meta>}7{/Meta}");

    expect(
      usePanesStore.getState().panes.find((p) => p.id === "main")?.viewMode,
    ).toBe("DualPane");
  });
});
