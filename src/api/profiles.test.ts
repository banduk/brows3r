import { describe, expect, it } from "vitest";

import { mockInvoke } from "@/test/mocks/tauri";

import {
  type ProfileSummary,
  profileCreateManual,
  profileDelete,
  profileGet,
  profilesList,
  profileUpdate,
  profileValidate,
} from "./profiles";

const SUMMARY: ProfileSummary = {
  id: "p1",
  displayName: "My Profile",
  source: "manual",
  defaultRegion: "us-east-1",
  validatedAt: undefined,
  hasCompatFlags: false,
};

describe("profilesList()", () => {
  it("returns a typed ProfileSummary array", async () => {
    mockInvoke("profiles_list", [SUMMARY]);
    const result = await profilesList();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
    expect(result[0]?.displayName).toBe("My Profile");
    expect(result[0]?.source).toBe("manual");
  });

  it("returns empty array when no profiles", async () => {
    mockInvoke("profiles_list", []);
    const result = await profilesList();
    expect(result).toEqual([]);
  });
});

describe("profileGet()", () => {
  it("returns a ProfileDetail", async () => {
    const detail = {
      ...SUMMARY,
      compatFlags: { flagsSchema: 1 },
      sourceProfile: null,
    };
    mockInvoke("profile_get", detail);
    const result = await profileGet("p1");
    expect(result.id).toBe("p1");
    expect(result.compatFlags).toBeDefined();
  });
});

describe("profileCreateManual()", () => {
  it("returns ProfileSummary", async () => {
    mockInvoke("profile_create_manual", SUMMARY);
    const result = await profileCreateManual({
      name: "My Profile",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
    });
    expect(result.id).toBe("p1");
  });
});

describe("profileUpdate()", () => {
  it("returns updated ProfileSummary", async () => {
    const updated = { ...SUMMARY, displayName: "Renamed" };
    mockInvoke("profile_update", updated);
    const result = await profileUpdate("p1", { displayName: "Renamed" });
    expect(result.displayName).toBe("Renamed");
  });
});

describe("profileDelete()", () => {
  it("resolves without returning data", async () => {
    mockInvoke("profile_delete", undefined);
    await expect(profileDelete("p1")).resolves.toBeUndefined();
  });
});

describe("profileValidate()", () => {
  it("returns ValidationReport", async () => {
    const report = {
      profileId: "p1",
      ok: true,
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/test",
      validatedAt: Date.now(),
      providerKind: "aws",
      error: null,
    };
    mockInvoke("profile_validate", report);
    const result = await profileValidate("p1");
    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("p1");
    expect(result.providerKind).toBe("aws");
  });
});
