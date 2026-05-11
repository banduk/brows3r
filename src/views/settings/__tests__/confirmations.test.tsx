/**
 * Tests for ConfirmationsPanel.
 *
 * - Renders with default confirmation values.
 * - Large upload threshold = 0 shows validation error.
 * - Changing delete toggle and saving calls settingsUpdate.
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

  const { ConfirmationsPanel } = await import(
    "@/views/settings/ConfirmationsPanel"
  );
  return render(<ConfirmationsPanel />);
}

describe("ConfirmationsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default confirmation values", async () => {
    await renderPanel();

    const deleteToggle = screen.getByLabelText(
      /confirm delete/i,
    ) as HTMLInputElement;
    expect(deleteToggle.checked).toBe(
      DEFAULT_SETTINGS.transferConfirmations.delete,
    );

    const overwriteToggle = screen.getByLabelText(
      /confirm overwrite/i,
    ) as HTMLInputElement;
    expect(overwriteToggle.checked).toBe(
      DEFAULT_SETTINGS.transferConfirmations.overwrite,
    );

    const largeInput = screen.getByLabelText(
      /large upload threshold/i,
    ) as HTMLInputElement;
    expect(Number(largeInput.value)).toBe(
      DEFAULT_SETTINGS.transferConfirmations.largeUploadMb,
    );
  });

  it("shows validation error when large upload threshold is 0", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const largeInput = screen.getByLabelText(/large upload threshold/i);
    await user.clear(largeInput);
    await user.type(largeInput, "0");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/greater than 0/i)).toBeInTheDocument();
    });
  });

  it("toggling delete confirm and saving calls settingsUpdate", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const deleteToggle = screen.getByLabelText(/confirm delete/i);
    await user.click(deleteToggle);

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/greater than 0/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
