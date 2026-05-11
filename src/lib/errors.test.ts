import { describe, expect, it } from "vitest";

import {
  type AppError,
  type ErrorContext,
  isAuthError,
  isRetryable,
  isValidationError,
  present,
} from "./errors";

describe("present()", () => {
  // -----------------------------------------------------------------------
  // AC-9 full mapping
  // -----------------------------------------------------------------------

  it("Cancelled → silent (no UI surface)", () => {
    const err: AppError = {
      kind: "Cancelled",
      message: "Operation cancelled",
      retryable: false,
    };
    const policy = present(err);
    expect(policy.placement).toBe("silent");
    expect(policy.severity).toBe("info");
  });

  it("Network (retryable) → panel+toast warning", () => {
    const err: AppError = {
      kind: "Network",
      message: "Network error: connection refused",
      retryable: true,
      details: { source: "connection refused" },
    };
    const policy = present(err);
    expect(policy.placement).toBe("panel+toast");
    expect(policy.severity).toBe("warning");
  });

  it("Internal → panel+toast error (with trace ID)", () => {
    const err: AppError = {
      kind: "Internal",
      message: "Internal error (trace: uuid)",
      retryable: false,
      details: { traceId: "some-uuid" },
    };
    const policy = present(err);
    expect(policy.placement).toBe("panel+toast");
    expect(policy.severity).toBe("error");
  });

  it("RateLimited → panel+toast warning (retry-after countdown)", () => {
    const err: AppError = {
      kind: "RateLimited",
      message: "Rate limited",
      retryable: true,
      details: { retryAfterMs: 5000 },
    };
    const policy = present(err);
    expect(policy.placement).toBe("panel+toast");
    expect(policy.severity).toBe("warning");
  });

  it("Auth in background context → panel only", () => {
    const err: AppError = {
      kind: "Auth",
      message: "Authentication failed: expired",
      retryable: false,
      details: { reason: "expired" },
    };
    const policy = present(err, "background" satisfies ErrorContext);
    expect(policy.placement).toBe("panel");
    expect(policy.severity).toBe("error");
  });

  it("Auth in user-initiated context → panel+inline error", () => {
    const err: AppError = {
      kind: "Auth",
      message: "Authentication failed: expired",
      retryable: false,
      details: { reason: "expired" },
    };
    const policy = present(err, "userInitiated" satisfies ErrorContext);
    expect(policy.placement).toBe("panel+inline");
    expect(policy.severity).toBe("error");
  });

  it("Auth defaults to background (panel only)", () => {
    const err: AppError = {
      kind: "Auth",
      message: "Authentication failed: expired",
      retryable: false,
      details: { reason: "expired" },
    };
    // No context arg → defaults to "background"
    const policy = present(err);
    expect(policy.placement).toBe("panel");
    expect(policy.severity).toBe("error");
  });

  it("AccessDenied in background context → panel only", () => {
    const err: AppError = {
      kind: "AccessDenied",
      message: "Access denied to s3:GetObject on bucket/key",
      retryable: false,
      details: { op: "s3:GetObject", resource: "bucket/key" },
    };
    const policy = present(err, "background");
    expect(policy.placement).toBe("panel");
    expect(policy.severity).toBe("error");
  });

  it("AccessDenied in user-initiated context → panel+inline error", () => {
    const err: AppError = {
      kind: "AccessDenied",
      message: "Access denied to s3:PutObject",
      retryable: false,
      details: { op: "s3:PutObject", resource: "bucket/key" },
    };
    const policy = present(err, "userInitiated");
    expect(policy.placement).toBe("panel+inline");
    expect(policy.severity).toBe("error");
  });

  it("Validation in user-initiated context → inline only", () => {
    const err: AppError = {
      kind: "Validation",
      message: "Validation error on field 'name': must not be empty",
      retryable: false,
      details: { field: "name", hint: "must not be empty" },
    };
    const policy = present(err, "userInitiated");
    expect(policy.placement).toBe("inline");
    expect(policy.severity).toBe("error");
  });

  it("Validation in background context → panel+inline error", () => {
    const err: AppError = {
      kind: "Validation",
      message: "Validation error on field 'name': must not be empty",
      retryable: false,
      details: { field: "name", hint: "must not be empty" },
    };
    const policy = present(err, "background");
    expect(policy.placement).toBe("panel+inline");
    expect(policy.severity).toBe("error");
  });

  it("Conflict → panel+toast warning", () => {
    const err: AppError = {
      kind: "Conflict",
      message: "Conflict: expected ETag abc",
      retryable: false,
      details: { etagExpected: "abc", etagActual: null },
    };
    const policy = present(err);
    expect(policy.placement).toBe("panel+toast");
    expect(policy.severity).toBe("warning");
  });

  it("Unsupported → panel+toast warning", () => {
    const err: AppError = {
      kind: "Unsupported",
      message: "Unsupported op on provider",
      retryable: false,
      details: { op: "multipart", provider: "r2" },
    };
    const policy = present(err);
    expect(policy.placement).toBe("panel+toast");
    expect(policy.severity).toBe("warning");
  });

  it("ProviderSpecific → panel+toast error", () => {
    const err: AppError = {
      kind: "ProviderSpecific",
      message: "Provider error",
      retryable: false,
      details: { code: "R2_001", message: "Provider-specific error" },
    };
    const policy = present(err);
    expect(policy.placement).toBe("panel+toast");
    expect(policy.severity).toBe("error");
  });
});

describe("isRetryable()", () => {
  it("Network error is retryable", () => {
    const err: AppError = {
      kind: "Network",
      message: "Network error: timeout",
      retryable: true,
      details: { source: "timeout" },
    };
    expect(isRetryable(err)).toBe(true);
  });

  it("RateLimited is retryable", () => {
    const err: AppError = {
      kind: "RateLimited",
      message: "Rate limited",
      retryable: true,
      details: { retryAfterMs: 5000 },
    };
    expect(isRetryable(err)).toBe(true);
  });

  it("Auth is NOT retryable", () => {
    const err: AppError = {
      kind: "Auth",
      message: "Authentication failed: invalid",
      retryable: false,
      details: { reason: "invalid" },
    };
    expect(isRetryable(err)).toBe(false);
  });
});

describe("type-narrowing helpers", () => {
  it("isAuthError narrows correctly", () => {
    const err: AppError = {
      kind: "Auth",
      message: "Authentication failed: missing",
      retryable: false,
      details: { reason: "missing" },
    };
    expect(isAuthError(err)).toBe(true);
    if (isAuthError(err)) {
      // TypeScript should allow accessing err.details.reason here.
      expect(err.details.reason).toBe("missing");
    }
  });

  it("isValidationError narrows correctly", () => {
    const err: AppError = {
      kind: "Validation",
      message: "Validation error on field 'x': hint",
      retryable: false,
      details: { field: "x", hint: "hint" },
    };
    expect(isValidationError(err)).toBe(true);
    if (isValidationError(err)) {
      expect(err.details.field).toBe("x");
    }
  });

  it("isAuthError returns false for non-auth errors", () => {
    const err: AppError = {
      kind: "NotFound",
      message: "Not found: x",
      retryable: false,
      details: { resource: "x" },
    };
    expect(isAuthError(err)).toBe(false);
  });
});
