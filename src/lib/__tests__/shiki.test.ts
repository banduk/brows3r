/**
 * Tests for shiki.ts utility functions.
 *
 * Coverage:
 * 1. extensionToLanguage — known extensions map correctly.
 * 2. extensionToLanguage — unknown extension returns null.
 * 3. extensionToLanguage — case-insensitive matching.
 */

import { describe, expect, it } from "vitest";
import { extensionToLanguage } from "../shiki";

describe("extensionToLanguage", () => {
  it("maps .ts to typescript", () => {
    expect(extensionToLanguage(".ts")).toBe("typescript");
  });

  it("maps .tsx to typescript", () => {
    expect(extensionToLanguage(".tsx")).toBe("typescript");
  });

  it("maps .py to python", () => {
    expect(extensionToLanguage(".py")).toBe("python");
  });

  it("maps .json to json", () => {
    expect(extensionToLanguage(".json")).toBe("json");
  });

  it("maps .rs to rust", () => {
    expect(extensionToLanguage(".rs")).toBe("rust");
  });

  it("maps .go to go", () => {
    expect(extensionToLanguage(".go")).toBe("go");
  });

  it("maps .sh to bash", () => {
    expect(extensionToLanguage(".sh")).toBe("bash");
  });

  it("maps .yml to yaml", () => {
    expect(extensionToLanguage(".yml")).toBe("yaml");
  });

  it("maps .yaml to yaml", () => {
    expect(extensionToLanguage(".yaml")).toBe("yaml");
  });

  it("maps .sql to sql", () => {
    expect(extensionToLanguage(".sql")).toBe("sql");
  });

  it("returns null for unknown extension", () => {
    expect(extensionToLanguage(".unknown")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extensionToLanguage("")).toBeNull();
  });

  it("is case-insensitive (.TS → typescript)", () => {
    expect(extensionToLanguage(".TS")).toBe("typescript");
  });

  it("is case-insensitive (.PY → python)", () => {
    expect(extensionToLanguage(".PY")).toBe("python");
  });
});
