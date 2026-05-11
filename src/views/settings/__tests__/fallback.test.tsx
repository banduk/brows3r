/**
 * Tests for FallbackPanel.
 *
 * - Renders with default fallback threshold.
 * - Zero threshold shows validation error.
 * - Valid threshold saves without error.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { DEFAULT_SETTINGS } from "@/store/settings";
import { mockInvoke } from "@/test/mocks/tauri";

async function renderPanel() {
  mockInvoke("settings_get", DEFAULT_SETTINGS);
  mockInvoke("settings_update", DEFAULT_SETTINGS);

  const { useSettingsStore } = await import("@/store/settings");
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { FallbackPanel } = await import("@/views/settings/FallbackPanel");
  return render(<FallbackPanel />);
}

describe("FallbackPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default fallback threshold", async () => {
    await renderPanel();

    const input = screen.getByLabelText(
      /fallback threshold/i,
    ) as HTMLInputElement;
    expect(Number(input.value)).toBe(DEFAULT_SETTINGS.fallbackThresholdMb);
  });

  it("shows validation error when threshold is 0", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const input = screen.getByLabelText(/fallback threshold/i);
    await user.clear(input);
    await user.type(input, "0");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/between 1 and 10240/i)).toBeInTheDocument();
    });
  });

  it("saves valid threshold without error", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const input = screen.getByLabelText(/fallback threshold/i);
    await user.clear(input);
    await user.type(input, "200");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/between 1 and 10240/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
