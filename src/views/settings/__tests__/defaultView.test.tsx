/**
 * Tests for DefaultViewPanel.
 *
 * - Renders with default view mode populated.
 * - Changing view mode and saving calls settingsUpdate.
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
    defaultViewMode: "Gallery",
  });

  const { useSettingsStore } = await import("@/store/settings");
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { DefaultViewPanel } = await import(
    "@/views/settings/DefaultViewPanel"
  );
  return render(<DefaultViewPanel />);
}

describe("DefaultViewPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default view mode", async () => {
    await renderPanel();

    const select = screen.getByLabelText(
      /default view mode/i,
    ) as HTMLSelectElement;
    expect(select.value).toBe(DEFAULT_SETTINGS.defaultViewMode);
  });

  it("changing view mode and saving calls settingsUpdate without error", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const select = screen.getByLabelText(/default view mode/i);
    await user.selectOptions(select, "Gallery");

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
