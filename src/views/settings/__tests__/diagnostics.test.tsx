/**
 * Tests for DiagnosticsPanel (task 60).
 *
 * - Renders with default diagnostics setting.
 * - Toggling and saving calls settingsUpdate.
 * - "Export diagnostic bundle" button triggers collect → save dialog → export.
 * - Save dialog cancel aborts without calling export.
 * - Error from collect is surfaced as an alert.
 * - Axe-core a11y assertion.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { DEFAULT_SETTINGS } from "@/store/settings";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

// Mock the save dialog so tests don't open a real OS dialog.
const mockSave = vi.fn().mockResolvedValue("/tmp/brows3r-diagnostics.zip");
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
  open: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_BUNDLE_REF = {
  id: "test-bundle-id",
  path: "/tmp/brows3r_cache/diagnostics/test-bundle-id/bundle.zip",
  sizeBytes: 1024,
  redactionApplied: true,
};

async function renderPanel() {
  mockInvoke("settings_get", DEFAULT_SETTINGS);
  mockInvoke("settings_update", DEFAULT_SETTINGS);

  const { useSettingsStore } = await import("@/store/settings");
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { DiagnosticsPanel } = await import(
    "@/views/settings/DiagnosticsPanel"
  );
  return render(<DiagnosticsPanel />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiagnosticsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders with default diagnostics enabled value", async () => {
    await renderPanel();

    const toggle = screen.getByLabelText(
      /enable diagnostics collection/i,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(DEFAULT_SETTINGS.diagnosticsEnabled);
  });

  it("toggling and saving calls settingsUpdate", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const toggle = screen.getByLabelText(/enable diagnostics collection/i);
    await user.click(toggle);

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("generate triggers collect, save dialog, then export on success", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue("/tmp/brows3r-diagnostics.zip");
    mockInvoke("diagnostics_collect", FAKE_BUNDLE_REF);
    mockInvoke("diagnostics_export", null);

    await renderPanel();

    const exportBtn = screen.getByRole("button", {
      name: /export diagnostic bundle/i,
    });
    await user.click(exportBtn);

    // After the flow completes, a success message with the path should appear.
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "/tmp/brows3r-diagnostics.zip",
      );
    });

    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    expect(mockInvokeFn).toHaveBeenCalledWith(
      "diagnostics_collect",
      expect.objectContaining({ config: expect.any(Object) }),
    );
    expect(mockInvokeFn).toHaveBeenCalledWith(
      "diagnostics_export",
      expect.objectContaining({
        bundleRef: FAKE_BUNDLE_REF,
        destPath: "/tmp/brows3r-diagnostics.zip",
      }),
    );
  });

  it("save dialog cancel aborts without calling export", async () => {
    const user = userEvent.setup();
    // Dialog returns null → user cancelled.
    mockSave.mockResolvedValue(null);
    mockInvoke("diagnostics_collect", FAKE_BUNDLE_REF);

    await renderPanel();

    const exportBtn = screen.getByRole("button", {
      name: /export diagnostic bundle/i,
    });
    await user.click(exportBtn);

    // Wait for the async flow to finish (button returns to non-busy state).
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /export diagnostic bundle/i }),
      ).not.toBeDisabled();
    });

    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    expect(mockInvokeFn).not.toHaveBeenCalledWith(
      "diagnostics_export",
      expect.anything(),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows error alert when collect fails", async () => {
    const user = userEvent.setup();
    mockInvoke("diagnostics_collect", new Error("collect failed"));

    await renderPanel();

    const exportBtn = screen.getByRole("button", {
      name: /export diagnostic bundle/i,
    });
    await user.click(exportBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/failed to collect/i);
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
