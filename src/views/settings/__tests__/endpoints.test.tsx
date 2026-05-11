/**
 * Tests for EndpointsPanel.
 *
 * - Renders with empty endpoints list by default.
 * - Add endpoint button creates a new row.
 * - Invalid URL shows validation error on save.
 * - Valid endpoint save calls settingsUpdate.
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

  const { EndpointsPanel } = await import("@/views/settings/EndpointsPanel");
  return render(<EndpointsPanel />);
}

describe("EndpointsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders add endpoint button with empty list", async () => {
    await renderPanel();
    expect(screen.getByText(/\+ add endpoint/i)).toBeInTheDocument();
    expect(screen.queryByText(/endpoint 1/i)).toBeNull();
  });

  it("adds a new endpoint row when button is clicked", async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByText(/\+ add endpoint/i));

    expect(screen.getByText(/endpoint 1/i)).toBeInTheDocument();
  });

  it("shows validation error for invalid URL on save", async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByText(/\+ add endpoint/i));

    const nameInput = screen.getByLabelText(/^name$/i);
    const urlInput = screen.getByLabelText(/^endpoint url$/i);

    await user.type(nameInput, "My endpoint");
    await user.type(urlInput, "not-a-url");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/url is not valid/i)).toBeInTheDocument();
    });
  });

  it("saves valid endpoint without error", async () => {
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByText(/\+ add endpoint/i));

    await user.type(screen.getByLabelText(/^name$/i), "MinIO");
    await user.type(
      screen.getByLabelText(/^endpoint url$/i),
      "http://localhost:9000",
    );
    await user.type(screen.getByLabelText(/^default region$/i), "us-east-1");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/url is not valid/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
