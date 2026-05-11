/**
 * Tests for <MediaPreview />.
 *
 * Coverage:
 * 1. Registers media on mount (calls media_register invoke).
 * 2. Revokes token on unmount (calls media_revoke invoke).
 * 3. Shows loading skeleton while URL is pending.
 * 4. Renders <video controls> for kind="video".
 * 5. Renders <audio controls> for kind="audio".
 * 6. 403/onError → calls mediaRegister again (expired-token refetch).
 * 7. media:revoked event with matching URL → refetches.
 * 8. media:revoked event with non-matching URL → does NOT refetch.
 * 9. Error slot when mediaRegister rejects.
 * 10. axe-core a11y on video element (loading state).
 * 11. axe-core a11y on audio element (loading state).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { emitEvent, mockInvoke, mockInvokeFn } from "@/test/mocks/tauri";
import { MediaPreview } from "../MediaPreview";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEDIA_URL = "http://127.0.0.1:12345/m/tok-media456";
const MEDIA_URL_2 = "http://127.0.0.1:12345/m/tok-media789";
const MEDIA_RESPONSE = {
  url: MEDIA_URL,
  expiresAt: Date.now() / 1000 + 3600,
};
const MEDIA_RESPONSE_2 = {
  url: MEDIA_URL_2,
  expiresAt: Date.now() / 1000 + 3600,
};

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

describe("MediaPreview — media registration", () => {
  it("calls media_register on mount for video", async () => {
    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    await waitFor(() => {
      const registerCalls = mockInvokeFn.mock.calls.filter(
        ([cmd]) => cmd === "media_register",
      );
      expect(registerCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("calls media_register on mount for audio", async () => {
    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="song.mp3"
        kind="audio"
      />,
    );

    await waitFor(() => {
      const registerCalls = mockInvokeFn.mock.calls.filter(
        ([cmd]) => cmd === "media_register",
      );
      expect(registerCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Revokes token on unmount
// ---------------------------------------------------------------------------

describe("MediaPreview — media revocation", () => {
  it("calls media_revoke with the token on unmount", async () => {
    const { unmount } = render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    // Wait for the URL to be set (video element should appear).
    await waitFor(() => {
      expect(screen.getByTestId("media-preview-video")).toBeInTheDocument();
    });

    unmount();

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

describe("MediaPreview — loading skeleton", () => {
  it("shows loading skeleton synchronously before URL resolves", () => {
    const { unmount } = render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    expect(screen.getByTestId("media-loading-skeleton")).toBeInTheDocument();

    unmount();
  });
});

// ---------------------------------------------------------------------------
// 4. Renders <video> for kind="video"
// ---------------------------------------------------------------------------

describe("MediaPreview — video rendering", () => {
  it("renders video element with src and controls", async () => {
    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    await waitFor(() => {
      const video = screen.queryByTestId("media-preview-video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", MEDIA_URL);
      expect(video).toHaveAttribute("controls");
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Renders <audio> for kind="audio"
// ---------------------------------------------------------------------------

describe("MediaPreview — audio rendering", () => {
  it("renders audio element with src and controls", async () => {
    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="song.mp3"
        kind="audio"
      />,
    );

    await waitFor(() => {
      const audio = screen.queryByTestId("media-preview-audio");
      expect(audio).toBeInTheDocument();
      expect(audio).toHaveAttribute("src", MEDIA_URL);
      expect(audio).toHaveAttribute("controls");
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Expired token: onError → refetch
// ---------------------------------------------------------------------------

describe("MediaPreview — expired token refetch", () => {
  it("calls mediaRegister again when video fires onError (403 scenario)", async () => {
    // First call returns MEDIA_URL; second returns MEDIA_URL_2.
    let callCount = 0;
    const originalImpl = mockInvokeFn.getMockImplementation();
    mockInvokeFn.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "media_register") {
        callCount++;
        return callCount === 1 ? MEDIA_RESPONSE : MEDIA_RESPONSE_2;
      }
      if (cmd === "media_revoke") return undefined;
      throw new Error(`[tauri mock] Unexpected command: ${cmd}`);
    });

    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    // Wait for first registration and video element.
    await waitFor(() => {
      expect(screen.getByTestId("media-preview-video")).toBeInTheDocument();
    });

    // Simulate an error event on the video (e.g. 403 from expired token).
    const video = screen.getByTestId("media-preview-video");
    fireEvent.error(video);

    // After error, mediaRegister should be called a second time.
    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    // Restore original implementation so subsequent tests are not affected.
    if (originalImpl) {
      mockInvokeFn.mockImplementation(originalImpl);
    } else {
      mockInvokeFn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. media:revoked event with matching URL → refetches
// ---------------------------------------------------------------------------

describe("MediaPreview — media:revoked event (matching URL)", () => {
  it("refetches token when media:revoked fires with our current URL", async () => {
    let registerCount = 0;
    const originalImpl = mockInvokeFn.getMockImplementation();
    mockInvokeFn.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "media_register") {
        registerCount++;
        return MEDIA_RESPONSE;
      }
      if (cmd === "media_revoke") return undefined;
      throw new Error(`[tauri mock] Unexpected command: ${cmd}`);
    });

    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    // Wait for video to render with first URL.
    await waitFor(() => {
      expect(screen.getByTestId("media-preview-video")).toBeInTheDocument();
    });

    expect(registerCount).toBe(1);

    // Emit the revoked event with our current URL.
    emitEvent("media:revoked", { url: MEDIA_URL });

    // Should trigger another mediaRegister call.
    await waitFor(() => {
      expect(registerCount).toBeGreaterThanOrEqual(2);
    });

    // Restore.
    if (originalImpl) {
      mockInvokeFn.mockImplementation(originalImpl);
    } else {
      mockInvokeFn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. media:revoked event with non-matching URL → no refetch
// ---------------------------------------------------------------------------

describe("MediaPreview — media:revoked event (non-matching URL)", () => {
  it("does not refetch when media:revoked fires with a different URL", async () => {
    let registerCount = 0;
    const originalImpl = mockInvokeFn.getMockImplementation();
    mockInvokeFn.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "media_register") {
        registerCount++;
        return MEDIA_RESPONSE;
      }
      if (cmd === "media_revoke") return undefined;
      throw new Error(`[tauri mock] Unexpected command: ${cmd}`);
    });

    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("media-preview-video")).toBeInTheDocument();
    });

    expect(registerCount).toBe(1);

    // Emit with a URL that does NOT match our token.
    emitEvent("media:revoked", { url: "http://127.0.0.1:12345/m/other-token" });

    // Give React a moment to process any potential re-render.
    await new Promise((r) => setTimeout(r, 50));

    // Count should not have changed.
    expect(registerCount).toBe(1);

    // Restore.
    if (originalImpl) {
      mockInvokeFn.mockImplementation(originalImpl);
    } else {
      mockInvokeFn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Error slot on mediaRegister rejection
// ---------------------------------------------------------------------------

describe("MediaPreview — media register error", () => {
  it("shows error when media_register fails", async () => {
    const originalImpl = mockInvokeFn.getMockImplementation();
    mockInvokeFn.mockImplementation(async (cmd: string): Promise<unknown> => {
      if (cmd === "media_register") {
        throw new Error("S3 access denied");
      }
      if (cmd === "media_revoke") return undefined;
      throw new Error(`[tauri mock] Unexpected command: ${cmd}`);
    });

    render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("media-error")).toBeInTheDocument();
    });

    // Restore.
    if (originalImpl) {
      mockInvokeFn.mockImplementation(originalImpl);
    } else {
      mockInvokeFn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. axe-core a11y — video loading state
// ---------------------------------------------------------------------------

describe("MediaPreview — a11y (video loading state)", () => {
  it("has no axe violations when rendered in loading state (video)", async () => {
    const { container, unmount } = render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="clip.mp4"
        kind="video"
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();

    unmount();
  });
});

// ---------------------------------------------------------------------------
// 11. axe-core a11y — audio loading state
// ---------------------------------------------------------------------------

describe("MediaPreview — a11y (audio loading state)", () => {
  it("has no axe violations when rendered in loading state (audio)", async () => {
    const { container, unmount } = render(
      <MediaPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="song.mp3"
        kind="audio"
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();

    unmount();
  });
});
