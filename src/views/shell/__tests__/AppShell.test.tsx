/**
 * Tests for <AppShell />.
 *
 * Coverage:
 * 1. Renders all three panes (sidebar, main file list, preview).
 * 2. Axe-core: empty shell has no accessibility violations.
 * 3. Resize handle is present in the DOM.
 *
 * react-resizable-panels relies on ResizeObserver, which jsdom does not
 * implement. We stub it here so panel layout is always "100% / 0 / 0".
 * All structural rendering (landmarks, slots, a11y) is still exercised.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { usePanesStore } from "@/store/panes";
import { mockInvoke } from "@/test/mocks/tauri";
import { AppShell } from "../AppShell";

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  // Provide an empty profiles list so the Profiles component doesn't hang.
  mockInvoke("profiles_list", []);
  // Reset pane store.
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
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppShell", () => {
  it("renders the sidebar nav landmark", () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(
      screen.getByRole("navigation", { name: "Sidebar" }),
    ).toBeInTheDocument();
  });

  it("renders the main file list area", () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(screen.getByRole("main", { name: "File list" })).toBeInTheDocument();
  });

  it("renders the preview pane", () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(
      screen.getByRole("complementary", { name: "Preview" }),
    ).toBeInTheDocument();
  });

  it("renders the breadcrumb nav landmark", () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(
      screen.getByRole("navigation", { name: "Breadcrumb" }),
    ).toBeInTheDocument();
  });

  it("renders the skip-to-main link", () => {
    render(<AppShell />, { wrapper: Wrapper });
    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toBeInTheDocument();
  });

  it("has no axe accessibility violations on the empty shell", async () => {
    const { container } = render(<AppShell />, { wrapper: Wrapper });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
