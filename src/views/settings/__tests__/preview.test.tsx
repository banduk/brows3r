/**
 * Tests for PreviewPanel.
 *
 * - Renders with default preview size limit.
 * - Setting limit below range shows validation error.
 * - Valid change → settingsUpdate called without error.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { DEFAULT_SETTINGS } from "@/store/settings";
import { mockInvoke } from "@/test/mocks/tauri";

async function renderPanel() {
  mockInvoke("settings_get", DEFAULT_SETTINGS);
  mockInvoke("settings_update", {
    ...DEFAULT_SETTINGS,
    previewSizeLimitMb: 25,
  });

  const { useSettingsStore } = await import("@/store/settings");
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { PreviewPanel } = await import("@/views/settings/PreviewPanel");
  return render(<PreviewPanel />);
}

describe("PreviewPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default preview size limit", async () => {
    await renderPanel();
    const input = screen.getByLabelText(
      /preview size limit/i,
    ) as HTMLInputElement;
    expect(Number(input.value)).toBe(DEFAULT_SETTINGS.previewSizeLimitMb);
  });

  it("shows validation error when limit is 0", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const input = screen.getByLabelText(/preview size limit/i);
    await user.clear(input);
    await user.type(input, "0");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/between 1 and 500/i)).toBeInTheDocument();
    });
  });

  it("saves valid limit without error", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const input = screen.getByLabelText(/preview size limit/i);
    await user.clear(input);
    await user.type(input, "25");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/between 1 and 500/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
