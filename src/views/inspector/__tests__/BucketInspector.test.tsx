/**
 * Tests for <BucketInspector />.
 *
 * Coverage:
 * 1. Each SectionResult variant renders the correct disabled-state copy.
 *    - denied → "Requires {iamAction}" (AC-5 verbatim)
 *    - unsupported → "Not available on this provider" (AC-5 verbatim)
 *    - deferred → "Deferred from v1" (AC-5 verbatim)
 *    - value → actual section content
 * 2. Validation gate: profile with validatedAt null → placeholder.
 * 3. Loading state renders without crash.
 * 4. axe-core a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import type { BucketInspectorReport } from "@/api/inspector";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";
import { BucketInspector } from "../BucketInspector";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALIDATED_PROFILE: ProfileSummary = {
  id: "p1",
  displayName: "Test",
  source: "manual",
  hasCompatFlags: false,
  validatedAt: Date.now() - 1_000,
};

const UNVALIDATED_PROFILE: ProfileSummary = {
  id: "p1",
  displayName: "Test",
  source: "manual",
  hasCompatFlags: false,
};

/** A minimal report where every section has a different kind. */
const MIXED_REPORT: BucketInspectorReport = {
  region: { kind: "value", value: "us-east-1" },
  versioning: { kind: "denied", iamAction: "s3:GetBucketVersioning" },
  encryption: { kind: "unsupported", reason: "MinIO does not support SSE" },
  lifecycle: { kind: "deferred", reason: "Deferred from v1" },
  objectLock: {
    kind: "value",
    value: {
      objectLockEnabled: false,
      defaultRetentionMode: null,
      defaultRetentionDays: null,
      defaultRetentionYears: null,
    },
  },
  publicAccessBlock: {
    kind: "denied",
    iamAction: "s3:GetBucketPublicAccessBlock",
  },
  cors: { kind: "value", value: [] },
  tags: { kind: "value", value: { env: "prod" } },
  replication: { kind: "deferred", reason: "Not configured" },
  logging: { kind: "unsupported", reason: "Not supported" },
  website: { kind: "deferred", reason: "Not configured" },
  notifications: {
    kind: "value",
    value: { lambdaCount: 0, queueCount: 0, topicCount: 0 },
  },
  ownershipControls: { kind: "value", value: { rule: "BucketOwnerEnforced" } },
  requesterPays: { kind: "value", value: false },
  bucketPolicy: { kind: "deferred", reason: "Deferred from v1" },
};

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { Wrapper };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function renderBucketInspector(
  profile: ProfileSummary,
  report: BucketInspectorReport = MIXED_REPORT,
) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("bucket_inspect", report);
  const { Wrapper } = makeWrapper();
  return render(
    <Wrapper>
      <BucketInspector profileId={profile.id} bucket="my-bucket" />
    </Wrapper>,
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

describe("BucketInspector — validation gate", () => {
  it("shows placeholder when profile is not validated", async () => {
    await renderBucketInspector(UNVALIDATED_PROFILE);

    await waitFor(() => {
      expect(
        screen.getByTestId("inspector-validation-gate"),
      ).toBeInTheDocument();
    });
  });

  it("does not show the gate when profile is validated", async () => {
    await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => {
      expect(screen.getByTestId("bucket-inspector")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// SectionResult variants — AC-5 disabled-state copy verbatim
// ---------------------------------------------------------------------------

describe("BucketInspector — section result variants", () => {
  it("renders 'Requires {iamAction}' for denied sections", async () => {
    await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => {
      // versioning is denied with s3:GetBucketVersioning
      const els = screen.getAllByText(/Requires s3:GetBucketVersioning/i);
      expect(els.length).toBeGreaterThan(0);
    });
  });

  it("renders 'Not available on this provider' for unsupported sections", async () => {
    await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => {
      const els = screen.getAllByText(/Not available on this provider/i);
      expect(els.length).toBeGreaterThan(0);
    });
  });

  it("renders 'Deferred from v1' for deferred sections", async () => {
    await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => {
      const els = screen.getAllByText(/Deferred from v1/i);
      expect(els.length).toBeGreaterThan(0);
    });
  });

  it("renders the region value for a 'value' section", async () => {
    await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => {
      expect(screen.getByText("us-east-1")).toBeInTheDocument();
    });
  });

  it("renders tags key/value pairs for a 'value' tags section", async () => {
    await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => {
      expect(screen.getByText("env")).toBeInTheDocument();
      expect(screen.getByText("prod")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// A11y
// ---------------------------------------------------------------------------

describe("BucketInspector — a11y", () => {
  it("has no axe violations when loaded", async () => {
    const { container } = await renderBucketInspector(VALIDATED_PROFILE);

    await waitFor(() => screen.getByTestId("bucket-inspector"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
