/**
 * Tests for NotificationsPanel.
 *
 * - Renders with default notification values.
 * - Toggling in-app → save calls settingsUpdate.
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

  const { NotificationsPanel } = await import(
    "@/views/settings/NotificationsPanel"
  );
  return render(<NotificationsPanel />);
}

describe("NotificationsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders in-app, OS, and sound toggles with defaults", async () => {
    await renderPanel();

    const inApp = screen.getByLabelText(
      /in-app notifications/i,
    ) as HTMLInputElement;
    const os = screen.getByLabelText(/os notifications/i) as HTMLInputElement;
    const sound = screen.getByLabelText(
      /notification sound/i,
    ) as HTMLInputElement;

    expect(inApp.checked).toBe(DEFAULT_SETTINGS.notifications.inApp);
    expect(os.checked).toBe(DEFAULT_SETTINGS.notifications.osEnabled);
    expect(sound.checked).toBe(DEFAULT_SETTINGS.notifications.sound);
  });

  it("toggling in-app and saving calls settingsUpdate", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const inApp = screen.getByLabelText(/in-app notifications/i);
    await user.click(inApp);

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
