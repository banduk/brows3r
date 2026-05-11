/**
 * Smoke test: verifies that each @tauri-apps/plugin-* JS package is
 * installed and exports the expected named symbols.
 *
 * These tests do NOT invoke the Tauri runtime; they only exercise the
 * module graph, proving the JS deps resolved correctly.
 */
import { describe, expect, it } from "vitest";

describe("@tauri-apps/plugin-dialog", () => {
  it("exports `open`", async () => {
    const mod = await import("@tauri-apps/plugin-dialog");
    expect(mod.open).toBeDefined();
  });

  it("exports `save`", async () => {
    const mod = await import("@tauri-apps/plugin-dialog");
    expect(mod.save).toBeDefined();
  });
});

describe("@tauri-apps/plugin-fs", () => {
  it("exports `readFile`", async () => {
    const mod = await import("@tauri-apps/plugin-fs");
    expect(mod.readFile).toBeDefined();
  });

  it("exports `writeFile`", async () => {
    const mod = await import("@tauri-apps/plugin-fs");
    expect(mod.writeFile).toBeDefined();
  });
});

describe("@tauri-apps/plugin-shell", () => {
  it("exports `Command`", async () => {
    const mod = await import("@tauri-apps/plugin-shell");
    expect(mod.Command).toBeDefined();
  });

  it("exports `open`", async () => {
    const mod = await import("@tauri-apps/plugin-shell");
    expect(mod.open).toBeDefined();
  });
});

describe("@tauri-apps/plugin-notification", () => {
  it("exports `sendNotification`", async () => {
    const mod = await import("@tauri-apps/plugin-notification");
    expect(mod.sendNotification).toBeDefined();
  });

  it("exports `requestPermission`", async () => {
    const mod = await import("@tauri-apps/plugin-notification");
    expect(mod.requestPermission).toBeDefined();
  });
});
