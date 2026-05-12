/**
 * Vitest global setup file.
 *
 * - Mocks `@tauri-apps/api/core` and `@tauri-apps/api/event` so tests
 *   never reach the Tauri runtime.
 * - Clears mock state between tests.
 */

import "@testing-library/jest-dom";
// Bootstrap i18n with English so `useTranslation()` returns rendered
// strings in tests (without this, `t(key)` returns the key itself and
// every assertion that matches on translated copy fails).
import "@/i18n";
// Import vitest-axe types + register global matcher augmentation.
import "vitest-axe/extend-expect";
import { afterEach, expect, vi } from "vitest";
import * as axeMatchers from "vitest-axe/matchers";

// Extend Vitest's expect with toHaveNoViolations from vitest-axe.
expect.extend(axeMatchers);

import {
  clearInvokeMocks,
  clearListenMocks,
  mockInvokeFn,
  mockListenFn,
} from "./mocks/tauri";

// ---------------------------------------------------------------------------
// Polyfill DOMMatrix — required by PDF.js's CanvasContext path which is
// imported transitively by react-pdf, but not available in jsdom.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Polyfill ResizeObserver — react-resizable-panels and TanStack Virtual use
// it. jsdom does not ship one, and Vitest 4 requires real `class`/`function`
// constructors when something is invoked via `new` (`vi.fn(() => ({…}))` no
// longer satisfies new-call semantics).
// ---------------------------------------------------------------------------

if (typeof globalThis.ResizeObserver === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof globalThis.DOMMatrix === "undefined") {
  // Minimal stub that satisfies the PDF.js module load path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    static fromMatrix() {
      return new DOMMatrix();
    }
    multiply() {
      return this;
    }
    translate() {
      return this;
    }
    scale() {
      return this;
    }
    inverse() {
      return this;
    }
  };
}

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core (invoke)
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvokeFn,
}));

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/event (listen, once, emit)
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListenFn,
  once: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Reset mock state between tests
// ---------------------------------------------------------------------------

afterEach(() => {
  clearInvokeMocks();
  clearListenMocks();
  vi.clearAllMocks();
});
