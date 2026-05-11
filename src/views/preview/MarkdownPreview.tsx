/**
 * MarkdownPreview — renders an S3 Markdown file with GFM + syntax highlighting.
 *
 * Lifecycle:
 *  1. Mount: fetch body via `objectGetText`.
 *  2. Render: react-markdown with remark-gfm + rehype-highlight + rehype-sanitize.
 *  3. Headings receive auto-generated `id` anchors for in-page linking.
 *
 * Image src rewriting:
 *  v1 renders image srcs as-is.  Absolute URLs work; relative paths show broken.
 *  Future: resolve relative paths to S3 presigned URLs.
 *
 * Sanitization:
 *  rehype-sanitize runs last so user-controlled HTML cannot escape the sandbox.
 *
 * OCP: the remark/rehype plugin chain can be extended (e.g. mermaid, footnotes)
 * without touching any other renderer.
 */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { objectGetText } from "@/api/objects";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// MarkdownPreview
// ---------------------------------------------------------------------------

export function MarkdownPreview({
  profileId,
  bucket,
  objectKey,
}: MarkdownPreviewProps): React.ReactElement {
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch on mount / key change.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setLoadError(null);
    setTruncated(false);

    objectGetText(profileId, bucket, objectKey)
      .then((payload) => {
        if (cancelled) return;
        setBody(payload.body);
        setTruncated(payload.truncated);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load markdown",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profileId, bucket, objectKey]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col" data-testid="markdown-preview">
      {/* Loading skeleton */}
      {body === null && !loadError && (
        <div
          role="status"
          aria-label="Loading markdown"
          className="flex flex-1 flex-col gap-2 p-4"
          data-testid="markdown-loading-skeleton"
        >
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      )}

      {/* Error slot */}
      {loadError && (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-4"
          data-testid="markdown-error"
        >
          <p className="text-sm text-destructive">{loadError}</p>
        </div>
      )}

      {/* Truncation banner */}
      {truncated && (
        <div
          role="status"
          className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="markdown-truncated-banner"
        >
          Content truncated — download the file to see the full document.
        </div>
      )}

      {/* Rendered markdown */}
      {body !== null && !loadError && (
        <article
          className="prose prose-sm dark:prose-invert min-h-0 flex-1 overflow-auto p-4"
          data-testid="markdown-content"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight, rehypeSanitize]}
            components={{
              // Add id anchors to headings for in-page linking.
              h1: ({ children, ...props }) => {
                const id = headingId(children);
                return (
                  <h1 id={id} {...props}>
                    {children}
                  </h1>
                );
              },
              h2: ({ children, ...props }) => {
                const id = headingId(children);
                return (
                  <h2 id={id} {...props}>
                    {children}
                  </h2>
                );
              },
              h3: ({ children, ...props }) => {
                const id = headingId(children);
                return (
                  <h3 id={id} {...props}>
                    {children}
                  </h3>
                );
              },
            }}
          >
            {body}
          </ReactMarkdown>
        </article>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive an anchor-safe `id` from heading children text.
 *
 * Converts to lowercase, replaces non-alphanumeric runs with hyphens,
 * and trims leading/trailing hyphens.
 */
function headingId(children: React.ReactNode): string {
  const text =
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.join("")
        : "";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
