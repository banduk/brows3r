/**
 * Tests for useValidatedProfile, useProfilesList, useBuckets, useObjects.
 *
 * Strategy: mock `profilesList` via the tauri mock, wrap in a QueryClient,
 * and render a small hook test harness.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";
import { useBuckets, useValidatedProfile } from "../useValidatedProfile";

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { client, Wrapper };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UNVALIDATED_PROFILE: ProfileSummary = {
  id: "p1",
  displayName: "Test Profile",
  source: "manual",
  hasCompatFlags: false,
  // validatedAt is intentionally absent
};

const VALIDATED_PROFILE: ProfileSummary = {
  id: "p1",
  displayName: "Test Profile",
  source: "manual",
  hasCompatFlags: false,
  validatedAt: Date.now() - 1_000,
};

// ---------------------------------------------------------------------------
// useValidatedProfile
// ---------------------------------------------------------------------------

describe("useValidatedProfile", () => {
  it("returns isValidated=false when profileId is null", async () => {
    mockInvoke("profiles_list", [UNVALIDATED_PROFILE]);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useValidatedProfile(null), {
      wrapper: Wrapper,
    });
    expect(result.current.isValidated).toBe(false);
    expect(result.current.profile).toBeNull();
  });

  it("returns isValidated=false when validatedAt is absent", async () => {
    mockInvoke("profiles_list", [UNVALIDATED_PROFILE]);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useValidatedProfile("p1"), {
      wrapper: Wrapper,
    });

    // Initially loading.
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isValidated).toBe(false);
    expect(result.current.profile?.id).toBe("p1");
  });

  it("returns isValidated=true when validatedAt is set", async () => {
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useValidatedProfile("p1"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isValidated).toBe(true);
    expect(result.current.profile?.id).toBe("p1");
  });

  it("returns isValidated=false when profile is not found", async () => {
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useValidatedProfile("unknown"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isValidated).toBe(false);
    expect(result.current.profile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useBuckets — gating behaviour
// ---------------------------------------------------------------------------

describe("useBuckets", () => {
  it("returns isGated=true and no data when profile is not validated", async () => {
    mockInvoke("profiles_list", [UNVALIDATED_PROFILE]);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBuckets("p1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isGated).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it("returns isGated=false when profile is validated (even if fetch is pending)", async () => {
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    // buckets_list not wired yet — hook throws internally; query is disabled
    // until the real task 27 lands; here we only test the gate logic.
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBuckets("p1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Gate lifted — isGated should be false (fetch may be in error state
    // from the stub, but that's expected; we just verify gate semantics).
    expect(result.current.isGated).toBe(false);
  });
});
