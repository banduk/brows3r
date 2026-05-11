/**
 * Tests for CachePanel.
 *
 * - Renders with default cache values.
 * - TTL above range shows validation error.
 * - Valid values save without error.
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

  const { CachePanel } = await import("@/views/settings/CachePanel");
  return render(<CachePanel />);
}

describe("CachePanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders with default cache TTL and size values", async () => {
    await renderPanel();

    const ttlInput = screen.getByLabelText(/cache ttl/i) as HTMLInputElement;
    expect(Number(ttlInput.value)).toBe(DEFAULT_SETTINGS.cacheTtlSecs);

    const sizeInput = screen.getByLabelText(
      /cache size cap/i,
    ) as HTMLInputElement;
    expect(Number(sizeInput.value)).toBe(DEFAULT_SETTINGS.cacheSizeCapMb);
  });

  it("shows validation error when TTL exceeds maximum", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const ttlInput = screen.getByLabelText(/cache ttl/i);
    await user.clear(ttlInput);
    await user.type(ttlInput, "9999");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/between 0 and 3600/i)).toBeInTheDocument();
    });
  });

  it("saves valid cache settings without error", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const ttlInput = screen.getByLabelText(/cache ttl/i);
    await user.clear(ttlInput);
    await user.type(ttlInput, "120");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/between 0 and 3600/i)).toBeNull();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
