/**
 * Tests for KeychainFallbackPrompt and useKeychainFallback.
 *
 * - Prompt fires exactly once per session (second event has no effect).
 * - Passphrase submit calls keychain_fallback_unlock.
 * - Mismatch error is shown.
 * - Backend error is shown.
 * - Axe a11y assertion.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { useKeychainFallbackStore } from "@/store/keychain_fallback";
import { emitEvent, mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Wrapper that mounts both the hook and the prompt
// ---------------------------------------------------------------------------

async function renderWithHook() {
  // Reset Zustand store between tests
  useKeychainFallbackStore.setState({ hasShownKeychainFallback: false });

  const { KeychainFallbackPrompt, useKeychainFallback } = await import(
    "@/views/shell/KeychainFallbackPrompt"
  );

  function TestShell() {
    const { open, closePrompt } = useKeychainFallback();
    return <KeychainFallbackPrompt open={open} onClose={closePrompt} />;
  }

  return render(<TestShell />);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("KeychainFallbackPrompt", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Reset session state between tests.
    useKeychainFallbackStore.setState({ hasShownKeychainFallback: false });
  });

  it("is initially hidden", async () => {
    await renderWithHook();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens when keychain:fallback-required event fires", async () => {
    await renderWithHook();

    emitEvent("keychain:fallback-required", {});

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText(/keychain unavailable/i)).toBeInTheDocument();
  });

  it("fires exactly once per session (second event ignored)", async () => {
    await renderWithHook();

    emitEvent("keychain:fallback-required", {});
    await waitFor(() => screen.getByRole("dialog"));

    // Close the dialog.
    const cancelBtn = screen.getByRole("button", { name: /close/i });
    await userEvent.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Fire the event again — dialog must NOT reopen (already shown this session).
    emitEvent("keychain:fallback-required", {});
    // Give React time to potentially re-render.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls keychain_fallback_unlock on submit with matching passphrases", async () => {
    const user = userEvent.setup();
    mockInvoke("keychain_fallback_unlock", undefined);
    await renderWithHook();

    emitEvent("keychain:fallback-required", {});
    await waitFor(() => screen.getByRole("dialog"));

    await user.type(screen.getByLabelText(/^passphrase$/i), "secret123");
    await user.type(screen.getByLabelText(/confirm passphrase/i), "secret123");

    const submitBtn = screen.getByRole("button", { name: /set passphrase/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("shows error when passphrases do not match", async () => {
    const user = userEvent.setup();
    await renderWithHook();

    emitEvent("keychain:fallback-required", {});
    await waitFor(() => screen.getByRole("dialog"));

    await user.type(screen.getByLabelText(/^passphrase$/i), "secret123");
    await user.type(screen.getByLabelText(/confirm passphrase/i), "different");

    const submitBtn = screen.getByRole("button", { name: /set passphrase/i });
    await user.click(submitBtn);

    expect(
      await screen.findByText(/passphrases do not match/i),
    ).toBeInTheDocument();
    // Dialog remains open.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows backend error message when unlock fails", async () => {
    const user = userEvent.setup();
    mockInvoke(
      "keychain_fallback_unlock",
      new Error("Failed to decrypt secrets file"),
    );
    await renderWithHook();

    emitEvent("keychain:fallback-required", {});
    await waitFor(() => screen.getByRole("dialog"));

    await user.type(screen.getByLabelText(/^passphrase$/i), "wrongpass");
    await user.type(screen.getByLabelText(/confirm passphrase/i), "wrongpass");

    const submitBtn = screen.getByRole("button", { name: /set passphrase/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // Dialog remains open on error.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("has no axe accessibility violations when open", async () => {
    const { container } = await renderWithHook();

    emitEvent("keychain:fallback-required", {});
    await waitFor(() => screen.getByRole("dialog"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
