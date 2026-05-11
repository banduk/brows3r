/**
 * Tests for ShortcutsPanel.
 *
 * Includes the REQUIRED cross-layer shortcut snapshot (round-2 finding #1):
 * - Imports the fixture from task 16's exact path.
 * - Asserts that loading default settings produces a shortcut map structurally
 *   equal to `baseline.shortcuts`.
 *
 * Per round-3 finding #3: the fixture MUST be imported from
 * `@/commands/__fixtures__/baseline-shortcuts.proposal.json` — copying inline
 * is rejected so a future fixture move surfaces as a compile/test failure.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
// Cross-layer snapshot import — exact path per task 16. Do NOT copy inline.
import baseline from "@/commands/__fixtures__/baseline-shortcuts.proposal.json";
import { BASELINE_SHORTCUTS } from "@/commands/shortcuts";
import { DEFAULT_SETTINGS } from "@/store/settings";
import { mockInvoke } from "@/test/mocks/tauri";

async function renderPanel() {
  mockInvoke("settings_get", DEFAULT_SETTINGS);
  mockInvoke("settings_update", DEFAULT_SETTINGS);

  const { useSettingsStore } = await import("@/store/settings");
  useSettingsStore.setState({ settings: null, loading: false, error: null });

  const { ShortcutsPanel } = await import("@/views/settings/ShortcutsPanel");
  return render(<ShortcutsPanel />);
}

describe("ShortcutsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // Cross-layer shortcut snapshot (round-2 finding #1, round-3 finding #3)
  // ---------------------------------------------------------------------------

  it("BASELINE_SHORTCUTS structurally matches baseline-shortcuts.proposal.json", () => {
    // The fixture keys are the ground truth from the approved proposal.
    const fixtureKeys = Object.keys(baseline.shortcuts);
    const runtimeKeys = Object.keys(BASELINE_SHORTCUTS);

    // Same set of command ids.
    expect(runtimeKeys.sort()).toEqual(fixtureKeys.sort());

    // Each binding matches structurally.
    for (const commandId of fixtureKeys) {
      const fixtureBinding =
        baseline.shortcuts[commandId as keyof typeof baseline.shortcuts];
      const runtimeBinding = BASELINE_SHORTCUTS[commandId];

      expect(
        runtimeBinding,
        `Missing runtime binding for ${commandId}`,
      ).toBeDefined();

      // mac binding key matches.
      expect(runtimeBinding?.mac.key, `mac.key mismatch for ${commandId}`).toBe(
        fixtureBinding.mac.key,
      );

      // default binding key matches.
      expect(
        runtimeBinding?.default.key,
        `default.key mismatch for ${commandId}`,
      ).toBe(fixtureBinding.default.key);

      // mac modifier list matches (order-independent).
      // Cast to allow optional mod since JSON types don't guarantee its presence.
      const fixtureMacBinding = fixtureBinding.mac as {
        key: string;
        mod?: string[];
      };
      const fixtureDefaultBinding = fixtureBinding.default as {
        key: string;
        mod?: string[];
      };
      const fixtureMacMods = [...(fixtureMacBinding.mod ?? [])].sort();
      const runtimeMacMods = [...(runtimeBinding?.mac.mod ?? [])].sort();
      expect(runtimeMacMods, `mac.mod mismatch for ${commandId}`).toEqual(
        fixtureMacMods,
      );

      // default modifier list matches.
      const fixtureDefaultMods = [...(fixtureDefaultBinding.mod ?? [])].sort();
      const runtimeDefaultMods = [
        ...(runtimeBinding?.default.mod ?? []),
      ].sort();
      expect(
        runtimeDefaultMods,
        `default.mod mismatch for ${commandId}`,
      ).toEqual(fixtureDefaultMods);
    }
  });

  // ---------------------------------------------------------------------------
  // Panel render tests
  // ---------------------------------------------------------------------------

  it("renders the shortcut table with all baseline commands", async () => {
    await renderPanel();

    // Each command id from the baseline should appear in the table.
    const commandIds = Object.keys(BASELINE_SHORTCUTS);
    for (const id of commandIds) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
  });

  it("override input updates the field value", async () => {
    const user = userEvent.setup();
    await renderPanel();

    // Find the first override input.
    const firstCommandId = Object.keys(BASELINE_SHORTCUTS)[0];
    const overrideInput = screen.getByLabelText(
      new RegExp(`Override shortcut for ${firstCommandId}`, "i"),
    ) as HTMLInputElement;

    await user.clear(overrideInput);
    await user.type(overrideInput, "Ctrl+K");

    expect(overrideInput.value).toBe("Ctrl+K");
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ---------------------------------------------------------------------------
  // Conflict UI tests (task 57)
  // ---------------------------------------------------------------------------

  it("shows conflict badge when detectConflicts returns a conflict", async () => {
    // Inject a mock registry with a known conflict.
    const conflictingRegistry = {
      detectConflicts: vi.fn(() => ({
        conflicts: [
          {
            shortcut: { key: "k", mod: ["cmd"] },
            commandIds: ["cmd.a", "cmd.b"],
          },
        ],
      })),
    };

    vi.doMock("@/commands/conflicts", () => ({
      detectConflicts: vi.fn((_reg: unknown, _platform: unknown) =>
        conflictingRegistry.detectConflicts(),
      ),
    }));

    vi.doMock("@/commands/registry", () => ({
      registry: {},
    }));

    // Re-import panel with the mocked modules.
    vi.resetModules();
    const { ShortcutsPanel } = await import("@/views/settings/ShortcutsPanel");
    mockInvoke("settings_get", DEFAULT_SETTINGS);
    mockInvoke("settings_update", DEFAULT_SETTINGS);
    const { useSettingsStore: store } = await import("@/store/settings");
    store.setState({ settings: null, loading: false, error: null });

    render(<ShortcutsPanel />);

    // Conflict alert banner should appear.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // "Resolve" button should be present.
    expect(
      screen.getByRole("button", { name: /resolve conflict/i }),
    ).toBeInTheDocument();
  });

  it("opens Resolve modal when Resolve button is clicked", async () => {
    const conflictingRegistry = {
      detectConflicts: vi.fn(() => ({
        conflicts: [
          {
            shortcut: { key: "k", mod: ["cmd"] },
            commandIds: ["cmd.a", "cmd.b"],
          },
        ],
      })),
    };

    vi.doMock("@/commands/conflicts", () => ({
      detectConflicts: vi.fn((_reg: unknown, _platform: unknown) =>
        conflictingRegistry.detectConflicts(),
      ),
    }));

    vi.doMock("@/commands/registry", () => ({
      registry: {},
    }));

    vi.resetModules();
    const { ShortcutsPanel } = await import("@/views/settings/ShortcutsPanel");
    mockInvoke("settings_get", DEFAULT_SETTINGS);
    mockInvoke("settings_update", DEFAULT_SETTINGS);
    const { useSettingsStore: store } = await import("@/store/settings");
    store.setState({ settings: null, loading: false, error: null });

    const user = userEvent.setup();
    render(<ShortcutsPanel />);

    const resolveBtn = await screen.findByRole("button", {
      name: /resolve conflict/i,
    });
    await user.click(resolveBtn);

    // Modal should be open.
    expect(
      screen.getByRole("dialog", { name: /resolve shortcut conflict/i }),
    ).toBeInTheDocument();
    // Both command ids should be visible.
    expect(screen.getByText("cmd.a")).toBeInTheDocument();
    expect(screen.getByText("cmd.b")).toBeInTheDocument();
  });
});
