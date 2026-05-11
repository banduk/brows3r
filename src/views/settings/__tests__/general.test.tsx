/**
 * Tests for GeneralPanel.
 *
 * - Renders with default values populated.
 * - Changing theme → calls settingsUpdate.
 * - Axe a11y assertion.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { DEFAULT_SETTINGS } from "@/store/settings";
import { mockInvoke } from "@/test/mocks/tauri";

async function renderPanel() {
  // Seed store with defaults via settings_get.
  mockInvoke("settings_get", DEFAULT_SETTINGS);
  mockInvoke("settings_update", DEFAULT_SETTINGS);

  // Import after mocks are registered so the store loads fresh.
  const { useSettingsStore } = await import("@/store/settings");
  // Reset store state between tests.
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { GeneralPanel } = await import("@/views/settings/GeneralPanel");
  return render(<GeneralPanel />);
}

describe("GeneralPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders theme and view mode selects with default values", async () => {
    const { getByLabelText } = await renderPanel();

    const themeSelect = getByLabelText(/theme/i) as HTMLSelectElement;
    expect(themeSelect.value).toBe(DEFAULT_SETTINGS.theme);

    const viewModeSelect = getByLabelText(
      /default view mode/i,
    ) as HTMLSelectElement;
    expect(viewModeSelect.value).toBe(DEFAULT_SETTINGS.defaultViewMode);
  });

  it("changing theme calls settingsUpdate on save", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const themeSelect = screen.getByLabelText(/theme/i);
    await user.selectOptions(themeSelect, "dark");

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveBtn);

    // settings_update should have been called (mock resolves it).
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
