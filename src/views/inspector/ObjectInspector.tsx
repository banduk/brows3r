/**
 * ObjectInspector — read-only view of an S3 object's aggregated properties.
 *
 * Sections:
 * - Head: content type, size, last modified, ETag, version, storage class,
 *   encryption, content encoding/disposition, cache control, expires.
 * - Custom metadata: user-defined x-amz-meta-* key/value pairs.
 * - Tags: SectionResult with disabled-copy pattern.
 * - ACL summary: SectionResult.
 * - Restore status: SectionResult; Glacier-specific messaging.
 * - Checksums.
 *
 * AC-5 disabled-state copy (same pattern as BucketInspector):
 * - `denied`      → "Requires {iamAction}"
 * - `unsupported` → "Not available on this provider"
 * - `deferred`    → "Deferred from v1"
 *
 * OCP: add a new section = one more `<AccordionSection>` block.
 */

import { useQuery } from "@tanstack/react-query";
import type { ObjectInspectorReport, SectionResult } from "@/api/inspector";
import { objectInspect } from "@/api/inspector";
import {
  disabledForDeferred,
  disabledForDenied,
  disabledForStorageClass,
  disabledForUnsupported,
} from "@/lib/disabledCopy";
import { formatBytes, formatDate } from "@/lib/format";
import { useValidatedProfile } from "@/query/hooks/useValidatedProfile";
import { keys } from "@/query/keys";

// ---------------------------------------------------------------------------
// Shared section helpers
// ---------------------------------------------------------------------------

function SectionBody<T>({
  section,
  renderValue,
}: {
  section: SectionResult<T>;
  renderValue: (value: T) => React.ReactNode;
}): React.ReactElement {
  if (section.kind === "denied") {
    return (
      <p
        className="text-xs text-muted-foreground italic"
        data-disabled="denied"
      >
        {disabledForDenied(section.iamAction)}
      </p>
    );
  }
  if (section.kind === "unsupported") {
    return (
      <p
        className="text-xs text-muted-foreground italic"
        data-disabled="unsupported"
      >
        {disabledForUnsupported(section.reason)}
      </p>
    );
  }
  if (section.kind === "deferred") {
    return (
      <p
        className="text-xs text-muted-foreground italic"
        data-disabled="deferred"
      >
        {disabledForDeferred(section.reason)}
      </p>
    );
  }
  return <>{renderValue(section.value)}</>;
}

function AccordionSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details className="group border-b last:border-b-0">
      <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-2 text-sm font-medium hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span
          className="text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        >
          ›
        </span>
      </summary>
      <div className="px-4 pb-3 pt-1">{children}</div>
    </details>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2 py-0.5 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-foreground">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function HeadSection({
  head,
}: {
  head: ObjectInspectorReport["head"];
}): React.ReactElement {
  const storageClass = head.storageClass ?? null;
  const isGlacier =
    storageClass === "GLACIER" || storageClass === "DEEP_ARCHIVE";

  return (
    <>
      <Field label="Content type" value={head.contentType ?? "—"} />
      <Field
        label="Size"
        value={
          head.contentLength != null ? formatBytes(head.contentLength) : "—"
        }
      />
      <Field
        label="Last modified"
        value={
          head.lastModified != null ? formatDate(head.lastModified * 1000) : "—"
        }
      />
      <Field label="ETag" value={head.etag ?? "—"} />
      <Field label="Version ID" value={head.versionId ?? "—"} />
      <Field
        label="Storage class"
        value={
          <span className="flex flex-col gap-0.5">
            <span>{storageClass ?? "STANDARD"}</span>
            {isGlacier && (
              <span
                className="text-muted-foreground italic"
                data-disabled="storage-class"
              >
                {disabledForStorageClass(storageClass ?? "")}
              </span>
            )}
          </span>
        }
      />
      <Field label="Encryption" value={head.serverSideEncryption ?? "None"} />
      {head.sseKmsKeyId && <Field label="KMS key" value={head.sseKmsKeyId} />}
      {head.contentEncoding && (
        <Field label="Encoding" value={head.contentEncoding} />
      )}
      {head.contentDisposition && (
        <Field label="Disposition" value={head.contentDisposition} />
      )}
      {head.cacheControl && (
        <Field label="Cache control" value={head.cacheControl} />
      )}
      {head.expires != null && (
        <Field label="Expires" value={formatDate(head.expires * 1000)} />
      )}
    </>
  );
}

