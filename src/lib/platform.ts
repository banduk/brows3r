/**
 * Platform detection helper.
 *
 * Uses `@tauri-apps/api/core` `invoke("plugin:os|platform")` to query the OS
 * from Rust.  In Tauri 2 the OS plugin is accessed via the plugin invoke
 * bridge.  Falls back to `navigator.userAgent` heuristics when the invoke
 * call is unavailable (e.g. in unit tests that do not mock the command).
 *
 * OCP: switching the Linux fallback mechanism (when Tauri 2 adds Linux
 * drag-out support) is a one-function rewrite here.
 *
 * Mock-friendly: in tests use `vi.mock("@/lib/platform", () => ({ ... }))`.
 */

import { invoke } from "@tauri-apps/api/core";

/** Normalised platform values used by drag-out and other platform-sensitive code. */
export type Platform = "mac" | "win" | "linux";

/**
 * Return the normalised platform for the current OS.
 *
 * Calls the Tauri OS plugin bridge.  Tauri 2's plugin-os exposes the
 * `plugin:os|platform` command which returns `"macos"`, `"windows"`,
 * or `"linux"`.  If the invoke fails (no Tauri runtime / unit test),
 * falls back to `navigator.userAgent` heuristics.
 */
export async function getPlatform(): Promise<Platform> {
  try {
    const raw = await invoke<string>("plugin:os|platform");
    if (raw === "macos") return "mac";
    if (raw === "windows") return "win";
    return "linux";
  } catch {
    // Fallback for non-Tauri environments (tests, web preview).
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "mac";
    if (ua.includes("win")) return "win";
    return "linux";
  }
}

/**
 * Return `true` on macOS and Windows where Tauri 2's `drag` API is supported.
 * Return `false` on Linux, where a Save dialog fallback must be used.
 */
export async function isDragOutSupported(): Promise<boolean> {
  const p = await getPlatform();
  return p === "mac" || p === "win";
}
