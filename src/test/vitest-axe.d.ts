/**
 * Type augmentation for vitest-axe's toHaveNoViolations matcher.
 *
 * vitest-axe uses the `Vi` namespace for augmentation, but vitest/globals
 * uses the `vitest` module augmentation. This file bridges the gap.
 */

import type { AxeResults } from "axe-core";

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T extends AxeResults ? void : never;
  }
}
