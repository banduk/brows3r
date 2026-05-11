/**
 * BucketInspector — read-only view of a bucket's aggregated properties.
 *
 * Fetches via TanStack Query using `bucketInspect`, gated by
 * `useValidatedProfile`. Each section is a collapsible accordion item.
 *
 * AC-5 disabled-state copy:
 * - `denied`      → "Requires {iamAction}"
 * - `unsupported` → "Not available on this provider"
 * - `deferred`    → "Deferred from v1"
 *
 * OCP: adding a new section = one more `<AccordionSection>` in the JSX.
 * The SectionResult discriminator pattern is fully additive.
 */

import { useQuery } from "@tanstack/react-query";
import type { BucketInspectorReport, SectionResult } from "@/api/inspector";
import { bucketInspect } from "@/api/inspector";
import {
  disabledForDeferred,
  disabledForDenied,
  disabledForUnsupported,
} from "@/lib/disabledCopy";
import { useValidatedProfile } from "@/query/hooks/useValidatedProfile";
import { keys } from "@/query/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a single SectionResult using the disabled-copy pattern. */
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

// ---------------------------------------------------------------------------
// AccordionSection
// ---------------------------------------------------------------------------

interface AccordionSectionProps {
  title: string;
  children: React.ReactNode;
}

function AccordionSection({
  title,
  children,
}: AccordionSectionProps): React.ReactElement {
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

// ---------------------------------------------------------------------------
// Field helper
// ---------------------------------------------------------------------------

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

function renderRegion(value: string) {
  return <Field label="Region" value={value} />;
}

function renderVersioning(value: import("@/api/inspector").VersioningStatus) {
  return <Field label="Status" value={value} />;
}

function renderEncryption(value: import("@/api/inspector").EncryptionConfig) {
  return (
    <>
      <Field label="Algorithm" value={value.sseAlgorithm ?? "—"} />
      {value.kmsMasterKeyId && (
        <Field label="KMS key" value={value.kmsMasterKeyId} />
      )}
    </>
  );
}

function renderLifecycle(value: import("@/api/inspector").LifecycleRule[]) {
  if (value.length === 0) {
    return <p className="text-xs text-muted-foreground">No rules configured</p>;
  }
  return (
    <ul className="space-y-1">
      {value.map((rule, i) => (
        <li key={rule.id ?? i} className="text-xs">
          <span className="font-medium">{rule.id ?? "(no id)"}</span>{" "}
          <span className="text-muted-foreground">— {rule.status}</span>
        </li>
      ))}
    </ul>
  );
}

function renderObjectLock(value: import("@/api/inspector").ObjectLockConfig) {
  return (
    <>
      <Field label="Enabled" value={value.objectLockEnabled ? "Yes" : "No"} />
      {value.defaultRetentionMode && (
        <Field label="Mode" value={value.defaultRetentionMode} />
      )}
    </>
  );
}

function renderPublicAccessBlock(
  value: import("@/api/inspector").PublicAccessBlockConfig,
) {
  return (
    <>
      <Field
        label="Block public ACLs"
        value={value.blockPublicAcls ? "Yes" : "No"}
      />
      <Field
        label="Ignore public ACLs"
        value={value.ignorePublicAcls ? "Yes" : "No"}
      />
      <Field
        label="Block public policy"
        value={value.blockPublicPolicy ? "Yes" : "No"}
      />
      <Field
        label="Restrict public"
        value={value.restrictPublicBuckets ? "Yes" : "No"}
      />
    </>
  );
}

function renderCors(value: import("@/api/inspector").CorsRule[]) {
  if (value.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No CORS rules configured</p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {value.length} rule{value.length !== 1 ? "s" : ""}
    </p>
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

function renderReplication(value: import("@/api/inspector").ReplicationConfig) {
  return (
    <>
      <Field label="Role" value={value.role} />
      <Field
        label="Destinations"
        value={value.destinationBuckets.join(", ") || "—"}
      />
    </>
  );
}

function renderLogging(value: import("@/api/inspector").LoggingConfig) {
  return (
    <>
      <Field label="Target bucket" value={value.targetBucket ?? "Disabled"} />
      {value.targetPrefix && (
        <Field label="Prefix" value={value.targetPrefix} />
      )}
    </>
  );
}

function renderWebsite(value: import("@/api/inspector").WebsiteConfig) {
  if (value.redirectAllRequestsTo) {
    return <Field label="Redirect to" value={value.redirectAllRequestsTo} />;
  }
  return (
    <>
      <Field label="Index" value={value.indexDocument ?? "—"} />
      <Field label="Error" value={value.errorDocument ?? "—"} />
    </>
  );
}

function renderNotifications(
  value: import("@/api/inspector").NotificationConfig,
) {
  return (
    <>
      <Field label="Lambda" value={value.lambdaCount} />
      <Field label="Queue" value={value.queueCount} />
      <Field label="Topic" value={value.topicCount} />
    </>
  );
}

function renderOwnershipControls(
  value: import("@/api/inspector").OwnershipControls,
) {
  return <Field label="Rule" value={value.rule} />;
}

function renderRequesterPays(value: boolean) {
  return (
    <Field label="Requester pays" value={value ? "Enabled" : "Disabled"} />
  );
}

// ---------------------------------------------------------------------------
// BucketInspector
// ---------------------------------------------------------------------------

interface BucketInspectorProps {
  profileId: string;
  bucket: string;
}

export function BucketInspector({
  profileId,
  bucket,
}: BucketInspectorProps): React.ReactElement {
  const { isValidated } = useValidatedProfile(profileId);

  const { data, isLoading, error } = useQuery<BucketInspectorReport>({
    queryKey: keys.inspector(profileId, bucket),
    queryFn: () => bucketInspect(profileId, bucket),
    enabled: isValidated,
  });

  // -- Validation gate -------------------------------------------------------
  if (!isValidated) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 p-6 text-muted-foreground"
        data-testid="inspector-validation-gate"
      >
        <p className="text-sm">Validate this profile to inspect this bucket</p>
      </div>
    );
  }

  // -- Loading ---------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="p-4 text-xs text-muted-foreground" aria-busy="true">
        <span className="sr-only">Loading bucket properties</span>
        Loading…
      </div>
    );
  }

  // -- Error -----------------------------------------------------------------
  if (error || !data) {
    return (
      <div className="p-4 text-xs text-destructive">
        Failed to load bucket properties.
      </div>
    );
  }

  return (
    <div className="divide-y" data-testid="bucket-inspector">
      <AccordionSection title="Region">
        <SectionBody section={data.region} renderValue={renderRegion} />
      </AccordionSection>

      <AccordionSection title="Versioning">
        <SectionBody section={data.versioning} renderValue={renderVersioning} />
      </AccordionSection>

      <AccordionSection title="Encryption">
        <SectionBody section={data.encryption} renderValue={renderEncryption} />
      </AccordionSection>

      <AccordionSection title="Lifecycle">
        <SectionBody section={data.lifecycle} renderValue={renderLifecycle} />
      </AccordionSection>

      <AccordionSection title="Object Lock">
        <SectionBody section={data.objectLock} renderValue={renderObjectLock} />
      </AccordionSection>

      <AccordionSection title="Public Access Block">
        <SectionBody
          section={data.publicAccessBlock}
          renderValue={renderPublicAccessBlock}
        />
      </AccordionSection>

      <AccordionSection title="CORS">
        <SectionBody section={data.cors} renderValue={renderCors} />
      </AccordionSection>

      <AccordionSection title="Tags">
        <SectionBody section={data.tags} renderValue={renderTags} />
      </AccordionSection>

      <AccordionSection title="Replication">
        <SectionBody
          section={data.replication}
          renderValue={renderReplication}
        />
      </AccordionSection>

      <AccordionSection title="Logging">
        <SectionBody section={data.logging} renderValue={renderLogging} />
      </AccordionSection>

      <AccordionSection title="Website Hosting">
        <SectionBody section={data.website} renderValue={renderWebsite} />
      </AccordionSection>

      <AccordionSection title="Notifications">
        <SectionBody
          section={data.notifications}
          renderValue={renderNotifications}
        />
      </AccordionSection>

      <AccordionSection title="Ownership Controls">
        <SectionBody
          section={data.ownershipControls}
          renderValue={renderOwnershipControls}
        />
      </AccordionSection>

      <AccordionSection title="Requester Pays">
        <SectionBody
          section={data.requesterPays}
          renderValue={renderRequesterPays}
        />
      </AccordionSection>

      <AccordionSection title="Bucket Policy">
        <SectionBody section={data.bucketPolicy} renderValue={() => null} />
      </AccordionSection>
    </div>
  );
}