function MetadataSection({
  metadata,
}: {
  metadata: Record<string, string>;
}): React.ReactElement {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No custom metadata</p>;
  }
  return (
    <ul className="space-y-0.5" data-testid="metadata-list">
      {entries.map(([k, v]) => (
        <li key={k} className="flex gap-2 text-xs">
          <span
            className="w-28 shrink-0 text-muted-foreground"
            data-testid={`meta-key-${k}`}
          >
            {k}
          </span>
          <span className="break-all" data-testid={`meta-val-${k}`}>
            {v}
          </span>
        </li>
      ))}
    </ul>
  );
}

function renderTags(value: Record<string, string>) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No tags</p>;
  }
  return (
    <ul className="space-y-0.5">
      {entries.map(([k, v]) => (
        <li key={k} className="flex gap-2 text-xs">
          <span className="w-28 shrink-0 text-muted-foreground">{k}</span>
          <span className="break-all">{v}</span>
        </li>
      ))}
    </ul>
  );
}

function renderAcl(value: import("@/api/inspector").AclSummary) {
  return (
    <>
      <Field label="Owner" value={value.ownerDisplayName ?? "—"} />
      <Field label="Grants" value={value.grantsCount} />
    </>
  );
}

function renderRestoreStatus(
  value: import("@/api/inspector").RestoreStatus | null,
) {
  if (value === null) {
    // Non-Glacier object.
    return (
      <p className="text-xs text-muted-foreground">Not an archived object</p>
    );
  }
  if (value.ongoing) {
    return <p className="text-xs">Restore in progress</p>;
  }
  if (value.expirySecs != null) {
    return (
      <p className="text-xs">
        Restored — expires {formatDate(value.expirySecs * 1000)}
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">No restore active</p>;
}

// ---------------------------------------------------------------------------
// ObjectInspector
// ---------------------------------------------------------------------------

interface ObjectInspectorProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

export function ObjectInspector({
  profileId,
  bucket,
  objectKey,
}: ObjectInspectorProps): React.ReactElement {
  const { isValidated } = useValidatedProfile(profileId);

  const { data, isLoading, error } = useQuery<ObjectInspectorReport>({
    queryKey: keys.inspector(profileId, bucket, objectKey),
    queryFn: () => objectInspect(profileId, bucket, objectKey),
    enabled: isValidated,
  });

  // -- Validation gate -------------------------------------------------------
  if (!isValidated) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 p-6 text-muted-foreground"
        data-testid="inspector-validation-gate"
      >
        <p className="text-sm">Validate this profile to inspect this object</p>
      </div>
    );
  }

  // -- Loading ---------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="p-4 text-xs text-muted-foreground" aria-busy="true">
        <span className="sr-only">Loading object properties</span>
        Loading…
      </div>
    );
  }

  // -- Error -----------------------------------------------------------------
  if (error || !data) {
    return (
      <div className="p-4 text-xs text-destructive">
        Failed to load object properties.
      </div>
    );
  }

  return (
    <div className="divide-y" data-testid="object-inspector">
      <AccordionSection title="Head">
        <HeadSection head={data.head} />
      </AccordionSection>

      <AccordionSection title="Custom Metadata">
        <MetadataSection metadata={data.head.metadata} />
      </AccordionSection>

      <AccordionSection title="Tags">
        <SectionBody section={data.tags} renderValue={renderTags} />
      </AccordionSection>

      <AccordionSection title="ACL">
        <SectionBody section={data.aclSummary} renderValue={renderAcl} />
      </AccordionSection>

      <AccordionSection title="Restore Status">
        <SectionBody
          section={data.restoreStatus}
          renderValue={renderRestoreStatus}
        />
      </AccordionSection>

      <AccordionSection title="Checksums">
        <Field label="SHA-256" value={data.checksumSha256 ?? "—"} />
        <Field label="MD5 / ETag" value={data.checksumMd5 ?? "—"} />
        <Field label="CRC-32" value={data.checksumCrc32 ?? "—"} />
      </AccordionSection>
    </div>
  );
}
