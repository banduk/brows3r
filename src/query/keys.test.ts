import { describe, expect, it } from "vitest";

import { keys } from "./keys";

describe("keys factory", () => {
  describe("structural equality", () => {
    it("profiles() is stable across calls", () => {
      expect(keys.profiles()).toEqual(keys.profiles());
    });

    it("profile(id) is stable across calls", () => {
      expect(keys.profile("p1")).toEqual(keys.profile("p1"));
    });

    it("buckets(profileId) is stable", () => {
      expect(keys.buckets("p1")).toEqual(keys.buckets("p1"));
    });

    it("objects(profileId, bucket, prefix) is stable", () => {
      expect(keys.objects("p1", "my-bucket", "folder/")).toEqual(
        keys.objects("p1", "my-bucket", "folder/"),
      );
    });

    it("objectsFlat matches objects + flat suffix", () => {
      const flat = keys.objectsFlat("p1", "b", "x/");
      const hierarchical = keys.objects("p1", "b", "x/");
      // flat key is a superset — includes everything from hierarchical
      expect(flat.slice(0, hierarchical.length)).toEqual(hierarchical);
      expect(flat[flat.length - 1]).toBe("flat");
    });

    it("objectHead with versionId is distinct from without", () => {
      const withVersion = keys.objectHead("p1", "b", "k", "v1");
      const withoutVersion = keys.objectHead("p1", "b", "k");
      expect(withVersion).not.toEqual(withoutVersion);
      expect(withoutVersion[withoutVersion.length - 1]).toBeNull();
    });

    it("inspector with key is distinct from without key", () => {
      const withKey = keys.inspector("p1", "b", "obj.txt");
      const withoutKey = keys.inspector("p1", "b");
      expect(withKey).not.toEqual(withoutKey);
      expect(withoutKey[withoutKey.length - 1]).toBeNull();
    });

    it("transfers() is stable", () => {
      expect(keys.transfers()).toEqual(keys.transfers());
    });

    it("notifications() is stable", () => {
      expect(keys.notifications()).toEqual(keys.notifications());
    });

    it("settings() is stable", () => {
      expect(keys.settings()).toEqual(keys.settings());
    });

    it("media() is stable", () => {
      expect(keys.media()).toEqual(keys.media());
    });
  });

  describe("key distinctness", () => {
    it("different prefix → different objects key", () => {
      const a = keys.objects("p1", "b", "x/");
      const b = keys.objects("p1", "b", "x");
      expect(a).not.toEqual(b);
    });

    it("different bucket → different objects key", () => {
      const a = keys.objects("p1", "bucket-a", "x/");
      const b = keys.objects("p1", "bucket-b", "x/");
      expect(a).not.toEqual(b);
    });

    it("different profileId → different buckets key", () => {
      const a = keys.buckets("p1");
      const b = keys.buckets("p2");
      expect(a).not.toEqual(b);
    });

    it("profiles() and profile(id) are distinct", () => {
      expect(keys.profiles()).not.toEqual(keys.profile("p1"));
    });
  });

  describe("prefix matching (TanStack Query invalidation)", () => {
    it("objects key starts with ['objects', profileId, bucket]", () => {
      const k = keys.objects("p1", "b", "prefix/");
      expect(k[0]).toBe("objects");
      expect(k[1]).toBe("p1");
      expect(k[2]).toBe("b");
    });

    it("inspector key starts with ['inspector', profileId, bucket]", () => {
      const k = keys.inspector("p1", "b", "key.txt");
      expect(k[0]).toBe("inspector");
      expect(k[1]).toBe("p1");
      expect(k[2]).toBe("b");
    });
  });
});
