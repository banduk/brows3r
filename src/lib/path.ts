/**
 * Path encoding/decoding utilities — frontend mirror of `src-tauri/src/path/encode.rs`.
 *
 * The frontend often needs these locally (breadcrumb rendering, Copy Path) without
 * an IPC round-trip. Algorithms are kept simple and must stay in sync with the
 * Rust implementations.
 *
 * Three distinct output forms:
 * - `toCanonicalUri`   — `brows3r://<profile_id>/<bucket>/<key>` (stable, unambiguous)
 * - `toDisplayPath`    — `DisplayPath` for breadcrumb UI (human-readable, not encoded)
 * - `toClipboardString` — `s3://<bucket>/<key>` for aws-cli paste
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface S3Location {
  profileId: string;
  bucket: string;
  /** Current virtual-directory prefix. Empty string = bucket root. */
  prefix: string;
  /** Specific object key. `null` when the location refers to a prefix. */
  key: string | null;
}

export interface DisplayPath {
  profileDisplayName: string;
  bucket: string;
  /** Breadcrumb segments, split on `/`, empty strings removed. */
  segments: string[];
}

// ---------------------------------------------------------------------------
// Percent-encoding helpers
// ---------------------------------------------------------------------------

/**
 * Percent-encode a string using a strict allowlist: `[A-Za-z0-9]` is kept
 * as-is; everything else (including `/`) is encoded as `%XX`.
 */
function encodeNoSlash(input: string): string {
  // encodeURIComponent leaves `[A-Za-z0-9\-_.!~*'()]` un-encoded.
  // We want stricter encoding matching Rust's NON_ALPHANUMERIC set, so we
  // additionally encode the chars that encodeURIComponent leaves alone.
  return encodeURIComponent(input).replace(/[!'()*\-._~]/g, (c) => {
    return `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

/**
 * Percent-encode a string, encoding all non-alphanumeric chars EXCEPT `/`.
 * Path slashes are preserved as literal `/` for S3 hierarchy readability.
 */
function encodePreserveSlash(input: string): string {
  return input
    .split("/")
    .map((segment) => encodeNoSlash(segment))
    .join("/");
}

/**
 * Percent-decode a URI component.
 * Returns `null` on malformed sequences.
 */
function decodeComponent(input: string): string | null {
  try {
    return decodeURIComponent(input);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// toCanonicalUri
// ---------------------------------------------------------------------------

/**
 * Encode an `S3Location` into its canonical `brows3r://` URI.
 *
 * The canonical form embeds the stable `profileId` (not the display name) so
 * two profiles with identical display names produce different URIs (AC-2).
 */
export function toCanonicalUri(loc: S3Location): string {
  const encodedBucket = encodeNoSlash(loc.bucket);
  const keyStr = loc.key ?? loc.prefix;
  const encodedKey = encodePreserveSlash(keyStr);
  return `brows3r://${loc.profileId}/${encodedBucket}/${encodedKey}`;
}

// ---------------------------------------------------------------------------
// fromCanonicalUri
// ---------------------------------------------------------------------------

export interface ParseError {
  field: string;
  hint: string;
}

/**
 * Parse a `brows3r://` URI back into an `S3Location`.
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, error }` on
 * malformed input (wrong scheme, empty profile id, missing bucket).
 */
export function fromCanonicalUri(
  uri: string,
): { ok: true; value: S3Location } | { ok: false; error: ParseError } {
  const scheme = "brows3r://";
  if (!uri.startsWith(scheme)) {
    return {
      ok: false,
      error: { field: "uri", hint: "URI must begin with brows3r://" },
    };
  }

  const rest = uri.slice(scheme.length);
  // Split into at most 3 parts: profileId / bucket / key
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) {
    return {
      ok: false,
      error: { field: "uri", hint: "bucket must not be empty" },
    };
  }

  const profileId = rest.slice(0, slashIdx);
  if (profileId === "") {
    return {
      ok: false,
      error: { field: "uri", hint: "profile_id must not be empty" },
    };
  }

  const afterProfile = rest.slice(slashIdx + 1);
  const bucketSlashIdx = afterProfile.indexOf("/");

  let bucketRaw: string;
  let keyRaw: string;

  if (bucketSlashIdx === -1) {
    // No key segment.
    bucketRaw = afterProfile;
    keyRaw = "";
  } else {
    bucketRaw = afterProfile.slice(0, bucketSlashIdx);
    keyRaw = afterProfile.slice(bucketSlashIdx + 1);
  }

  if (bucketRaw === "") {
    return {
      ok: false,
      error: { field: "uri", hint: "bucket must not be empty" },
    };
  }

  const bucket = decodeComponent(bucketRaw);
  if (bucket === null) {
    return {
      ok: false,
      error: {
        field: "uri",
        hint: "bucket segment contains invalid percent-encoding",
      },
    };
  }

  const keyDecoded = decodeComponent(keyRaw);
  if (keyDecoded === null) {
    return {
      ok: false,
      error: {
        field: "uri",
        hint: "key segment contains invalid percent-encoding",
      },
    };
  }

  return {
    ok: true,
    value: {
      profileId,
      bucket,
      prefix: "",
      key: keyDecoded === "" ? null : keyDecoded,
    },
  };
}

// ---------------------------------------------------------------------------
// toDisplayPath
// ---------------------------------------------------------------------------

/**
 * Build a `DisplayPath` from an `S3Location` for breadcrumb rendering.
 *
 * Segments are split on `/` with empty strings removed so trailing slashes
 * and double-slashes do not produce empty breadcrumb items.
 */
export function toDisplayPath(
  loc: S3Location,
  profileDisplayName: string,
): DisplayPath {
  const raw = loc.key ?? loc.prefix;
  const segments = raw.split("/").filter((s) => s !== "");
  return {
    profileDisplayName,
    bucket: loc.bucket,
    segments,
  };
}

// ---------------------------------------------------------------------------
// fromDisplayPath
// ---------------------------------------------------------------------------

/**
 * Reconstruct an `S3Location` from breadcrumb segments.
 *
 * Returns a location with an empty `prefix` and the joined segments as `key`
 * (or `null` when `segments` is empty, indicating bucket root).
 */
export function fromDisplayPath(
  profileId: string,
  bucket: string,
  segments: string[],
): S3Location {
  return {
    profileId,
    bucket,
    prefix: "",
    key: segments.length === 0 ? null : segments.join("/"),
  };
}

// ---------------------------------------------------------------------------
// toClipboardString
// ---------------------------------------------------------------------------

/**
 * Produce the aws-cli-compatible `s3://` string for clipboard use.
 *
 * Uses the raw (un-encoded) bucket name and key/prefix so users can paste
 * directly into a terminal command (`aws s3 cp s3://bucket/key ./`).
 */
export function toClipboardString(
  loc: S3Location,
  _profileDisplayName: string,
): string {
  const keyStr = loc.key ?? loc.prefix;
  if (keyStr === "") {
    return `s3://${loc.bucket}/`;
  }
  return `s3://${loc.bucket}/${keyStr}`;
}
