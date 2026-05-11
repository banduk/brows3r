/**
 * Tests for <Profiles /> sidebar panel.
 *
 * - Renders profile list from mock query.
 * - Shows "Add profile" button.
 * - Clicking "Add profile" opens ProfileEditor in create mode.
 * - Axe a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mock ProfileEditor so we don't pull in its query dependencies
// ---------------------------------------------------------------------------

vi.mock("@/views/settings/ProfileEditor", () => ({
  ProfileEditor: ({ mode }: { mode: string }) => (
    <div data-testid="profile-editor" data-mode={mode} />
  ),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_PROFILES: ProfileSummary[] = [
  {
    id: "p1",
    displayName: "Production",
    source: "manual",
    defaultRegion: "us-east-1",
    validatedAt: Date.now() - 1_000, // valid
    hasCompatFlags: false,
  },
  {
    id: "p2",
    displayName: "Dev",
    source: "awsCredentials",
    hasCompatFlags: false,
  },
  {
    id: "p3",
    displayName: "CI",
    source: "env",
    hasCompatFlags: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

async function renderProfiles() {
  // Lazy import so the vi.mock above is fully applied first.
  const { Profiles } = await import("@/views/sidebar/Profiles");
  const client = makeClient();
  mockInvoke("profiles_list", MOCK_PROFILES);

  const result = render(
    <QueryClientProvider client={client}>
      <Profiles />
    </QueryClientProvider>,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Profiles sidebar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders profiles from the query", async () => {
    await renderProfiles();

    await waitFor(() => {
      expect(screen.getByText("Production")).toBeInTheDocument();
    });
    expect(screen.getByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("CI")).toBeInTheDocument();
  });

  it("shows source badges", async () => {
    await renderProfiles();
    await waitFor(() => screen.getByText("Production"));

    // "Manual" badge for Production, "AWS" badge for Dev, "Env" for CI
    const manualBadges = screen.getAllByText("Manual");
    expect(manualBadges.length).toBeGreaterThanOrEqual(1);
    const awsBadges = screen.getAllByText("AWS");
    expect(awsBadges.length).toBeGreaterThanOrEqual(1);
    const envBadges = screen.getAllByText("Env");
    expect(envBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("shows Add profile button", async () => {
    await renderProfiles();
    expect(
      screen.getByRole("button", { name: /add profile/i }),
    ).toBeInTheDocument();
  });

  it("opens ProfileEditor in create mode when Add profile is clicked", async () => {
    const user = userEvent.setup();
    await renderProfiles();

    await waitFor(() => screen.getByText("Production"));

    const addBtn = screen.getByRole("button", { name: /add profile/i });
    await user.click(addBtn);

    const editor = await screen.findByTestId("profile-editor");
    expect(editor).toHaveAttribute("data-mode", "create");
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderProfiles();
    await waitFor(() => screen.getByText("Production"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
