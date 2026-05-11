/**
 * Tests for per-pane navigation history.
 *
 * Coverage:
 * 1. Initial state — back/forward both empty.
 * 2. setLocation pushes onto back stack.
 * 3. back() returns to previous location and pushes current onto forward.
 * 4. forward() restores future location.
 * 5. Fresh navigation invalidates the forward stack.
 * 6. back/forward return false when stacks are empty.
 * 7. inFlight guard: back/forward do not re-record their own location change.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetHistoriesForTest,
  back,
  canBack,
  canForward,
  forward,
  installHistoryTracker,
} from "../history";
import { usePanesStore } from "../panes";

let stop: (() => void) | null = null;

function resetPaneStore() {
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: null,
        viewMode: "Details",
        selection: new Set(),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      },
    ],
    activePaneId: "main",
  });
}

beforeEach(() => {
  resetPaneStore();
  _resetHistoriesForTest();
  stop = installHistoryTracker();
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("history — initial state", () => {
  it("back/forward are both unavailable initially", () => {
    expect(canBack("main")).toBe(false);
    expect(canForward("main")).toBe(false);
  });

  it("back returns false when stack is empty", () => {
    expect(back("main")).toBe(false);
  });

  it("forward returns false when stack is empty", () => {
    expect(forward("main")).toBe(false);
  });
});

describe("history — recording navigations", () => {
  it("first setLocation does not push anything (no prior location)", () => {
    usePanesStore.getState().setLocation("main", {
      profileId: "p1",
      bucket: "b1",
      prefix: "x/",
    });
    expect(canBack("main")).toBe(false);
  });

  it("second setLocation makes back available", () => {
    usePanesStore.getState().setLocation("main", {
      profileId: "p1",
      bucket: "b1",
      prefix: "x/",
    });
    usePanesStore.getState().setLocation("main", {
      profileId: "p1",
      bucket: "b1",
      prefix: "x/sub/",
    });
    expect(canBack("main")).toBe(true);
  });
});

describe("history — back / forward", () => {
  it("back restores the previous location", () => {
    const a = { profileId: "p1", bucket: "b1", prefix: "a/" };
    const b = { profileId: "p1", bucket: "b1", prefix: "b/" };
    usePanesStore.getState().setLocation("main", a);
    usePanesStore.getState().setLocation("main", b);

    expect(back("main")).toBe(true);

    const pane = usePanesStore.getState().panes[0];
    expect(pane?.location).toEqual(a);
    expect(canForward("main")).toBe(true);
  });

  it("forward restores the popped location", () => {
    const a = { profileId: "p1", bucket: "b1", prefix: "a/" };
    const b = { profileId: "p1", bucket: "b1", prefix: "b/" };
    usePanesStore.getState().setLocation("main", a);
    usePanesStore.getState().setLocation("main", b);
    back("main");

    expect(forward("main")).toBe(true);

    const pane = usePanesStore.getState().panes[0];
    expect(pane?.location).toEqual(b);
    expect(canForward("main")).toBe(false);
  });

  it("a fresh navigation invalidates the forward stack", () => {
    const a = { profileId: "p1", bucket: "b1", prefix: "a/" };
    const b = { profileId: "p1", bucket: "b1", prefix: "b/" };
    const c = { profileId: "p1", bucket: "b1", prefix: "c/" };
    usePanesStore.getState().setLocation("main", a);
    usePanesStore.getState().setLocation("main", b);
    back("main");
    expect(canForward("main")).toBe(true);

    usePanesStore.getState().setLocation("main", c);
    expect(canForward("main")).toBe(false);
  });
});

describe("history — inFlight guard", () => {
  it("back() does not re-record its own location change", () => {
    const a = { profileId: "p1", bucket: "b1", prefix: "a/" };
    const b = { profileId: "p1", bucket: "b1", prefix: "b/" };
    usePanesStore.getState().setLocation("main", a);
    usePanesStore.getState().setLocation("main", b);
    back("main");
    // After one back, the back stack must be empty (no double-recording).
    expect(canBack("main")).toBe(false);
  });
});
