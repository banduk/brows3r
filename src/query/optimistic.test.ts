/**
 * Tests for src/query/optimistic.ts
 *
 * Coverage:
 * 1. parentPrefix helper.
 * 2. optimisticCreateFolder: folder appears immediately; rollback removes it.
 * 3. optimisticDeleteSingle: row disappears immediately; rollback restores it.
 * 4. optimisticRenameSingle: key updated in-place; rollback restores original.
 * 5. Excluded mutations regression: EXCLUDED_FROM_OPTIMISM keys do NOT appear
 *    in OPTIMISTIC_HELPERS_MAP.
 */

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ListPage, ObjectEntry } from "@/api/objects";
import { keys } from "./keys";
import {
  EXCLUDED_FROM_OPTIMISM,
  OPTIMISTIC_HELPERS_MAP,
  optimisticCreateFolder,
  optimisticDeleteSingle,
  optimisticRenameSingle,
  parentPrefix,
} from "./optimistic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function seedListing(
  client: QueryClient,
  profileId: string,
  bucket: string,
  prefix: string,
  entries: ObjectEntry[],
): void {
  const page: ListPage = {
    entries,
    commonPrefixes: entries.filter((e) => e.isPrefix).map((e) => e.key),
    isTruncated: false,
    prefix,
    delimiter: "/",
  };
  client.setQueryData(keys.objects(profileId, bucket, prefix), page);
}

function getEntries(
  client: QueryClient,
  profileId: string,
  bucket: string,
  prefix: string,
): ObjectEntry[] {
  const page = client.getQueryData<ListPage>(
    keys.objects(profileId, bucket, prefix),
  );
  return page?.entries ?? [];
}

// ---------------------------------------------------------------------------
// parentPrefix
// ---------------------------------------------------------------------------

describe("parentPrefix", () => {
  it("returns parent prefix for nested key", () => {
    expect(parentPrefix("photos/2024/img.jpg")).toBe("photos/2024/");
  });

  it("returns empty string for root-level key", () => {
    expect(parentPrefix("img.jpg")).toBe("");
  });

  it("strips trailing slash before computing parent", () => {
    expect(parentPrefix("photos/")).toBe("");
    expect(parentPrefix("photos/sub/")).toBe("photos/");
  });

  it("handles key with single parent", () => {
    expect(parentPrefix("folder/file.txt")).toBe("folder/");
  });
});

// ---------------------------------------------------------------------------
// optimisticCreateFolder
// ---------------------------------------------------------------------------

