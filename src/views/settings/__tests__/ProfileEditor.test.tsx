/**
 * Tests for <ProfileEditor /> modal.
 *
 * - Create mode: fields validate, submit calls profileCreateManual.
 * - Edit mode: submit calls profileUpdate, validate button disables during in-flight.
 * - Axe a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type {
  ProfileDetail,
  ProfileSummary,
  ValidationReport,
} from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mock ProfileEditor in isolation
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

async function renderEditor(
  mode: "create" | "edit",
  profileId?: string,
  extraMocks: Record<string, unknown> = {},
) {
  for (const [cmd, response] of Object.entries(extraMocks)) {
    mockInvoke(cmd, response);
  }

  const { ProfileEditor } = await import("@/views/settings/ProfileEditor");
  const client = makeClient();
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  const result = render(
    <QueryClientProvider client={client}>
      <ProfileEditor
        mode={mode}
        profileId={profileId}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </QueryClientProvider>,
  );

  return { ...result, onClose, onSuccess };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const MOCK_PROFILE_DETAIL: ProfileDetail = {
  id: "p-edit",
  displayName: "My Profile",
  source: "manual",
  defaultRegion: "eu-west-1",
  validatedAt: undefined,
  compatFlags: {},
};

const MOCK_SUMMARY: ProfileSummary = {
  id: "p-edit",
  displayName: "My Profile",
  source: "manual",
  hasCompatFlags: false,
};

const MOCK_VALIDATION_REPORT: ValidationReport = {
  profileId: "p-edit",
  ok: true,
  accountId: "123456789012",
  arn: "arn:aws:iam::123456789012:user/test",
  validatedAt: Date.now(),
  providerKind: "aws",
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ProfileEditor — create mode", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders create form with required fields", async () => {
    await renderEditor("create");

    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/access key id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/secret access key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/session token/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/default region/i)).toBeInTheDocument();
  });

  it("shows validation errors when required fields are empty", async () => {
    const user = userEvent.setup();
    await renderEditor("create");

    const submitBtn = screen.getByRole("button", { name: /create profile/i });
    await user.click(submitBtn);

    expect(
      await screen.findByText(/display name is required/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/access key id is required/i)).toBeInTheDocument();
    expect(
      screen.getByText(/secret access key is required/i),
    ).toBeInTheDocument();
  });

  it("calls profile_create_manual on valid submit", async () => {
    const user = userEvent.setup();
    const { onSuccess } = await renderEditor("create", undefined, {
      profile_create_manual: MOCK_SUMMARY,
    });

    await user.type(screen.getByLabelText(/display name/i), "My New Profile");
    await user.type(
      screen.getByLabelText(/access key id/i),
      "AKIAIOSFODNN7EXAMPLE",
    );
    await user.type(
      screen.getByLabelText(/secret access key/i),
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );

    const submitBtn = screen.getByRole("button", { name: /create profile/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderEditor("create");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("ProfileEditor — edit mode", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads and displays existing profile data", async () => {
    await renderEditor("edit", "p-edit", {
      profile_get: MOCK_PROFILE_DETAIL,
    });

    // Wait for profile data to populate the form.
    await waitFor(() => {
      const nameInput = screen.getByLabelText(
        /display name/i,
      ) as HTMLInputElement;
      expect(nameInput.value).toBe("My Profile");
    });
  });

  it("does not show secret fields in edit mode", async () => {
    await renderEditor("edit", "p-edit", {
      profile_get: MOCK_PROFILE_DETAIL,
    });

    // Secret fields must not be present.
    expect(screen.queryByLabelText(/access key id/i)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/secret access key/i),
    ).not.toBeInTheDocument();
  });

  it("shows validation button in edit mode", async () => {
    await renderEditor("edit", "p-edit", {
      profile_get: MOCK_PROFILE_DETAIL,
    });

    expect(
      screen.getByRole("button", { name: /validate credentials/i }),
    ).toBeInTheDocument();
  });

  it("disables validate button while validation is in flight", async () => {
    const user = userEvent.setup();

    // Register profile_get so the edit form loads.
    mockInvoke("profile_get", MOCK_PROFILE_DETAIL);

    // Use a deferred promise for profile_validate via mockInvoke with a
    // special value: register it with a Promise that we control.
    // We do NOT override mockInvokeFn globally (that would affect later tests).
    // Instead, register profile_validate with a pending promise — the mock
    // framework resolves it when it's retrieved.
    let resolveValidation!: (value: ValidationReport) => void;
    const pendingValidation = new Promise<ValidationReport>((resolve) => {
      resolveValidation = resolve;
    });
    // Register the pending promise as the response; the mock will await it.
    mockInvoke(
      "profile_validate",
      pendingValidation as unknown as ValidationReport,
    );

    const { ProfileEditor } = await import("@/views/settings/ProfileEditor");
    const client = makeClient();

    render(
      <QueryClientProvider client={client}>
        <ProfileEditor
          mode="edit"
          profileId="p-edit"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const validateBtn = await screen.findByRole("button", {
      name: /validate credentials/i,
    });
    await user.click(validateBtn);

    // Should be disabled while in-flight.
    await waitFor(() => {
      expect(validateBtn).toBeDisabled();
    });

    // Resolve and check it re-enables.
    resolveValidation(MOCK_VALIDATION_REPORT);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /validate credentials/i }),
      ).not.toBeDisabled();
    });
  });

  it("calls profile_update on save", async () => {
    const user = userEvent.setup();
    const { onSuccess } = await renderEditor("edit", "p-edit", {
      profile_get: MOCK_PROFILE_DETAIL,
      profile_update: MOCK_SUMMARY,
    });

    await waitFor(() => {
      const nameInput = screen.getByLabelText(
        /display name/i,
      ) as HTMLInputElement;
      expect(nameInput.value).toBe("My Profile");
    });

    const nameInput = screen.getByLabelText(/display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Profile");

    // Use fireEvent.submit on the form since the submit button is inside a
    // Radix UI Dialog portal and userEvent.click may not propagate the submit
    // event in jsdom.
    const form = screen.getByRole("dialog").querySelector("form");
    if (form === null) throw new Error("form not found in dialog");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
    });
  });
});
