/**
 * Tests for ProxyPanel.
 *
 * - Renders with system proxy selected by default.
 * - Selecting explicit mode shows URL input.
 * - Invalid URL shows validation error.
 * - Valid explicit proxy saves without error.
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

  const { ProxyPanel } = await import("@/views/settings/ProxyPanel");
  return render(<ProxyPanel />);
}

describe("ProxyPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with system proxy selected by default", async () => {
    await renderPanel();

    const modeSelect = screen.getByLabelText(
      /proxy mode/i,
    ) as HTMLSelectElement;
    expect(modeSelect.value).toBe("system");
  });

  it("selecting explicit mode shows URL input", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const modeSelect = screen.getByLabelText(/proxy mode/i);
    await user.selectOptions(modeSelect, "explicit");

    expect(screen.getByLabelText(/proxy url/i)).toBeInTheDocument();
  });

  it("shows error when explicit URL is missing on save", async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.selectOptions(screen.getByLabelText(/proxy mode/i), "explicit");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/proxy url is required/i)).toBeInTheDocument();
    });
  });

  it("saves valid explicit proxy without error", async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.selectOptions(screen.getByLabelText(/proxy mode/i), "explicit");
    await user.type(
      screen.getByLabelText(/proxy url/i),
      "http://proxy.example.com:3128",
    );

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/proxy url is required/i)).toBeNull();
      expect(screen.queryByText(/must be a valid url/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
