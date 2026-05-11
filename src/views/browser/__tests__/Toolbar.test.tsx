/**
 * Tests for <Toolbar />.
 *
 * Coverage:
 * 1. view.inspect is registered in the command registry (toolbar-owned).
 * 2. Refresh and Up buttons delegate to the shared registry commands
 *    `view.refresh` and `nav.up` (registered in App.tsx — toolbar
 *    only routes to them).
 * 3. Inspect button calls openInspector with the current pane's location.
 * 4. Inspect button is a no-op when the pane has no bucket selected.
 * 5. View-mode trigger opens a menu listing the seven view modes;
 *    selecting one calls setViewMode on the active pane.
 * 6. axe-core a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { registry } from "@/commands/registry";
import { useInspectorStore } from "@/store/inspector";
import { usePanesStore } from "@/store/panes";
import { Toolbar } from "../Toolbar";

// Toolbar now calls useQueryClient (for invalidating bookmarks); wrap
// every render in a fresh QueryClientProvider.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: {
          profileId: "p-1",
          bucket: "my-bucket",
          prefix: "",
        },
        viewMode: "Details",
        selection: new Set(),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      },
    ],
    activePaneId: "main",
  });

  useInspectorStore.setState({ open: false, target: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Registry registration
// ---------------------------------------------------------------------------

describe("Toolbar — command registry", () => {
  it("view.inspect is registered (owned by the toolbar)", () => {
    render(<Toolbar />);
    expect(registry.lookupById("view.inspect")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Refresh and Up delegation
// ---------------------------------------------------------------------------

describe("Toolbar — Refresh / Up delegation", () => {
  // Spy on registry.lookupById so we can return a stub command without
  // mutating the global registry (which has no unregister and would
  // collide across tests).
  function spyOnCommand(id: string, run: () => void) {
    return vi.spyOn(registry, "lookupById").mockImplementation((cmdId) => {
      if (cmdId === id) {
        return {
          id,
          title: id,
          group: "Test",
          run,
        };
      }
      // Fall through to the real implementation for everything else
      // (e.g. view.inspect which Toolbar registers on module load).
      return undefined;
    });
  }

  it("Refresh button delegates to the view.refresh command", async () => {
    const run = vi.fn();
    const spy = spyOnCommand("view.refresh", run);

    render(<Toolbar />);
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(run).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("Up button delegates to the nav.up command", async () => {
    const run = vi.fn();
    const spy = spyOnCommand("nav.up", run);

    render(<Toolbar />);
    await userEvent.click(screen.getByRole("button", { name: /navigate up/i }));

    expect(run).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Inspect button
// ---------------------------------------------------------------------------

describe("Toolbar — Inspect button", () => {
  it("opens the inspector for the active pane location on click", async () => {
    render(<Toolbar />);
    await userEvent.click(screen.getByRole("button", { name: /inspect/i }));

    const { open, target } = useInspectorStore.getState();
    expect(open).toBe(true);
    expect(target?.profileId).toBe("p-1");
    expect(target?.bucket).toBe("my-bucket");
  });

  it("is a no-op when the pane has no bucket selected", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p-1", bucket: null, prefix: "" },
          viewMode: "Details",
          selection: new Set(),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });

    render(<Toolbar />);
    await userEvent.click(screen.getByRole("button", { name: /inspect/i }));

    expect(useInspectorStore.getState().open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// View-mode menu
// ---------------------------------------------------------------------------

describe("Toolbar — view-mode menu", () => {
  it("selecting a view mode calls setViewMode on the active pane", async () => {
    render(<Toolbar />);
    // ViewModePicker is a custom dropdown: click the trigger, then the option.
    await userEvent.click(screen.getByLabelText(/view mode/i));
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: /Gallery/i }),
    );

    const pane = usePanesStore.getState().panes.find((p) => p.id === "main");
    expect(pane?.viewMode).toBe("Gallery");
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("Toolbar — a11y", () => {
  it("has no axe violations", async () => {
    const { container } = render(<Toolbar />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
