/**
 * API module for profile commands.
 *
 * Each function wraps exactly one Rust command. Types mirror the Rust serde
 * shapes (camelCase). Adding a new backend command = one function here.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileSource = "awsCredentials" | "awsConfig" | "manual" | "env";

/** Addressing style for S3 requests. */
export type AddressingStyle = "virtual" | "path" | "auto";

/** Signature version for requests. */
export type SignatureVersion = "v4" | "v2";

/** Checksum mode for uploads. */
export type ChecksumMode = "enabled" | "disabled";

/**
 * Compatibility flags stored per profile.
 * Mirrors `src-tauri/src/profiles/compat_flags.rs` CompatFlags.
 */
export interface CompatFlags {
  flagsSchema?: number;
  endpointUrl?: string;
  addressingStyle?: AddressingStyle;
  signatureVersion?: SignatureVersion;
  forcePathStyle?: boolean;
  acceptInvalidCerts?: boolean;
  expectContinue?: boolean;
  chunkedUpload?: boolean;
  checksumMode?: ChecksumMode;
  regionOverride?: string;
  disableBucketNameValidation?: boolean;
  [key: string]: unknown;
}

/** Lightweight summary returned by list and mutations. */
export interface ProfileSummary {
  id: string;
  displayName: string;
  source: ProfileSource;
  defaultRegion?: string;
  validatedAt?: number;
  hasCompatFlags: boolean;
}

/** Full detail for a single profile (no secret fields). */
export interface ProfileDetail {
  id: string;
  displayName: string;
  source: ProfileSource;
  defaultRegion?: string;
  validatedAt?: number;
  compatFlags: CompatFlags;
  sourceProfile?: string;
}

/** Patch payload accepted by `profile_update`. */
export interface ProfileUpdatePatch {
  displayName?: string;
  compatFlags?: CompatFlags;
  defaultRegion?: string;
}

/** Input payload for `profile_create_manual`. */
export interface ProfileCreateManualInput {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  defaultRegion?: string;
  compatFlags?: CompatFlags;
}

export type ProviderKind = "aws" | "compatible";

/** Report returned by `profile_validate`. */
export interface ValidationReport {
  profileId: string;
  ok: boolean;
  accountId?: string;
  arn?: string;
  validatedAt: number;
  providerKind: ProviderKind;
  error?: import("@/lib/errors").AppError;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Fetch the aggregated list of all profiles. */
export function profilesList(): Promise<ProfileSummary[]> {
  return invoke<ProfileSummary[]>("profiles_list");
}

/** Fetch full detail for a single profile by id. */
export function profileGet(profileId: string): Promise<ProfileDetail> {
  return invoke<ProfileDetail>("profile_get", { profileId });
}

/** Create a new manual profile. Secrets cross the IPC boundary here only. */
export function profileCreateManual(
  input: ProfileCreateManualInput,
): Promise<ProfileSummary> {
  return invoke<ProfileSummary>("profile_create_manual", {
    name: input.name,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    sessionToken: input.sessionToken ?? null,
    defaultRegion: input.defaultRegion ?? null,
    compatFlags: input.compatFlags ?? null,
  });
}

/** Patch name / compat flags / default region for a manual profile. */
export function profileUpdate(
  profileId: string,
  patch: ProfileUpdatePatch,
): Promise<ProfileSummary> {
  return invoke<ProfileSummary>("profile_update", { profileId, patch });
}

/** Delete a manual profile and its keychain entry. */
export function profileDelete(profileId: string): Promise<void> {
  return invoke<void>("profile_delete", { profileId });
}

/** Validate a profile via STS GetCallerIdentity or list-buckets probe. */
export function profileValidate(profileId: string): Promise<ValidationReport> {
  return invoke<ValidationReport>("profile_validate", { profileId });
}

/**
 * Supply a passphrase to unlock the FileBackend keychain fallback.
 *
 * Called from the KeychainFallbackPrompt when the OS keychain is unavailable.
 * The backend stub is wired in task 18; full FileBackend unlock lands in the
 * same commit via `keychain_fallback_unlock` in `profiles_cmd.rs`.
 */
export function keychainFallbackUnlock(passphrase: string): Promise<void> {
  return invoke<void>("keychain_fallback_unlock", { passphrase });
}
