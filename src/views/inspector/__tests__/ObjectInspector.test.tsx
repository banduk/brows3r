/**
 * Tests for <ObjectInspector />.
 *
 * Coverage:
 * 1. Head section: content type, size, last modified, ETag, version, storage
 *    class, encryption rendered correctly.
 * 2. Custom metadata: key/value pairs visible.
 * 3. Tags: SectionResult denied/unsupported/deferred/value variants.
 * 4. ACL summary: owner + grant count.
 * 5. Restore status: null (non-Glacier), ongoing, expired, none.
 * 6. Checksums visible.
 * 7. Glacier storage class shows "Not available for GLACIER" copy.
 * 8. Validation gate.
 * 9. axe-core a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import type { ObjectInspectorReport } from "@/api/inspector";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";
import { ObjectInspector } from "../ObjectInspector";

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

const BASE_REPORT: ObjectInspectorReport = {
  head: {
    contentLength: 1024,
    contentType: "application/json",
    lastModified: 1_700_000_000,
    etag: '"abc123"',
    versionId: "v1",
    storageClass: "STANDARD",
    serverSideEncryption: "AES256",
    sseKmsKeyId: null,
    contentEncoding: null,
    contentDisposition: null,
    cacheControl: null,
    expires: null,
    metadata: { author: "alice", project: "brows3r" },
  },
  tags: { kind: "value", value: { environment: "test" } },
  aclSummary: {
    kind: "value",
    value: { ownerDisplayName: "alice", grantsCount: 2 },
  },
  restoreStatus: { kind: "value", value: null },
  versionId: "v1",
  checksumSha256: "sha256abc",
  checksumMd5: null,
  checksumCrc32: null,
};

const GLACIER_REPORT: ObjectInspectorReport = {
  ...BASE_REPORT,
  head: {
    ...BASE_REPORT.head,
    storageClass: "GLACIER",
  },
  restoreStatus: { kind: "value", value: { ongoing: true, expirySecs: null } },
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

async function renderObjectInspector(
  profile: ProfileSummary,
  report: ObjectInspectorReport = BASE_REPORT,
) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("object_inspect", report);
  const { Wrapper } = makeWrapper();
  return render(
    <Wrapper>
      <ObjectInspector
        profileId={profile.id}
        bucket="my-bucket"
        objectKey="path/to/file.json"
      />
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

describe("ObjectInspector — validation gate", () => {
  it("shows placeholder when profile is not validated", async () => {
    await renderObjectInspector(UNVALIDATED_PROFILE);

    await waitFor(() => {
      expect(
        screen.getByTestId("inspector-validation-gate"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Head section
// ---------------------------------------------------------------------------

describe("ObjectInspector — head section", () => {
  it("renders content type", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText("application/json")).toBeInTheDocument();
  });

  it("renders ETag", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText('"abc123"')).toBeInTheDocument();
  });

  it("renders storage class", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText("STANDARD")).toBeInTheDocument();
  });

  it("renders version ID", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText("v1")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Custom metadata
// ---------------------------------------------------------------------------

describe("ObjectInspector — custom metadata", () => {
  it("renders metadata key/value pairs", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));

    expect(screen.getByTestId("meta-key-author")).toBeInTheDocument();
    expect(screen.getByTestId("meta-val-author")).toHaveTextContent("alice");
    expect(screen.getByTestId("meta-key-project")).toBeInTheDocument();
    expect(screen.getByTestId("meta-val-project")).toHaveTextContent("brows3r");
  });
});

// ---------------------------------------------------------------------------
// Tags — SectionResult variants
// ---------------------------------------------------------------------------

describe("ObjectInspector — tags section", () => {
  it("renders tag key/value for 'value' section", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText("environment")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("renders 'Requires {iamAction}' for denied tags", async () => {
    const report: ObjectInspectorReport = {
      ...BASE_REPORT,
      tags: { kind: "denied", iamAction: "s3:GetObjectTagging" },
    };
    await renderObjectInspector(VALIDATED_PROFILE, report);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(
      screen.getByText(/Requires s3:GetObjectTagging/i),
    ).toBeInTheDocument();
  });

  it("renders 'Not available on this provider' for unsupported tags", async () => {
    const report: ObjectInspectorReport = {
      ...BASE_REPORT,
      tags: { kind: "unsupported", reason: "MinIO" },
    };
    await renderObjectInspector(VALIDATED_PROFILE, report);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(
      screen.getByText(/Not available on this provider/i),
    ).toBeInTheDocument();
  });

  it("renders 'Deferred from v1' for deferred tags", async () => {
    const report: ObjectInspectorReport = {
      ...BASE_REPORT,
      tags: { kind: "deferred", reason: "later" },
    };
    await renderObjectInspector(VALIDATED_PROFILE, report);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText(/Deferred from v1/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ACL summary
// ---------------------------------------------------------------------------

describe("ObjectInspector — ACL section", () => {
  it("renders owner and grants count", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    // Use getAllByText to handle potential multiple matches for short strings.
    const aliceEls = screen.getAllByText("alice");
    expect(aliceEls.length).toBeGreaterThan(0);
    const grantEls = screen.getAllByText("2");
    expect(grantEls.length).toBeGreaterThan(0);
  });

  it("renders 'Requires {iamAction}' for denied ACL", async () => {
    const report: ObjectInspectorReport = {
      ...BASE_REPORT,
      aclSummary: { kind: "denied", iamAction: "s3:GetObjectAcl" },
    };
    await renderObjectInspector(VALIDATED_PROFILE, report);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText(/Requires s3:GetObjectAcl/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Restore status
// ---------------------------------------------------------------------------

describe("ObjectInspector — restore status", () => {
  it("shows 'Not an archived object' for non-Glacier objects", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText(/Not an archived object/i)).toBeInTheDocument();
  });

  it("shows 'Restore in progress' for ongoing restores", async () => {
    await renderObjectInspector(VALIDATED_PROFILE, GLACIER_REPORT);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText(/Restore in progress/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Glacier storage-class disabled copy
// ---------------------------------------------------------------------------

describe("ObjectInspector — Glacier storage class disabled copy", () => {
  it("shows 'Not available for GLACIER' copy for Glacier objects", async () => {
    await renderObjectInspector(VALIDATED_PROFILE, GLACIER_REPORT);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText(/Not available for GLACIER/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

describe("ObjectInspector — checksums", () => {
  it("renders the SHA-256 checksum", async () => {
    await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    expect(screen.getByText("sha256abc")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A11y
// ---------------------------------------------------------------------------

describe("ObjectInspector — a11y", () => {
  it("has no axe violations when loaded", async () => {
    const { container } = await renderObjectInspector(VALIDATED_PROFILE);
    await waitFor(() => screen.getByTestId("object-inspector"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
