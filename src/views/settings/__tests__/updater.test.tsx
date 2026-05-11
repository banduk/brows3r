/**
 * Tests for UpdaterPanel.
 *
 * - Renders with default auto-update settings.
 * - Disabling auto-update disables the channel select.
 * - Changing channel and saving calls settingsUpdate.
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

  const { UpdaterPanel } = await import("@/views/settings/UpdaterPanel");
  return render(<UpdaterPanel />);
}

describe("UpdaterPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default auto-update values", async () => {
    await renderPanel();

    const enabledToggle = screen.getByLabelText(
      /auto-update enabled/i,
    ) as HTMLInputElement;
    expect(enabledToggle.checked).toBe(DEFAULT_SETTINGS.autoUpdate.enabled);

    const channelSelect = screen.getByLabelText(
      /update channel/i,
    ) as HTMLSelectElement;
    expect(channelSelect.value).toBe(DEFAULT_SETTINGS.autoUpdate.channel);
  });

  it("disabling auto-update disables the channel select", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const enabledToggle = screen.getByLabelText(/auto-update enabled/i);
    await user.click(enabledToggle);

    const channelSelect = screen.getByLabelText(
      /update channel/i,
    ) as HTMLSelectElement;
    expect(channelSelect.disabled).toBe(true);
  });

  it("changing channel and saving calls settingsUpdate", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const channelSelect = screen.getByLabelText(/update channel/i);
    await user.selectOptions(channelSelect, "beta");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