describe("optimisticCreateFolder", () => {
  let client: QueryClient;
  const pid = "p1";
  const bkt = "bucket";

  afterEach(() => {
    client?.clear();
  });

  it("pushes a virtual prefix entry into the cache immediately", async () => {
    client = makeQueryClient();
    const existing: ObjectEntry = {
      key: "existing.txt",
      size: 100,
      isPrefix: false,
    };
    seedListing(client, pid, bkt, "", [existing]);

    await optimisticCreateFolder(client, pid, bkt, "new-folder/");

    const entries = getEntries(client, pid, bkt, "");
    expect(entries.some((e) => e.key === "new-folder/" && e.isPrefix)).toBe(
      true,
    );
  });

  it("adds trailing slash to prefix if missing", async () => {
    client = makeQueryClient();
    seedListing(client, pid, bkt, "", []);

    await optimisticCreateFolder(client, pid, bkt, "my-folder");

    const entries = getEntries(client, pid, bkt, "");
    expect(entries.some((e) => e.key === "my-folder/")).toBe(true);
  });

  it("rollback removes the optimistic entry", async () => {
    client = makeQueryClient();
    seedListing(client, pid, bkt, "", []);

    const { rollback } = await optimisticCreateFolder(
      client,
      pid,
      bkt,
      "temp-folder/",
    );

    let entries = getEntries(client, pid, bkt, "");
    expect(entries).toHaveLength(1);

    rollback();

    entries = getEntries(client, pid, bkt, "");
    expect(entries).toHaveLength(0);
  });

  it("does not add duplicate entries for the same prefix", async () => {
    client = makeQueryClient();
    const existing: ObjectEntry = { key: "folder/", size: 0, isPrefix: true };
    seedListing(client, pid, bkt, "", [existing]);

    await optimisticCreateFolder(client, pid, bkt, "folder/");

    const entries = getEntries(client, pid, bkt, "");
    const folderEntries = entries.filter((e) => e.key === "folder/");
    expect(folderEntries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// optimisticDeleteSingle
// ---------------------------------------------------------------------------

describe("optimisticDeleteSingle", () => {
  let client: QueryClient;
  const pid = "p1";
  const bkt = "bucket";

  afterEach(() => {
    client?.clear();
  });

  it("removes the entry from the cache immediately", async () => {
    client = makeQueryClient();
    const file: ObjectEntry = {
      key: "folder/file.txt",
      size: 200,
      isPrefix: false,
    };
    const other: ObjectEntry = {
      key: "folder/other.txt",
      size: 100,
      isPrefix: false,
    };
    seedListing(client, pid, bkt, "folder/", [file, other]);

    await optimisticDeleteSingle(client, pid, bkt, "folder/file.txt");

    const entries = getEntries(client, pid, bkt, "folder/");
    expect(entries.some((e) => e.key === "folder/file.txt")).toBe(false);
    expect(entries.some((e) => e.key === "folder/other.txt")).toBe(true);
  });

  it("rollback restores the deleted entry", async () => {
    client = makeQueryClient();
    const file: ObjectEntry = {
      key: "docs/report.pdf",
      size: 500,
      isPrefix: false,
    };
    seedListing(client, pid, bkt, "docs/", [file]);

    const { rollback } = await optimisticDeleteSingle(
      client,
      pid,
      bkt,
      "docs/report.pdf",
    );

    expect(getEntries(client, pid, bkt, "docs/")).toHaveLength(0);

    rollback();

    const restored = getEntries(client, pid, bkt, "docs/");
    expect(restored).toHaveLength(1);
    expect(restored[0]?.key).toBe("docs/report.pdf");
  });
});

// ---------------------------------------------------------------------------
// optimisticRenameSingle
// ---------------------------------------------------------------------------

describe("optimisticRenameSingle", () => {
  let client: QueryClient;
  const pid = "p1";
  const bkt = "bucket";

  afterEach(() => {
    client?.clear();
  });

  it("updates the entry key in place", async () => {
    client = makeQueryClient();
    const file: ObjectEntry = {
      key: "pics/cat.jpg",
      size: 1024,
      isPrefix: false,
    };
    seedListing(client, pid, bkt, "pics/", [file]);

    await optimisticRenameSingle(
      client,
      pid,
      bkt,
      "pics/cat.jpg",
      "pics/kitty.jpg",
    );

    const entries = getEntries(client, pid, bkt, "pics/");
    expect(entries.some((e) => e.key === "pics/kitty.jpg")).toBe(true);
    expect(entries.some((e) => e.key === "pics/cat.jpg")).toBe(false);
  });

  it("rollback restores the original key", async () => {
    client = makeQueryClient();
    const file: ObjectEntry = {
      key: "data/old.csv",
      size: 2048,
      isPrefix: false,
    };
    seedListing(client, pid, bkt, "data/", [file]);

    const { rollback } = await optimisticRenameSingle(
      client,
      pid,
      bkt,
      "data/old.csv",
      "data/new.csv",
    );

    expect(
      getEntries(client, pid, bkt, "data/").some(
        (e) => e.key === "data/new.csv",
      ),
    ).toBe(true);

    rollback();

    const restored = getEntries(client, pid, bkt, "data/");
    expect(restored[0]?.key).toBe("data/old.csv");
  });
});

// ---------------------------------------------------------------------------
// EXCLUDED_FROM_OPTIMISM regression test
//
// Assert that no key in EXCLUDED_FROM_OPTIMISM appears in OPTIMISTIC_HELPERS_MAP.
// This is a compile-time-ish safety net that catches future accidental additions.
// ---------------------------------------------------------------------------

describe("EXCLUDED_FROM_OPTIMISM regression", () => {
  it("none of the excluded mutation identifiers have optimistic helpers", () => {
    const helperKeys = Object.keys(OPTIMISTIC_HELPERS_MAP);

    for (const excluded of EXCLUDED_FROM_OPTIMISM) {
      expect(helperKeys).not.toContain(excluded);
    }
  });

  it("excluded list contains storage_class", () => {
    expect(EXCLUDED_FROM_OPTIMISM).toContain("storage_class");
  });

  it("excluded list contains batch_delete_mixed", () => {
    expect(EXCLUDED_FROM_OPTIMISM).toContain("batch_delete_mixed");
  });

  it("excluded list contains cross_account", () => {
    expect(EXCLUDED_FROM_OPTIMISM).toContain("cross_account");
  });

  it("excluded list contains metadata", () => {
    expect(EXCLUDED_FROM_OPTIMISM).toContain("metadata");
  });
});
