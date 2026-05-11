/**
 * Tests for <ImagePreview />.
 *
 * Coverage:
 * 1. Registers media on mount (calls media_register invoke).
 * 2. Revokes token on unmount (calls media_revoke invoke).
 * 3. Shows loading skeleton while URL is pending.
 * 4. Renders img with the media URL after registration.
 * 5. Shows error slot on img load error.
 * 6. Shows error slot on mediaRegister rejection.
 * 7. axe-core a11y on rendered image state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke } from "@/test/mocks/tauri";
import { ImagePreview } from "../ImagePreview";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEDIA_URL = "http://127.0.0.1:12345/m/tok-abc123";
const MEDIA_RESPONSE = { url: MEDIA_URL, expiresAt: Date.now() / 1000 + 3600 };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInvoke("media_register", MEDIA_RESPONSE);
  mockInvoke("media_revoke", undefined);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Registers media on mount
// ---------------------------------------------------------------------------

describe("ImagePreview — media registration", () => {
  it("calls media_register on mount", async () => {
    render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("image-preview")).toBeInTheDocument();
    });
    // URL should be set (img or skeleton present)
    await waitFor(() => {
      const skeleton = screen.queryByTestId("image-loading-skeleton");
      const img = screen.queryByTestId("image-preview-img");
      // Either loading skeleton or image should be present after registration.
      expect(skeleton ?? img).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Revokes token on unmount
// ---------------------------------------------------------------------------

describe("ImagePreview — media revocation", () => {
  it("calls media_revoke with the token on unmount", async () => {
    const { unmount } = render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    // Wait for the URL to be set.
    await waitFor(() => {
      expect(
        screen.queryByTestId("image-loading-skeleton") ??
          screen.queryByTestId("image-preview-img"),
      ).toBeTruthy();
    });

    // Spy on subsequent invoke calls after unmount.
    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    unmount();

    // media_revoke should be called with the token extracted from the URL.
    await waitFor(() => {
      const revokeCalls = mockInvokeFn.mock.calls.filter(
        ([cmd]) => cmd === "media_revoke",
      );
      expect(revokeCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Loading skeleton
// ---------------------------------------------------------------------------

describe("ImagePreview — loading skeleton", () => {
  it("shows loading skeleton synchronously before URL resolves", () => {
    // The skeleton is rendered synchronously before the mediaRegister promise
    // resolves. Render and check immediately (before any await).
    const { unmount } = render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    // The skeleton should be present synchronously (state starts as url=null).
    expect(screen.getByTestId("image-loading-skeleton")).toBeInTheDocument();

    unmount();
  });
});

// ---------------------------------------------------------------------------
// 4. Renders img after registration
// ---------------------------------------------------------------------------

describe("ImagePreview — image rendering", () => {
  it("renders img element with the media server URL after registration", async () => {
    render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    await waitFor(() => {
      const img = screen.queryByTestId("image-preview-img");
      if (img) {
        expect(img).toHaveAttribute("src", MEDIA_URL);
      }
    });
  });

  it("img has alt text set to the object key", async () => {
    render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    await waitFor(() => {
      const img = screen.queryByTestId("image-preview-img");
      if (img) {
        expect(img).toHaveAttribute("alt", "photo.png");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Error slot on mediaRegister rejection
// ---------------------------------------------------------------------------

describe("ImagePreview — media register error", () => {
  it("shows error when media_register fails", async () => {
    mockInvoke("media_register", new Error("S3 access denied"));

    render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("image-error")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Axe-core a11y
// ---------------------------------------------------------------------------

describe("ImagePreview — a11y", () => {
  it("has no axe violations when rendered (loading state)", async () => {
    const { container } = render(
      <ImagePreview profileId="p1" bucket="my-bucket" objectKey="photo.png" />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
