/**
 * Component tests for <CommandPalette />.
 *
 * Uses @testing-library/react + @testing-library/user-event.
 * A local registry + store is injected via vi.mock so these tests are
 * fully isolated from the app-level singleton.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Build a shared test store that is injected via vi.mock.
// We CANNOT use top-level vi.fn() inside the factory directly when the
// factory references imported module-level symbols — vitest hoists vi.mock
// but the imports are not yet bound at hoist time.
//
// Solution: define the mock setup in a top-level variable that is populated
// lazily (the factory references `getTestStore()` which is defined with
// `let` at module scope and assigned before any test runs via a side-effect
// that happens during the mock factory's execution — made safe by using
// vi.importActual inside the factory).
// ---------------------------------------------------------------------------

// We use a factory-safe approach: the mock factory calls vi.importActual,
// which is allowed, and then creates the store there.
// The created store is stored in a module-level ref so tests can reach it.

let _testStore: ReturnType<
  typeof import("@/store/command_palette").createCommandPaletteStore
> | null = null;

vi.mock("@/store/command_palette", async () => {
  const mod = await vi.importActual<typeof import("@/store/command_palette")>(
    "@/store/command_palette",
  );
  const regMod = await vi.importActual<typeof import("@/commands/registry")>(
    "@/commands/registry",
  );

  const reg = regMod.createRegistry();
  reg.register({
    id: "app.about",
    title: "About brows3r",
    group: "Application",
    run: vi.fn(),
  });
  reg.register({
    id: "file.open",
    title: "Open File",
    group: "File",
    run: vi.fn(),
  });
  reg.register({
    id: "view.refresh",
    title: "Refresh View",
    group: "View",
    run: vi.fn(),
  });

  const store = mod.createCommandPaletteStore(reg);
  // Store reference so tests can access it.
  _testStore = store;

  return {
    ...mod,
    useCommandPaletteStore: store,
  };
});

// After the mock is established, import the component and the store reference.
const { useCommandPaletteStore } = await import("@/store/command_palette");
const { CommandPalette } = await import("../CommandPalette");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStore() {
  if (_testStore === null) throw new Error("test store not initialized");
  return _testStore;
}

function renderPalette() {
  return render(<CommandPalette />);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  const store = getStore();
  store.setState({ open: false, query: "", focusedIndex: 0 });
  store.getState().setQuery(""); // re-derive results
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommandPalette", () => {
  it("is not visible when closed", () => {
    renderPalette();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows search input when opened", async () => {
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    const input = await screen.findByRole("combobox");
    expect(input).toBeInTheDocument();
  });

  it("autofocuses the search input on open", async () => {
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("renders all 3 registry commands when query is empty", async () => {
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    await screen.findByRole("combobox");

    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("About brows3r")).toBeInTheDocument();
    expect(screen.getByText("Open File")).toBeInTheDocument();
    expect(screen.getByText("Refresh View")).toBeInTheDocument();
  });

  it("filters results as the user types", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    const input = await screen.findByRole("combobox");
    await user.type(input, "open");

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("Open File")).toBeInTheDocument();
  });

  it("shows empty state when no commands match", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    const input = await screen.findByRole("combobox");
    await user.type(input, "zzznomatch");

    // The empty-state listbox item carries role="option"; query by role to
    // distinguish it from the aria-live status region (which also says
    // "No commands match").
    expect(
      screen.getByRole("option", { name: /No commands match/i }),
    ).toBeInTheDocument();
  });

  it("ArrowDown moves focus to the next result", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    await screen.findByRole("combobox");
    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(useCommandPaletteStore.getState().focusedIndex).toBe(1);
    });
  });

  it("ArrowUp from first result wraps to last result", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();
    // Ensure we start at index 0.
    useCommandPaletteStore.setState({ focusedIndex: 0 });

    await screen.findByRole("combobox");
    await user.keyboard("{ArrowUp}");

    await waitFor(() => {
      // 3 commands registered → last index is 2.
      expect(useCommandPaletteStore.getState().focusedIndex).toBe(2);
    });
  });

  it("Enter executes the focused command and closes the palette", async () => {
    const user = userEvent.setup();
    const runFn = vi.fn();

    const store = getStore();
    store.getState().openPalette();

    const { results } = store.getState();
    const firstCmd = results[0];
    if (firstCmd === undefined) throw new Error("Need at least one command");

    const origRun = firstCmd.run;
    firstCmd.run = runFn;

    renderPalette();

    await screen.findByRole("combobox");
    await user.keyboard("{Enter}");

    expect(runFn).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(store.getState().open).toBe(false);
    });

    firstCmd.run = origRun;
  });

  it("Escape closes the palette", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    await screen.findByRole("combobox");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Live region announcement
  // -------------------------------------------------------------------------

  it("renders the aria-live status region when palette is open", async () => {
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    await screen.findByRole("combobox");

    // role="status" is the live region; there should be exactly one.
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toBeInTheDocument();
  });

  it("live region announces '3 commands match' when 3 results are shown", async () => {
    renderPalette();
    useCommandPaletteStore.getState().openPalette();
    await screen.findByRole("combobox");

    // Empty query → all 3 commands match.
    const statusRegion = screen.getByRole("status");
    await waitFor(() => {
      expect(statusRegion).toHaveTextContent("3 commands match");
    });
  });

  it("live region announces '1 command matches' when filtered to one result", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    const input = await screen.findByRole("combobox");
    await user.type(input, "open");

    const statusRegion = screen.getByRole("status");
    await waitFor(() => {
      expect(statusRegion).toHaveTextContent("1 command matches");
    });
  });

  it("live region announces 'No commands match' when no results", async () => {
    const user = userEvent.setup();
    renderPalette();
    useCommandPaletteStore.getState().openPalette();

    const input = await screen.findByRole("combobox");
    await user.type(input, "zzznomatch");

    const statusRegion = screen.getByRole("status");
    await waitFor(() => {
      expect(statusRegion).toHaveTextContent("No commands match");
    });
  });
});
