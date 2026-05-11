/**
 * Tests for the transfers Zustand store.
 *
 * Coverage:
 * 1. upsert / remove / selectors
 * 2. clearCompleted
 * 3. MB/s and ETA computation helpers
 * 4. applyProgressEvent / applyStateEvent bridge helpers
 */

import { describe, expect, it } from "vitest";
import type { Transfer } from "@/api/transfers";
import {
  applyProgressEvent,
  applyStateEvent,
  computeBytesPerSec,
  computeEtaSec,
  createTransfersStore,
  useTransfersStore,
} from "./transfers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "t-1",
    kind: "download",
    profileId: "p-1",
    bucket: "my-bucket",
    key: "path/to/file.txt",
    transferredBytes: 0,
    partsDone: 0,
    partsTotal: 1,
    state: "queued",
    startedAt: Date.now() - 10_000, // 10s ago so rate is meaningful
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Store — upsert / remove / selectors
// ---------------------------------------------------------------------------

describe("transfers store — upsert / remove", () => {
  it("upsert adds a new transfer", () => {
    const store = createTransfersStore();
    const t = makeTransfer();
    store.getState().upsert(t);
    expect(store.getState().transfers.size).toBe(1);
    expect(store.getState().transfers.get("t-1")).toEqual(t);
  });

  it("upsert merges with the existing record", () => {
    const store = createTransfersStore();
    const t = makeTransfer({ state: "queued" });
    store.getState().upsert(t);
    store.getState().upsert({ ...t, state: "running" });
    expect(store.getState().transfers.get("t-1")?.state).toBe("running");
    expect(store.getState().transfers.size).toBe(1);
  });

  it("remove deletes the transfer", () => {
    const store = createTransfersStore();
    store.getState().upsert(makeTransfer({ id: "t-1" }));
    store.getState().upsert(makeTransfer({ id: "t-2" }));
    store.getState().remove("t-1");
    expect(store.getState().transfers.size).toBe(1);
    expect(store.getState().transfers.has("t-1")).toBe(false);
  });

  it("remove is a no-op for unknown id", () => {
    const store = createTransfersStore();
    store.getState().upsert(makeTransfer());
    store.getState().remove("unknown");
    expect(store.getState().transfers.size).toBe(1);
  });
});

describe("transfers store — clearCompleted", () => {
  it("removes done / failed / canceled transfers", () => {
    const store = createTransfersStore();
    store.getState().upsert(makeTransfer({ id: "a", state: "running" }));
    store.getState().upsert(makeTransfer({ id: "b", state: "done" }));
    store.getState().upsert(makeTransfer({ id: "c", state: "failed" }));
    store.getState().upsert(makeTransfer({ id: "d", state: "canceled" }));
    store.getState().clearCompleted();
    expect(store.getState().transfers.size).toBe(1);
    expect(store.getState().transfers.has("a")).toBe(true);
  });
});

describe("transfers store — selectors", () => {
  it("active() returns queued and running transfers", () => {
    const store = createTransfersStore();
    store.getState().upsert(makeTransfer({ id: "q", state: "queued" }));
    store.getState().upsert(makeTransfer({ id: "r", state: "running" }));
    store.getState().upsert(makeTransfer({ id: "d", state: "done" }));
    const a = store.getState().active();
    expect(a).toHaveLength(2);
    expect(a.map((t) => t.id).sort()).toEqual(["q", "r"]);
  });

  it("completed() returns done / failed / canceled transfers", () => {
    const store = createTransfersStore();
    store.getState().upsert(makeTransfer({ id: "r", state: "running" }));
    store.getState().upsert(makeTransfer({ id: "d", state: "done" }));
    store.getState().upsert(makeTransfer({ id: "f", state: "failed" }));
    store.getState().upsert(makeTransfer({ id: "c", state: "canceled" }));
    const c = store.getState().completed();
    expect(c).toHaveLength(3);
  });

  it("byProfile() filters by profileId", () => {
    const store = createTransfersStore();
    store.getState().upsert(makeTransfer({ id: "a", profileId: "p-1" }));
    store.getState().upsert(makeTransfer({ id: "b", profileId: "p-2" }));
    store.getState().upsert(makeTransfer({ id: "c", profileId: "p-1" }));
    expect(store.getState().byProfile("p-1")).toHaveLength(2);
    expect(store.getState().byProfile("p-2")).toHaveLength(1);
    expect(store.getState().byProfile("p-3")).toHaveLength(0);
  });
});

