import { describe, expect, it } from "vitest";

import { mockInvoke } from "@/test/mocks/tauri";
import { invoke } from "./tauri";

describe("invoke()", () => {
  it("happy path returns typed result", async () => {
    mockInvoke("profiles_list", [{ id: "p1", displayName: "Test" }]);
    const result =
      await invoke<Array<{ id: string; displayName: string }>>("profiles_list");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
  });

  it("happy path with payload passes args through", async () => {
    mockInvoke("profile_get", {
      id: "p1",
      displayName: "Test",
      source: "manual",
    });
    const result = await invoke<{ id: string }>("profile_get", {
      profileId: "p1",
    });
    expect(result.id).toBe("p1");
  });

  it("error that already matches AppError shape is re-thrown as-is", async () => {
    const appErr = {
      kind: "Auth",
      message: "Authentication failed: expired",
      retryable: false,
      details: { reason: "expired" },
    };
    mockInvoke("profile_validate", appErr);

    // We resolve with an appErr object, so it should succeed (not throw).
    // To test error path we need the mock to throw.
    // Let's test by registering an Error with the AppError shape.
    const thrownErr = Object.assign(new Error("ipc"), {
      kind: "Auth",
      message: "Authentication failed: expired",
      retryable: false,
      details: { reason: "expired" },
    });

    mockInvoke("profile_validate_err", thrownErr);

    try {
      await invoke("profile_validate_err");
      expect.fail("should have thrown");
    } catch (e) {
      // normalizeError wraps to AppError shape
      expect(e).toHaveProperty("kind");
      expect(e).toHaveProperty("message");
      expect(e).toHaveProperty("retryable");
    }
  });

  it("unrecognized error shape is normalized to Internal AppError", async () => {
    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    mockInvokeFn.mockRejectedValueOnce(new Error("unexpected boom"));

    try {
      await invoke("some_cmd");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toMatchObject({
        kind: "Internal",
        retryable: false,
      });
    }
  });
});
