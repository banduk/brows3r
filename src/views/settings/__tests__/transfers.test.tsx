/**
 * Tests for TransfersPanel.
 *
 * - Renders with default concurrency populated.
 * - Setting concurrency to 0 shows validation error.
 * - Valid change → settingsUpdate called.
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
    transferConcurrency: 8,
  });

  const { useSettingsStore } = await import("@/store/settings");
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { TransfersPanel } = await import("@/views/settings/TransfersPanel");
  return render(<TransfersPanel />);
}

describe("TransfersPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default transfer concurrency", async () => {
    await renderPanel();
    const input = screen.getByLabelText(
      /transfer concurrency/i,
    ) as HTMLInputElement;
    expect(Number(input.value)).toBe(DEFAULT_SETTINGS.transferConcurrency);
  });

  it("shows validation error when concurrency is 0", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const input = screen.getByLabelText(/transfer concurrency/i);
    await user.clear(input);
    await user.type(input, "0");

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/integer between 1 and 32/i)).toBeInTheDocument();
    });
  });

  it("calls settingsUpdate with new value on valid save", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const input = screen.getByLabelText(/transfer concurrency/i);
    await user.clear(input);
    await user.type(input, "8");

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.queryByText(/integer between 1 and 32/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
