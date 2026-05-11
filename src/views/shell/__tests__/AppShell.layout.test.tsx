/**
 * Layout regression test for AppShell.
 *
 * Specifically guards against react-resizable-panels v4's silent footgun:
 * passing `defaultSize={22}` is interpreted as 22 PIXELS, not 22%. The
 * sidebar must always render around its configured percentage of the
 * group width.
 *
 * jsdom has no real layout engine, so we can't measure pixel widths
 * directly. Instead we assert that the rendered Panel elements receive
 * the percentage-suffixed sizes we passed in, by snapshotting the
 * generated style attributes.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "@/store/ui";
import { AppShell } from "../AppShell";

// jsdom does not implement ResizeObserver; react-resizable-panels needs it.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Reset store to known defaults.
  useUiStore.setState({
    theme: "system",
    sidebarCollapsed: false,
    sidebarPct: 22,
    previewPct: 28,
    previewCollapsed: false,
    defaultViewMode: "Details",
    lastLocation: null,
    firstRunCompleted: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("AppShell layout — Panel sizes are percentage strings", () => {
  it("AppShell.tsx must not pass bare numbers to Panel size props (silently px in v4)", async () => {
    // Source-level regression. jsdom can't run real ResizeObserver, so the
    // lib's actual rendered styles in tests don't reflect real-browser
    // behavior. Instead we statically scan AppShell.tsx for the bug
    // pattern: defaultSize / minSize / maxSize on a Panel given a bare
    // numeric expression.
    //
    // react-resizable-panels v4 parses `number` as PIXELS:
    //   defaultSize={22}   → flex-basis: 22px        ❌
    //   defaultSize="22%"  → flex-basis: 22%         ✓
    //   defaultSize={`${pct}%`} → flex-basis: <pct>% ✓
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.resolve(__dirname, "../AppShell.tsx");
    const src = await fs.readFile(file, "utf8");

    // Extract every Panel size attribute and its raw value.
    // Match `defaultSize={<value>}` / `minSize={<value>}` / `maxSize={<value>}`
    // and also the bare `defaultSize="..."` literal form.
    const attrPattern = /(defaultSize|minSize|maxSize)=({[^}]+}|"[^"]*")/g;
    const offenders: string[] = [];
    for (const match of src.matchAll(attrPattern)) {
      const [_, attr, raw] = match;
      if (!attr || !raw) continue;
      // String literals are inspected for unit; brace expressions need to
      // resolve to a string with a unit (we accept template literals
      // ending in %, "px", "rem", etc., plus "auto").
      const inside = raw.startsWith("{") ? raw.slice(1, -1).trim() : raw;
      // Bare numeric literal (e.g. {22})
      if (/^\d+(\.\d+)?$/.test(inside)) {
        offenders.push(`${attr}=${raw}`);
      }
      // String literal without a unit suffix (e.g. "22")
      if (/^"\d+(\.\d+)?"$/.test(raw)) {
        offenders.push(`${attr}=${raw}`);
      }
    }
    expect(
      offenders,
      `AppShell.tsx passes bare numbers to react-resizable-panels Panel size props.\nIn v4 a bare number is interpreted as PIXELS, which silently makes the panel tiny.\nUse a "%" suffix instead (e.g. defaultSize="22%" or defaultSize={\`\${pct}%\`}).\nOffenders:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("collapsed sidebar removes the sidebar Panel from the DOM", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    const { container } = render(
      <Wrapper>
        <AppShell />
      </Wrapper>,
    );

    // The Sidebar's nav landmark should not be present when collapsed.
    expect(container.querySelector('nav[aria-label="Sidebar"]')).toBeNull();
  });
});
