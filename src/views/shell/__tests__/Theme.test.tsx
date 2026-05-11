/**
 * Tests for <Theme />.
 *
 * Verifies:
 * 1. Setting theme to "light" applies data-theme="light" on <html> and removes "dark" class.
 * 2. Setting theme to "dark" applies data-theme="dark" on <html> and adds "dark" class.
 * 3. Setting theme to "system" resolves from matchMedia and updates on change.
 * 4. Axe-core: Theme renders nothing visible and has no a11y violations.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { useUiStore } from "@/store/ui";

// ---------------------------------------------------------------------------
// matchMedia stub
// ---------------------------------------------------------------------------

type ChangeHandler = (e: { matches: boolean }) => void;

let _darkMode = false;
const _listeners: ChangeHandler[] = [];

function makeMqStub(dark: boolean) {
  return {
    matches: dark,
    addEventListener: vi.fn((_: string, fn: ChangeHandler) => {
      _listeners.push(fn);
    }),
    removeEventListener: vi.fn((_: string, fn: ChangeHandler) => {
      const idx = _listeners.indexOf(fn);
      if (idx !== -1) _listeners.splice(idx, 1);
    }),
  };
}

function triggerSystemChange(dark: boolean) {
  _darkMode = dark;
  for (const fn of _listeners) {
    fn({ matches: dark });
  }
}

beforeEach(() => {
  _darkMode = false;
  _listeners.length = 0;
  // Reset html attributes before each test.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark");
  // Replace matchMedia with our stub.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => makeMqStub(_darkMode)),
  });
  // Reset ui store to system default.
  useUiStore.setState({ theme: "system" });
});

afterEach(() => {
  cleanup();
});

async function renderTheme() {
  const { Theme } = await import("../Theme");
  return render(<Theme />);
}

describe("Theme", () => {
  it("applies data-theme=light and no dark class for light theme", async () => {
    useUiStore.setState({ theme: "light" });
    await renderTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("applies data-theme=dark and dark class for dark theme", async () => {
    useUiStore.setState({ theme: "dark" });
    await renderTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("system mode resolves light when OS is light", async () => {
    _darkMode = false;
    useUiStore.setState({ theme: "system" });
    await renderTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system mode resolves dark when OS is dark", async () => {
    _darkMode = true;
    useUiStore.setState({ theme: "system" });
    await renderTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("system mode updates when OS preference changes to dark", async () => {
    _darkMode = false;
    useUiStore.setState({ theme: "system" });
    await renderTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Simulate OS switching to dark.
    triggerSystemChange(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("system mode updates when OS preference changes to light", async () => {
    _darkMode = true;
    useUiStore.setState({ theme: "system" });
    await renderTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Simulate OS switching to light.
    triggerSystemChange(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("switching from system to explicit light removes dark class", async () => {
    _darkMode = true;
    useUiStore.setState({ theme: "system" });
    await renderTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    useUiStore.setState({ theme: "light" });
    // Allow effect to run synchronously in jsdom.
    await Promise.resolve();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("has no axe accessibility violations", async () => {
    useUiStore.setState({ theme: "light" });
    const { container } = await renderTheme();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
