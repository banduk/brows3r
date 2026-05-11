/**
 * Tauri mock helpers for Vitest.
 *
 * Usage in tests:
 *
 *   import { mockInvoke, mockListen } from "@/test/mocks/tauri";
 *
 *   mockInvoke("profiles_list", [{ id: "p1", ... }]);
 *   const profiles = await profilesList();
 *   expect(profiles).toHaveLength(1);
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Invoke mock
// ---------------------------------------------------------------------------

type InvokeResponse = unknown;
const invokeHandlers = new Map<string, InvokeResponse>();

/**
 * Register a canned response for a Tauri command name.
 *
 * If `response` is an `Error` the mock rejects with it;
 * otherwise it resolves with the given value.
 */
export function mockInvoke(cmd: string, response: InvokeResponse): void {
  invokeHandlers.set(cmd, response);
}

/** Clear all registered invoke handlers. */
export function clearInvokeMocks(): void {
  invokeHandlers.clear();
}

/**
 * The vi.fn() that replaces `@tauri-apps/api/core` `invoke`.
 *
 * Registered via `vi.mock` in setup.ts so the actual Tauri runtime is
 * never reached during tests.
 */
export const mockInvokeFn = vi.fn(
  async (cmd: string, _args?: unknown): Promise<unknown> => {
    if (!invokeHandlers.has(cmd)) {
      throw new Error(
        `[tauri mock] No handler registered for command "${cmd}"`,
      );
    }
    const response = invokeHandlers.get(cmd);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  },
);

// ---------------------------------------------------------------------------
// Listen mock
// ---------------------------------------------------------------------------

type ListenHandler = (payload: unknown) => void;
const listenHandlers = new Map<string, ListenHandler[]>();

/**
 * Register a handler to be called when `listen(event, ...)` is set up in a test.
 * Use `emitEvent` to trigger it.
 */
export function mockListen(event: string, handler: ListenHandler): void {
  const existing = listenHandlers.get(event) ?? [];
  listenHandlers.set(event, [...existing, handler]);
}

/**
 * Simulate a backend event emission during a test.
 * All handlers registered with `mockListen(event, ...)` are invoked.
 */
export function emitEvent(event: string, payload: unknown): void {
  const handlers = listenHandlers.get(event) ?? [];
  for (const h of handlers) {
    h(payload);
  }
}

/** Clear all registered listen handlers. */
export function clearListenMocks(): void {
  listenHandlers.clear();
}

/**
 * The vi.fn() that replaces `@tauri-apps/api/event` `listen`.
 *
 * It captures handlers so `emitEvent` can trigger them, and returns a
 * no-op unlisten function.
 */
export const mockListenFn = vi.fn(
  async (
    event: string,
    handler: (e: { payload: unknown }) => void,
  ): Promise<() => void> => {
    mockListen(event, (payload) => handler({ payload }));
    return () => {
      // Remove this specific handler on unlisten.
      const existing = listenHandlers.get(event) ?? [];
      listenHandlers.set(
        event,
        existing.filter((h) => h !== handler),
      );
    };
  },
);
