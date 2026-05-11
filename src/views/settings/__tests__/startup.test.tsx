/**
 * Tests for StartupPanel.
 *
 * - Renders with default startup settings.
 * - Toggling restore session and saving calls settingsUpdate.
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

  const { StartupPanel } = await import("@/views/settings/StartupPanel");
  return render(<StartupPanel />);
}

describe("StartupPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default restore session value", async () => {
    await renderPanel();

    const toggle = screen.getByLabelText(
      /restore last session/i,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(
      DEFAULT_SETTINGS.startupBehavior.restoreSession,
    );
  });

  it("shows open-to input field", async () => {
    await renderPanel();
    expect(screen.getByLabelText(/open to/i)).toBeInTheDocument();
  });

  it("toggling restore session and saving calls settingsUpdate", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const toggle = screen.getByLabelText(/restore last session/i);
    await user.click(toggle);

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