describe("transfers store — panel state", () => {
  it("togglePanel flips panelOpen", () => {
    const store = createTransfersStore();
    expect(store.getState().panelOpen).toBe(false);
    store.getState().togglePanel();
    expect(store.getState().panelOpen).toBe(true);
    store.getState().togglePanel();
    expect(store.getState().panelOpen).toBe(false);
  });

  it("setMinimized sets panelMinimized", () => {
    const store = createTransfersStore();
    store.getState().setMinimized(true);
    expect(store.getState().panelMinimized).toBe(true);
    store.getState().setMinimized(false);
    expect(store.getState().panelMinimized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MB/s + ETA computation
// ---------------------------------------------------------------------------

describe("computeBytesPerSec", () => {
  it("returns 0 when no bytes have been transferred", () => {
    const t = makeTransfer({ transferredBytes: 0 });
    expect(computeBytesPerSec(t)).toBe(0);
  });

  it("computes a positive rate for in-progress transfers", () => {
    const t = makeTransfer({
      transferredBytes: 5 * 1024 * 1024, // 5 MB
      startedAt: Date.now() - 10_000, // 10 seconds ago
    });
    const rate = computeBytesPerSec(t);
    // Should be around 5 MB / 10 s = 512 KB/s; floats, so just check > 0.
    expect(rate).toBeGreaterThan(0);
  });
});

describe("computeEtaSec", () => {
  it("returns null when totalBytes is unknown", () => {
    const t = makeTransfer({ transferredBytes: 100 });
    expect(computeEtaSec(t)).toBeNull();
  });

  it("returns 0 when transfer is complete", () => {
    const t = makeTransfer({
      transferredBytes: 1024,
      totalBytes: 1024,
    });
    expect(computeEtaSec(t)).toBe(0);
  });

  it("returns a positive number for in-progress transfers", () => {
    const t = makeTransfer({
      transferredBytes: 1 * 1024 * 1024,
      totalBytes: 10 * 1024 * 1024,
      startedAt: Date.now() - 10_000,
    });
    const eta = computeEtaSec(t);
    expect(eta).not.toBeNull();
    expect(eta as number).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Event bridge helpers — applyProgressEvent / applyStateEvent
// ---------------------------------------------------------------------------

describe("applyProgressEvent", () => {
  it("merges progress fields into an existing transfer", () => {
    const existing = makeTransfer({
      id: "req-1",
      state: "running",
      transferredBytes: 0,
    });
    useTransfersStore.setState({ transfers: new Map([["req-1", existing]]) });

    applyProgressEvent({
      requestId: "req-1",
      bytesDone: 500,
      bytesTotal: 1000,
      partsDone: 1,
      partsTotal: 2,
    });

    const updated = useTransfersStore.getState().transfers.get("req-1");
    expect(updated?.transferredBytes).toBe(500);
    expect(updated?.totalBytes).toBe(1000);
    expect(updated?.partsDone).toBe(1);
  });

  it("creates a placeholder when no record exists yet", () => {
    useTransfersStore.setState({ transfers: new Map() });

    applyProgressEvent({
      requestId: "req-new",
      bytesDone: 100,
      partsDone: 0,
      partsTotal: 1,
    });

    expect(useTransfersStore.getState().transfers.has("req-new")).toBe(true);
  });
});

describe("applyStateEvent", () => {
  it("updates state on an existing transfer", () => {
    const existing = makeTransfer({ id: "req-2", state: "running" });
    useTransfersStore.setState({
      transfers: new Map([["req-2", existing]]),
    });

    applyStateEvent({ requestId: "req-2", state: "done" });

    expect(useTransfersStore.getState().transfers.get("req-2")?.state).toBe(
      "done",
    );
  });

  it("sets finishedAt when state becomes terminal", () => {
    const before = Date.now();
    const existing = makeTransfer({ id: "req-3", state: "running" });
    useTransfersStore.setState({
      transfers: new Map([["req-3", existing]]),
    });

    applyStateEvent({ requestId: "req-3", state: "failed" });

    const t = useTransfersStore.getState().transfers.get("req-3");
    expect(t?.finishedAt).toBeGreaterThanOrEqual(before);
  });

  it("is a no-op when the transfer does not exist", () => {
    useTransfersStore.setState({ transfers: new Map() });
    // Should not throw.
    expect(() =>
      applyStateEvent({ requestId: "ghost", state: "done" }),
    ).not.toThrow();
  });
});
