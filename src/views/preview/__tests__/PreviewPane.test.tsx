/**
 * Tests for <PreviewPane />.
 *
 * Coverage:
 * 1. Empty state — no selection → "Select a file to preview".
 * 2. Validation gate — profile not validated → placeholder.
 * 3. MIME routing — image MIME → ImagePreview rendered.
 * 4. MIME routing — non-image MIME → stub renderer shown.
 * 5. Size-limit warning fires when contentLength > limit.
 * 6. "Preview anyway" button bypasses the size limit.
 * 7. axe-core a11y on empty state.
 * 8. axe-core a11y on size-limit warning state.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { ObjectHead } from "@/api/objects";
import type { ProfileSummary } from "@/api/profiles";
import type { Settings } from "@/api/settings";
import { usePanesStore } from "@/store/panes";
import { mockInvoke } from "@/test/mocks/tauri";
import { PreviewPane } from "../PreviewPane";

// ---------------------------------------------------------------------------
// Mock ImagePreview to keep test isolation — media server not needed here.
// ---------------------------------------------------------------------------

vi.mock("../ImagePreview", () => ({
  ImagePreview: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="image-preview-mock">{objectKey}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock TextPreview to keep test isolation — Shiki not needed here.
// ---------------------------------------------------------------------------

vi.mock("../TextPreview", () => ({
  TextPreview: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="text-preview-mock">{objectKey}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock MediaPreview to keep test isolation — media server not needed here.
// ---------------------------------------------------------------------------

vi.mock("../MediaPreview", () => ({
  MediaPreview: ({ objectKey, kind }: { objectKey: string; kind: string }) => (
    <div data-testid={`media-preview-mock-${kind}`}>{objectKey}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock new renderers to keep test isolation.
// ---------------------------------------------------------------------------

vi.mock("../PdfPreview", () => ({
  PdfPreview: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="pdf-preview-mock">{objectKey}</div>
  ),
}));

vi.mock("../MarkdownPreview", () => ({
  MarkdownPreview: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="markdown-preview-mock">{objectKey}</div>
  ),
}));

vi.mock("../HexPreview", () => ({
  HexPreview: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="hex-preview-mock">{objectKey}</div>
  ),
  base64ToUint8Array: (b64: string) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },
  formatHexRow: () => "",
}));

vi.mock("../ArchivePreview", () => ({
  ArchivePreview: ({ objectKey }: { objectKey: string }) => (
    <div data-testid="archive-preview-mock">{objectKey}</div>
  ),
  parseTarEntries: () => [],
}));

vi.mock("../TablePreview", () => ({
  TablePreview: ({ objectKey, mode }: { objectKey: string; mode: string }) => (
    <div data-testid={`table-preview-mock-${mode}`}>{objectKey}</div>
  ),
}));

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
  id: "p2",
  displayName: "Unvalidated",
  source: "manual",
  hasCompatFlags: false,
  validatedAt: undefined,
};

const IMAGE_HEAD: ObjectHead = {
  contentLength: 1024,
  contentType: "image/png",
  lastModified: null,
  etag: null,
  versionId: null,
  storageClass: null,
  serverSideEncryption: null,
  sseKmsKeyId: null,
  contentEncoding: null,
  contentDisposition: null,
  cacheControl: null,
  expires: null,
  metadata: {},
};

const TEXT_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "text/plain",
};

const VIDEO_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "video/mp4",
};

const AUDIO_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "audio/mpeg",
};

const PDF_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "application/pdf",
};

const MARKDOWN_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "text/markdown",
};

const ARCHIVE_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "application/zip",
};

const BIN_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "application/octet-stream",
};

const CSV_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "text/csv",
};

const JSON_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "application/json",
};

const NDJSON_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "application/x-ndjson",
};

const PARQUET_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "application/vnd.apache.parquet",
};

const LARGE_HEAD: ObjectHead = {
  ...IMAGE_HEAD,
  contentType: "image/png",
  // 60 MB — above the default 50 MB limit
  contentLength: 60 * 1024 * 1024,
};

const SETTINGS_50MB: Settings = {
  schemaVersion: 1,
  transferConcurrency: 4,
  cacheTtlSecs: 300,
  cacheSizeCapMb: 256,
  previewSizeLimitMb: 50,
  defaultViewMode: "Details",
  notifications: { inApp: true, osEnabled: true, sound: false },
  fallbackThresholdMb: 100,
  transferConfirmations: {
    delete: true,
    overwrite: false,
    largeUploadMb: 1024,
  },
  s3CompatibleEndpoints: [],
  autoUpdate: { enabled: true, channel: "stable" },
  diagnosticsEnabled: false,
  startupBehavior: { restoreSession: true },
  proxy: { mode: "system" },
  theme: "system",
  keyboardShortcuts: {},
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset panes store to default (no selection, no location).
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: null,
        viewMode: "Details",
        selection: new Set(),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      },
    ],
    activePaneId: "main",
  });
  mockInvoke("settings_get", SETTINGS_50MB);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Empty state
// ---------------------------------------------------------------------------

describe("PreviewPane — empty state", () => {
  it("shows Select a file to preview when nothing is selected", () => {
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );
    expect(screen.getByText(/select a file to preview/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Validation gate
// ---------------------------------------------------------------------------

describe("PreviewPane — validation gate", () => {
  it("shows validate placeholder when profile is not validated", async () => {
    // Set up pane with a location and a selection, but profile not validated.
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p2", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["photo.png"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [UNVALIDATED_PROFILE]);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/validate this profile to preview/i),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. MIME routing — image
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (image)", () => {
  it("routes image/png to ImagePreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["photo.png"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", IMAGE_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("image-preview-mock")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. MIME routing — non-image
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (non-image)", () => {
  it("routes text/plain to TextPreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["readme.txt"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", TEXT_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("text-preview-mock")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Size-limit warning
// ---------------------------------------------------------------------------

describe("PreviewPane — size limit warning", () => {
  it("shows warning when contentLength exceeds previewSizeLimitMb", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["big.png"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", LARGE_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-anyway-btn")).toBeInTheDocument();
    });
    // Warning text should mention the limit.
    expect(screen.getByText(/50 MB preview limit/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Preview anyway
// ---------------------------------------------------------------------------

describe("PreviewPane — preview anyway", () => {
  it("clicking Preview anyway shows ImagePreview for oversized image", async () => {
    const user = userEvent.setup();
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["big.png"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", LARGE_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("preview-anyway-btn")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("preview-anyway-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("image-preview-mock")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Axe-core a11y — empty state
// ---------------------------------------------------------------------------

describe("PreviewPane — a11y (empty state)", () => {
  it("has no axe violations in empty state", async () => {
    const { Wrapper } = makeWrapper();
    const { container } = render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// 4b. MIME routing — video
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (video)", () => {
  it("routes video/mp4 to MediaPreview with kind=video", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["clip.mp4"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", VIDEO_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("media-preview-mock-video"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4c. MIME routing — audio
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (audio)", () => {
  it("routes audio/mpeg to MediaPreview with kind=audio", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["song.mp3"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", AUDIO_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("media-preview-mock-audio"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Axe-core a11y — size limit warning
// ---------------------------------------------------------------------------

describe("PreviewPane — a11y (size limit warning)", () => {
  it("has no axe violations on size-limit warning state", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["big.png"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", LARGE_HEAD);

    const { Wrapper } = makeWrapper();
    const { container } = render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("preview-anyway-btn")).toBeInTheDocument(),
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// 4d. MIME routing — PDF
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (pdf)", () => {
  it("routes application/pdf to PdfPreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["report.pdf"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", PDF_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("pdf-preview-mock")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4e. MIME routing — Markdown
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (markdown)", () => {
  it("routes text/markdown to MarkdownPreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["README.md"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", MARKDOWN_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-preview-mock")).toBeInTheDocument();
    });
  });

  it("routes .md extension (octet-stream MIME) to MarkdownPreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["CHANGELOG.md"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", { ...BIN_HEAD });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-preview-mock")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4f. MIME routing — Archive
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (archive)", () => {
  it("routes application/zip to ArchivePreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["bundle.zip"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", ARCHIVE_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("archive-preview-mock")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4h. MIME routing — CSV
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (csv)", () => {
  it("routes text/csv to TablePreview with mode=csv", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["data.csv"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", CSV_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("table-preview-mock-csv")).toBeInTheDocument();
    });
  });

  it("routes .csv extension to TablePreview with mode=csv", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["report.csv"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", { ...BIN_HEAD });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("table-preview-mock-csv")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4i. MIME routing — JSON (application/json → TablePreview json mode)
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (json)", () => {
  it("routes application/json to TablePreview with mode=json", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["data.json"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", JSON_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("table-preview-mock-json")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4j. MIME routing — NDJSON
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (ndjson)", () => {
  it("routes application/x-ndjson to TablePreview with mode=ndjson", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["events.ndjson"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", NDJSON_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("table-preview-mock-ndjson"),
      ).toBeInTheDocument();
    });
  });

  it("routes .jsonl extension to TablePreview with mode=ndjson", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["logs.jsonl"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", { ...BIN_HEAD });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("table-preview-mock-ndjson"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4k. MIME routing — Parquet
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (parquet)", () => {
  it("routes application/vnd.apache.parquet to TablePreview with mode=parquet", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["data.parquet"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", PARQUET_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("table-preview-mock-parquet"),
      ).toBeInTheDocument();
    });
  });

  it("routes .parquet extension to TablePreview with mode=parquet", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["warehouse.parquet"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", { ...BIN_HEAD });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("table-preview-mock-parquet"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4g. MIME routing — Hex
// ---------------------------------------------------------------------------

describe("PreviewPane — MIME routing (hex)", () => {
  it("routes .bin extension to HexPreview", async () => {
    usePanesStore.setState({
      panes: [
        {
          id: "main",
          location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
          viewMode: "Details",
          selection: new Set(["firmware.bin"]),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
      activePaneId: "main",
    });
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("object_head", BIN_HEAD);

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <PreviewPane />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hex-preview-mock")).toBeInTheDocument();
    });
  });
});
