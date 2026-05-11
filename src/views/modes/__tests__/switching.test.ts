/**
 * Tests for switching.ts — view-mode switch contract.
 *
 * Coverage (task 28 scope):
 * 1. All 6 pairwise transitions among Details, IconGrid, Gallery:
 *    - Details → IconGrid
 *    - Details → Gallery
 *    - IconGrid → Details
 *    - IconGrid → Gallery
 *    - Gallery → Details
 *    - Gallery → IconGrid
 *    Each must preserve location AND selection (1:1).
 *
 * Placeholder modes (Tree, Column, FlatKey, DualPane) have stub tests to
 * confirm the module compiles and returns a preserved state; tasks 29/30 add
 * the domain-specific assertions.
 */

import { describe, expect, it } from "vitest";
import type { ObjectEntry } from "@/api/objects";
import type { S3Location } from "@/store/ui";
import type { ViewState } from "../switching";
import { applySwitch } from "../switching";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOCATION: S3Location = {
  profileId: "p1",
  bucket: "my-bucket",
  prefix: "folder/",
};

const SELECTION = new Set(["folder/file-a.ts", "folder/file-b.ts"]);

const ITEMS: ObjectEntry[] = [
  { key: "folder/file-a.ts", size: 100, isPrefix: false },
  { key: "folder/file-b.ts", size: 200, isPrefix: false },
  { key: "folder/sub/", size: 0, isPrefix: true },
];

function makeState(viewMode: ViewState["viewMode"]): ViewState {
  return { location: LOCATION, viewMode, selection: new Set(SELECTION) };
}

// ---------------------------------------------------------------------------
// 6 pairwise transitions — Details / IconGrid / Gallery
// ---------------------------------------------------------------------------

describe("switching — Details ↔ IconGrid ↔ Gallery transitions", () => {
  const transitions: Array<[ViewState["viewMode"], ViewState["viewMode"]]> = [
    ["Details", "IconGrid"],
    ["Details", "Gallery"],
    ["IconGrid", "Details"],
    ["IconGrid", "Gallery"],
    ["Gallery", "Details"],
    ["Gallery", "IconGrid"],
  ];

  for (const [from, to] of transitions) {
    it(`${from} → ${to}: preserves location`, () => {
      const result = applySwitch(makeState(from), to, ITEMS);
      expect(result.location).toEqual(LOCATION);
    });

    it(`${from} → ${to}: preserves selection`, () => {
      const result = applySwitch(makeState(from), to, ITEMS);
      expect(result.selection).toEqual(SELECTION);
    });

    it(`${from} → ${to}: sets viewMode to ${to}`, () => {
      const result = applySwitch(makeState(from), to, ITEMS);
      expect(result.viewMode).toBe(to);
    });
  }
});

// ---------------------------------------------------------------------------
// Selection is a new Set (immutability)
// ---------------------------------------------------------------------------

describe("switching — immutability", () => {
  it("returns a new Set for selection (does not alias prev.selection)", () => {
    const prev = makeState("Details");
    const result = applySwitch(prev, "IconGrid", ITEMS);
    expect(result.selection).not.toBe(prev.selection);
  });

  it("does not mutate prev.selection", () => {
    const prev = makeState("Details");
    const sizeBefore = prev.selection.size;
    applySwitch(prev, "IconGrid", ITEMS);
    expect(prev.selection.size).toBe(sizeBefore);
  });
});

// ---------------------------------------------------------------------------
// Null location is preserved
// ---------------------------------------------------------------------------

