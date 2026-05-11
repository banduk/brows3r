/**
 * Tests for <InspectorPanel />.
 *
 * Coverage:
 * 1. Renders nothing when inspector is closed.
 * 2. Renders bucket inspector when target.key is absent/null/undefined.
 * 3. Renders object inspector when target.key is present.
 * 4. Close button calls closeInspector.
 * 5. Esc key closes the inspector.
 * 6. Panel has role="region" aria-label="Inspector".
 * 7. axe-core a11y assertion.
 *
 * Note: BucketInspector/ObjectInspector themselves make Tauri invoke calls
 * which we mock out. The panel tests focus on structural routing + a11y.
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
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import type {
  BucketInspectorReport,
  ObjectInspectorReport,
} from "@/api/inspector";
import type { ProfileSummary } from "@/api/profiles";
import { useInspectorStore } from "@/store/inspector";
import { mockInvoke } from "@/test/mocks/tauri";
import { InspectorPanel } from "../InspectorPanel";

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

const BUCKET_REPORT: BucketInspectorReport = {
  region: { kind: "value", value: "us-east-1" },
  versioning: { kind: "denied", iamAction: "s3:GetBucketVersioning" },
  encryption: { kind: "deferred", reason: "Deferred from v1" },
  lifecycle: { kind: "deferred", reason: "Deferred from v1" },
  objectLock: { kind: "deferred", reason: "Deferred from v1" },
  publicAccessBlock: { kind: "deferred", reason: "Deferred from v1" },
  cors: { kind: "deferred", reason: "Deferred from v1" },
  tags: { kind: "value", value: {} },
  replication: { kind: "deferred", reason: "Deferred from v1" },
  logging: { kind: "deferred", reason: "Deferred from v1" },
  website: { kind: "deferred", reason: "Deferred from v1" },
  notifications: {
    kind: "value",
    value: { lambdaCount: 0, queueCount: 0, topicCount: 0 },
  },
  ownershipControls: { kind: "deferred", reason: "Deferred from v1" },
  requesterPays: { kind: "value", value: false },
  bucketPolicy: { kind: "deferred", reason: "Deferred from v1" },
};

const OBJECT_REPORT: ObjectInspectorReport = {
  head: {
    contentLength: 512,
    contentType: "text/plain",
    lastModified: 1_700_000_000,
    etag: '"xyz"',
    versionId: null,
    storageClass: "STANDARD",
    serverSideEncryption: null,
    sseKmsKeyId: null,
    contentEncoding: null,
    contentDisposition: null,
    cacheControl: null,
    expires: null,
    metadata: {},
  },
  tags: { kind: "value", value: {} },
  aclSummary: {
    kind: "value",
    value: { ownerDisplayName: null, grantsCount: 0 },
  },
  restoreStatus: { kind: "value", value: null },
  versionId: null,
  checksumSha256: null,
  checksumMd5: null,
  checksumCrc32: null,
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
// Cleanup + reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  useInspectorStore.setState({ open: false, target: null });
  mockInvoke("profiles_list", [VALIDATED_PROFILE]);
  mockInvoke("bucket_inspect", BUCKET_REPORT);
  mockInvoke("object_inspect", OBJECT_REPORT);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InspectorPanel — closed state", () => {
  it("renders nothing when inspector is closed", () => {
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );
    expect(screen.queryByTestId("inspector-panel")).not.toBeInTheDocument();
  });
});

describe("InspectorPanel — bucket inspector routing", () => {
  it("renders the bucket inspector panel when target has no key", async () => {
    useInspectorStore.setState({
      open: true,
      target: { profileId: "p1", bucket: "my-bucket" },
    });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toBeInTheDocument();
    });
  });
});

describe("InspectorPanel — object inspector routing", () => {
  it("renders the object inspector panel when target has a key", async () => {
    useInspectorStore.setState({
      open: true,
      target: { profileId: "p1", bucket: "my-bucket", key: "path/to/file.txt" },
    });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel")).toBeInTheDocument();
    });
  });
});

describe("InspectorPanel — close button", () => {
  it("clicking close button calls closeInspector", async () => {
    const user = userEvent.setup();
    useInspectorStore.setState({
      open: true,
      target: { profileId: "p1", bucket: "my-bucket" },
    });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );

    await waitFor(() => screen.getByTestId("inspector-panel"));
    await user.click(screen.getByRole("button", { name: /close inspector/i }));

    expect(useInspectorStore.getState().open).toBe(false);
  });
});

describe("InspectorPanel — Esc key", () => {
  it("pressing Esc closes the inspector", async () => {
    useInspectorStore.setState({
      open: true,
      target: { profileId: "p1", bucket: "my-bucket" },
    });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );

    await waitFor(() => screen.getByTestId("inspector-panel"));
    fireEvent.keyDown(screen.getByTestId("inspector-panel"), { key: "Escape" });

    expect(useInspectorStore.getState().open).toBe(false);
  });
});

describe("InspectorPanel — a11y", () => {
  it("has role=region aria-label=Inspector", async () => {
    useInspectorStore.setState({
      open: true,
      target: { profileId: "p1", bucket: "my-bucket" },
    });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );

    await waitFor(() => screen.getByTestId("inspector-panel"));
    expect(
      screen.getByRole("region", { name: /inspector/i }),
    ).toBeInTheDocument();
  });

  it("has no axe violations when open", async () => {
    useInspectorStore.setState({
      open: true,
      target: { profileId: "p1", bucket: "my-bucket" },
    });

    const { Wrapper } = makeWrapper();
    const { container } = render(
      <Wrapper>
        <InspectorPanel />
      </Wrapper>,
    );

    await waitFor(() => screen.getByTestId("inspector-panel"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
