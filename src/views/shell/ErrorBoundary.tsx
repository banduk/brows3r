/**
 * ErrorBoundary — recovery-friendly error guard.
 *
 * React 19 has no built-in error boundary primitive, so the "white/black
 * screen on a thrown render" failure mode is on us. This component
 * catches descendant render/lifecycle exceptions and shows a recoverable
 * message + retry button instead of leaving the user staring at an empty
 * viewport with no idea what broke.
 *
 * Variants:
 * - `scope="root"`  full-screen banner with the stack expandable; the
 *   "Reset app state" button clears localStorage and reloads.
 * - default        compact in-place banner — used for the main pane only.
 *
 * When `resetKey` changes the boundary auto-clears any caught error so
 * navigating away from the broken view recovers without a manual click.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * GitHub repo slug used to build the "Open issue on GitHub" URL.
 * Update when the canonical repo location changes.
 */
const GITHUB_REPO = "banduk/brows3r";

interface ErrorBoundaryProps {
  /** When this value changes, the boundary's caught error is cleared. */
  resetKey?: string | number | null;
  /** "root" gives the full-screen banner with a localStorage reset action. */
  scope?: "root" | "default";
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    componentStack: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console-log so the dev tools have something to inspect; the user-facing
    // surface stays short by default.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: null, copied: false });
    }
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null, copied: false });
  };

  resetAndReload = (): void => {
    try {
      // Wipe persisted UI/settings so a corrupt state cannot reproduce
      // the crash on the next launch. Best-effort — survives the catch
      // even if localStorage is locked.
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  /**
   * Build the plain-text error report copied to clipboard / embedded in the
   * GitHub issue body. Single source of truth so both surfaces stay in sync.
   */
  private buildReport(): string {
    const { error, componentStack } = this.state;
    if (!error) return "";
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "n/a";
    const url = typeof window !== "undefined" ? window.location.href : "n/a";
    return [
      `Message: ${error.message}`,
      `URL: ${url}`,
      `User-Agent: ${ua}`,
      `Time: ${new Date().toISOString()}`,
      "",
      "Stack:",
      error.stack ?? "(no stack)",
      "",
      "Component stack:",
      componentStack ?? "(no component stack)",
    ].join("\n");
  }

  copyReport = async (): Promise<void> => {
    const report = this.buildReport();
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Clipboard API can fail in restricted contexts — fall back to a
      // hidden textarea + execCommand("copy") as a best-effort second try.
      try {
        const ta = document.createElement("textarea");
        ta.value = report;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        this.setState({ copied: true });
        window.setTimeout(() => this.setState({ copied: false }), 2000);
      } catch {
        /* give up silently */
      }
    }
  };

  openGithubIssue = (): void => {
    const { error } = this.state;
    if (!error) return;
    const report = this.buildReport();
    const title = `[bug] ${error.message.slice(0, 100)}`;
    const body = [
      "## What happened",
      "<!-- Describe what you were doing when the error appeared. -->",
      "",
      "## Steps to reproduce",
      "1. ",
      "2. ",
      "3. ",
      "",
      "## Error details",
      "```",
      report,
      "```",
    ].join("\n");
    const url = new URL(`https://github.com/${GITHUB_REPO}/issues/new`);
    url.searchParams.set("title", title);
    url.searchParams.set("body", body);
    url.searchParams.set("labels", "bug,auto-report");
    // Open via plain window.open — works both in the Tauri WebView (where it
    // delegates to the system browser) and in plain dev mode.
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const isRoot = this.props.scope === "root";

    return (
      <div
        role="alert"
        className={
          isRoot
            ? "fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-4 overflow-auto bg-background p-8 text-center"
            : "flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
        }
      >
        <p className="text-base font-semibold text-destructive">
          {isRoot
            ? "brows3r hit an unexpected error."
            : "Something went wrong rendering this view."}
        </p>
        <p className="max-w-xl text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred."}
        </p>
        <details className="max-w-xl rounded-md border border-border bg-muted/30 p-2 text-left text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">Stack trace</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">
            {error.stack ?? error.message}
            {componentStack && `\n\nComponent stack:${componentStack}`}
          </pre>
        </details>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => void this.copyReport()}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
            aria-live="polite"
          >
            {this.state.copied ? "Copied!" : "Copy error"}
          </button>
          <button
            type="button"
            onClick={this.openGithubIssue}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            Report on GitHub
          </button>
          {isRoot && (
            <button
              type="button"
              onClick={this.resetAndReload}
              className="rounded-md border border-destructive bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20"
            >
              Reset app state and reload
            </button>
          )}
        </div>
      </div>
    );
  }
}