describe("switching — null location", () => {
  it("preserves null location across transitions", () => {
    const prev: ViewState = {
      location: null,
      viewMode: "Details",
      selection: new Set(),
    };
    const result = applySwitch(prev, "Gallery", ITEMS);
    expect(result.location).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 30 — FlatKey transitions
// ---------------------------------------------------------------------------

describe("switching — FlatKey transitions (task 30)", () => {
  it("Details → FlatKey: preserves location", () => {
    const result = applySwitch(makeState("Details"), "FlatKey", ITEMS);
    expect(result.location).toEqual(LOCATION);
  });

  it("Details → FlatKey: sets viewMode to FlatKey", () => {
    const result = applySwitch(makeState("Details"), "FlatKey", ITEMS);
    expect(result.viewMode).toBe("FlatKey");
  });

  it("Details → FlatKey: preserves object (non-prefix) selections", () => {
    // SELECTION contains "folder/file-a.ts" and "folder/file-b.ts" — both non-prefix.
    const result = applySwitch(makeState("Details"), "FlatKey", ITEMS);
    expect(result.selection).toContain("folder/file-a.ts");
    expect(result.selection).toContain("folder/file-b.ts");
  });

  it("Tree → FlatKey: collapses virtual-folder selections", () => {
    // Start with "folder/sub/" (isPrefix=true) in the selection.
    const prev: ViewState = {
      location: LOCATION,
      viewMode: "Tree",
      selection: new Set(["folder/file-a.ts", "folder/sub/"]),
    };
    const result = applySwitch(prev, "FlatKey", ITEMS);
    // Object key preserved.
    expect(result.selection).toContain("folder/file-a.ts");
    // Prefix key dropped.
    expect(result.selection).not.toContain("folder/sub/");
  });

  it("Column → FlatKey: collapses virtual-folder selections", () => {
    const prev: ViewState = {
      location: LOCATION,
      viewMode: "Column",
      selection: new Set(["folder/sub/"]),
    };
    const result = applySwitch(prev, "FlatKey", ITEMS);
    // "folder/sub/" is a prefix — should be collapsed.
    expect(result.selection).not.toContain("folder/sub/");
    expect(result.selection.size).toBe(0);
  });

  it("FlatKey → FlatKey: no-op on already-object-only selections", () => {
    const prev: ViewState = {
      location: LOCATION,
      viewMode: "FlatKey",
      selection: new Set(["folder/file-a.ts"]),
    };
    const result = applySwitch(prev, "FlatKey", ITEMS);
    expect(result.selection).toContain("folder/file-a.ts");
    expect(result.selection.size).toBe(1);
  });

  it("FlatKey → Details: preserves location and selection", () => {
    const prev: ViewState = {
      location: LOCATION,
      viewMode: "FlatKey",
      selection: new Set(["folder/file-a.ts"]),
    };
    const result = applySwitch(prev, "Details", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.selection).toContain("folder/file-a.ts");
    expect(result.viewMode).toBe("Details");
  });
});

// ---------------------------------------------------------------------------
// Task 30 — DualPane transitions
// ---------------------------------------------------------------------------

describe("switching — DualPane transitions (task 30)", () => {
  it("Details → DualPane: preserves location", () => {
    const result = applySwitch(makeState("Details"), "DualPane", ITEMS);
    expect(result.location).toEqual(LOCATION);
  });

  it("Details → DualPane: sets viewMode to DualPane", () => {
    const result = applySwitch(makeState("Details"), "DualPane", ITEMS);
    expect(result.viewMode).toBe("DualPane");
  });

  it("Details → DualPane: entry copies current pane location to both panes", () => {
    const result = applySwitch(makeState("Details"), "DualPane", ITEMS);
    expect(result.panes).toBeDefined();
    expect(result.panes?.length).toBe(2);
    // Both panes start with the same location.
    expect(result.panes?.[0]?.location).toEqual(LOCATION);
    expect(result.panes?.[1]?.location).toEqual(LOCATION);
  });

  it("DualPane → Details: active pane location is preserved (exit)", () => {
    // Simulate exit from DualPane back to Details.
    const prev: ViewState = {
      location: LOCATION,
      viewMode: "DualPane",
      selection: new Set(["folder/file-a.ts"]),
    };
    const result = applySwitch(prev, "Details", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.viewMode).toBe("Details");
    // Selection preserved.
    expect(result.selection).toContain("folder/file-a.ts");
  });

  it("DualPane → Details: no panes field on exit", () => {
    const prev: ViewState = {
      location: LOCATION,
      viewMode: "DualPane",
      selection: new Set(),
    };
    const result = applySwitch(prev, "Details", ITEMS);
    // The panes array is not present when not entering DualPane.
    expect(result.panes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// All 7 modes round-trip — location preserved
// ---------------------------------------------------------------------------

describe("switching — all 7 modes round-trip preserves location", () => {
  const ALL_MODES = [
    "Details",
    "IconGrid",
    "Gallery",
    "Tree",
    "Column",
    "FlatKey",
    "DualPane",
  ] as const;

  for (const mode of ALL_MODES) {
    it(`Details → ${mode} → Details: location preserved throughout`, () => {
      const first = applySwitch(makeState("Details"), mode, ITEMS);
      expect(first.location).toEqual(LOCATION);

      const second = applySwitch(first, "Details", ITEMS);
      expect(second.location).toEqual(LOCATION);
    });
  }
});

// ---------------------------------------------------------------------------
// Task 29 — Tree transitions
// ---------------------------------------------------------------------------

describe("switching — Tree transitions (task 29)", () => {
  it("Details → Tree: preserves location", () => {
    const result = applySwitch(makeState("Details"), "Tree", ITEMS);
    expect(result.location).toEqual(LOCATION);
  });

  it("Details → Tree: preserves selection", () => {
    const result = applySwitch(makeState("Details"), "Tree", ITEMS);
    expect(result.selection).toEqual(SELECTION);
  });

  it("Details → Tree: sets viewMode to Tree", () => {
    const result = applySwitch(makeState("Details"), "Tree", ITEMS);
    expect(result.viewMode).toBe("Tree");
  });

  it("Details → Tree: seeds treeExpanded with prefix chain from location", () => {
    const result = applySwitch(makeState("Details"), "Tree", ITEMS);
    // LOCATION.prefix = "folder/" → should expand ["folder/"]
    expect(result.treeExpanded).toContain("folder/");
  });

  it("Details → Tree: merges prior treeExpanded with seed", () => {
    const prev: ViewState = {
      ...makeState("Details"),
      treeExpanded: new Set(["other/"]),
    };
    const result = applySwitch(prev, "Tree", ITEMS);
    expect(result.treeExpanded).toContain("other/");
    expect(result.treeExpanded).toContain("folder/");
  });

  it("IconGrid → Tree: preserves location and selection", () => {
    const result = applySwitch(makeState("IconGrid"), "Tree", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.selection).toEqual(SELECTION);
  });

  it("Gallery → Tree: preserves location and selection", () => {
    const result = applySwitch(makeState("Gallery"), "Tree", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.selection).toEqual(SELECTION);
  });

  it("Tree → Tree: preserves existing treeExpanded set", () => {
    const prev: ViewState = {
      ...makeState("Tree"),
      treeExpanded: new Set(["folder/", "folder/sub/"]),
    };
    const result = applySwitch(prev, "Tree", ITEMS);
    expect(result.treeExpanded).toContain("folder/");
    expect(result.treeExpanded).toContain("folder/sub/");
  });

  it("Tree → Details: preserves location and selection (no treeExpanded loss)", () => {
    const prev: ViewState = {
      ...makeState("Tree"),
      treeExpanded: new Set(["folder/"]),
    };
    const result = applySwitch(prev, "Details", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.selection).toEqual(SELECTION);
    // treeExpanded carries through so Tree→Details→Tree restores it.
    expect(result.treeExpanded).toContain("folder/");
  });
});

// ---------------------------------------------------------------------------
// Task 29 — Column transitions (includes the verbatim derived test)
// ---------------------------------------------------------------------------

describe("switching — Column transitions (task 29)", () => {
  it("Details → Column: preserves location", () => {
    const result = applySwitch(makeState("Details"), "Column", ITEMS);
    expect(result.location).toEqual(LOCATION);
  });

  it("Details → Column: sets viewMode to Column", () => {
    const result = applySwitch(makeState("Details"), "Column", ITEMS);
    expect(result.viewMode).toBe("Column");
  });

  /**
   * Verbatim test name per design.md §View Modes And Selection (round-3
   * residual #2 derived test case).
   *
   * Rule: *→Column preserves location but resets the selection that was
   * "deeper" than the current location prefix — i.e., any column to the
   * right of the column corresponding to `location.prefix` is dropped.
   */
  it("xToColumnPreservesLocationButResetsDeeperSelection", () => {
    // Build a state where the user was in Column view with a deep path:
    //   column 0 shows prefix ""       → selected "folder/"
    //   column 1 shows prefix "folder/" → selected "folder/sub/"
    //   column 2 shows prefix "folder/sub/" → selected "folder/sub/file.ts"
    //
    // The current location.prefix is "folder/" (LOCATION).
    // Switching *→Column should:
    //   - Preserve location (still "folder/").
    //   - Reset selection (empty set — deeper selections dropped).
    //   - Truncate columnPath to entries that are strict ancestors of
    //     location.prefix, i.e. only entries whose key is a proper prefix
    //     of "folder/" and is not "folder/" itself → [] (nothing qualifies).
    const deepSelection = new Set(["folder/sub/file.ts"]);
    const folderEntry: ObjectEntry = {
      key: "folder/",
      size: 0,
      isPrefix: true,
    };
    const subEntry: ObjectEntry = {
      key: "folder/sub/",
      size: 0,
      isPrefix: true,
    };
    const prev: ViewState = {
      location: LOCATION, // prefix = "folder/"
      viewMode: "Details",
      selection: deepSelection,
      columnPath: [folderEntry, subEntry],
    };

    const result = applySwitch(prev, "Column", ITEMS);

    // Location preserved.
    expect(result.location).toEqual(LOCATION);

    // Deeper-column selection is reset.
    expect(result.selection.size).toBe(0);

    // columnPath is truncated to only ancestors of "folder/" —
    // "folder/" itself is not an ancestor (equal, not strict prefix),
    // "folder/sub/" is a descendant, so nothing qualifies → empty path.
    expect(result.columnPath).toEqual([]);
  });

  it("Tree → Column: preserves location, resets selection", () => {
    const prev: ViewState = {
      ...makeState("Tree"),
      treeExpanded: new Set(["folder/"]),
    };
    const result = applySwitch(prev, "Column", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.selection.size).toBe(0);
  });

  it("Column → Column (parent-column change): deeper columns reset", () => {
    // Simulates the case where the user clicks in column 0 (root), which
    // triggers an applySwitch to "Column" from "Column". The columnPath
    // should be truncated to ancestors only.
    const rootEntry: ObjectEntry = { key: "other/", size: 0, isPrefix: true };
    const deepEntry: ObjectEntry = {
      key: "other/sub/",
      size: 0,
      isPrefix: true,
    };
    const prev: ViewState = {
      location: LOCATION, // still at "folder/"
      viewMode: "Column",
      selection: new Set(["other/sub/file.ts"]),
      columnPath: [rootEntry, deepEntry],
    };

    const result = applySwitch(prev, "Column", ITEMS);

    // Deeper column selections are reset.
    expect(result.selection.size).toBe(0);
    expect(result.viewMode).toBe("Column");
  });

  it("Gallery → Column: preserves location, selection resets", () => {
    const result = applySwitch(makeState("Gallery"), "Column", ITEMS);
    expect(result.location).toEqual(LOCATION);
    expect(result.selection.size).toBe(0);
  });
});
