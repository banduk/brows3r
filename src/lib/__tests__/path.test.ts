/**
 * Frontend mirror of the Rust path::encode tests.
 *
 * Coverage mirrors the Rust unit tests:
 * - AC-2 duplicate-name scenario
 * - Unicode keys round-trip
 * - Special chars ?, #, %, / (path separator preserved)
 * - toClipboardString
 * - fromCanonicalUri rejects malformed URIs
 */

import { describe, expect, it } from "vitest";
import {
  fromCanonicalUri,
  fromDisplayPath,
  type S3Location,
  toCanonicalUri,
  toClipboardString,
  toDisplayPath,
} from "../path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoc(
  profileId: string,
  bucket: string,
  prefix: string,
  key: string | null,
): S3Location {
  return { profileId, bucket, prefix, key };
}

// ---------------------------------------------------------------------------
// AC-2: duplicate display names → distinct canonical URIs via profileId
// ---------------------------------------------------------------------------

describe("toCanonicalUri — AC-2 duplicate display names", () => {
  it("produces distinct URIs for same display name but different profileIds", () => {
    const idA = "11111111-1111-1111-1111-111111111111";
    const idB = "22222222-2222-2222-2222-222222222222";

    const locA = makeLoc(idA, "my-bucket", "", "data/file.csv");
    const locB = makeLoc(idB, "my-bucket", "", "data/file.csv");

    const uriA = toCanonicalUri(locA);
    const uriB = toCanonicalUri(locB);

    expect(uriA).not.toBe(uriB);
    expect(uriA).toContain(idA);
    expect(uriB).toContain(idB);
  });
});

// ---------------------------------------------------------------------------
// Unicode key round-trip
// ---------------------------------------------------------------------------

describe("toCanonicalUri / fromCanonicalUri — unicode keys", () => {
  it("round-trips a unicode key losslessly", () => {
    const loc = makeLoc("prof-1", "bucket", "", "café/menu.pdf");
    const uri = toCanonicalUri(loc);
    const result = fromCanonicalUri(uri);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toBe("café/menu.pdf");
  });

  it("preserves slash separators as literals in the URI", () => {
    const loc = makeLoc("prof-1", "bucket", "", "a/b/c.txt");
    const uri = toCanonicalUri(loc);
    // Slashes must be preserved as literal `/` separators. The file extension
    // dot is encoded (%2E) by the strict NON_ALPHANUMERIC set, but `/` stays.
    // Round-tripping gives back the original key unchanged.
    const result = fromCanonicalUri(uri);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toBe("a/b/c.txt");
    // Verify the URI contains literal `/` path separators.
    const uriPath = uri.replace("brows3r://prof-1/bucket/", "");
    expect(uriPath.includes("/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Special chars: ?, #, %, / (path sep preserved)
// ---------------------------------------------------------------------------

describe("toCanonicalUri / fromCanonicalUri — special characters", () => {
  it("encodes ?, #, % in the URI", () => {
    const key = "path/with?query#hash%percent/end";
    const loc = makeLoc("prof-1", "my-bucket", "", key);
    const uri = toCanonicalUri(loc);

    // ? and # must not appear raw in the URI (they would break URI parsing).
    expect(uri).not.toContain("?");
    expect(uri).not.toContain("#");
  });

  it("round-trips keys with ?, #, %, /", () => {
    const key = "path/with?query#hash%percent/end";
    const loc = makeLoc("prof-1", "my-bucket", "", key);
    const uri = toCanonicalUri(loc);
    const result = fromCanonicalUri(uri);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// toClipboardString
// ---------------------------------------------------------------------------

describe("toClipboardString", () => {
  it("produces s3://bucket/key for a keyed location", () => {
    const loc = makeLoc("prof-1", "my-bucket", "", "folder/file.txt");
    expect(toClipboardString(loc, "prod")).toBe(
      "s3://my-bucket/folder/file.txt",
    );
  });

  it("produces s3://bucket/ for bucket root (no key)", () => {
    const loc = makeLoc("prof-1", "my-bucket", "", null);
    expect(toClipboardString(loc, "prod")).toBe("s3://my-bucket/");
  });

  it("uses prefix when key is null", () => {
    const loc = makeLoc("prof-1", "my-bucket", "prefix/dir", null);
    expect(toClipboardString(loc, "prod")).toBe("s3://my-bucket/prefix/dir");
  });
});

// ---------------------------------------------------------------------------
// fromCanonicalUri — malformed inputs
// ---------------------------------------------------------------------------

describe("fromCanonicalUri — rejects malformed URIs", () => {
  it("rejects wrong scheme", () => {
    const result = fromCanonicalUri("https://example.com/bucket/key");
    expect(result.ok).toBe(false);
  });

  it("rejects empty profile_id", () => {
    const result = fromCanonicalUri("brows3r:///bucket/key");
    expect(result.ok).toBe(false);
  });

  it("rejects missing bucket", () => {
    const result = fromCanonicalUri("brows3r://prof-1");
    expect(result.ok).toBe(false);
  });

  it("rejects empty bucket", () => {
    const result = fromCanonicalUri("brows3r://prof-1//key");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toDisplayPath / fromDisplayPath
// ---------------------------------------------------------------------------

describe("toDisplayPath", () => {
  it("splits key into segments", () => {
    const loc = makeLoc("prof-1", "my-bucket", "", "folder/sub/file.txt");
    const dp = toDisplayPath(loc, "production");
    expect(dp.profileDisplayName).toBe("production");
    expect(dp.bucket).toBe("my-bucket");
    expect(dp.segments).toEqual(["folder", "sub", "file.txt"]);
  });

  it("returns empty segments at bucket root", () => {
    const loc = makeLoc("prof-1", "my-bucket", "", null);
    const dp = toDisplayPath(loc, "prod");
    expect(dp.segments).toEqual([]);
  });
});

describe("fromDisplayPath", () => {
  it("joins segments into a key", () => {
    const loc = fromDisplayPath("prof-1", "my-bucket", [
      "folder",
      "sub",
      "file.txt",
    ]);
    expect(loc.key).toBe("folder/sub/file.txt");
  });

  it("sets key to null for empty segments (bucket root)", () => {
    const loc = fromDisplayPath("prof-1", "my-bucket", []);
    expect(loc.key).toBeNull();
  });
});
