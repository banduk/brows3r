//! Tauri commands for the profile CRUD surface.
//!
//! # Commands
//!
//! - `profiles_list`          — union of AWS-discovered + manual + env profiles.
//! - `profile_get`            — full detail for one profile (non-secret fields only).
//! - `profile_create_manual`  — create a manual profile; secret persisted via keychain.
//! - `profile_update`         — patch name / compat flags / region.
//! - `profile_delete`         — remove profile + keychain entry.
//! - `profile_validate`       — validate via `sts:GetCallerIdentity` or list-bucket probe.
//!
//! # Security contract
//!
//! Secret material (`access_key_id`, `secret_access_key`, `session_token`)
//! crosses the IPC boundary ONCE: inbound on `profile_create_manual`. The
//! keychain absorbs the secret immediately; the returned [`ProfileSummary`]
//! never carries secret fields.

use tauri::State;

use crate::profiles::keychain::Secret;
use crate::{
    error::AppError,
    ids::ProfileId,
    profiles::{
        validate_profile, CompatFlags, KeychainHandle, ProfileDetail, ProfileStoreHandle,
        ProfileSummary, ProfileUpdatePatch, ValidationReport,
    },
    s3::S3ClientPoolHandle,
};

/// Return the aggregated list of all profiles.
///
/// Union of `~/.aws/credentials`, `~/.aws/config`, env-derived, and manual
/// profiles.  See [`crate::profiles::ProfileStore::list`] for aggregation rules.
#[tauri::command]
pub async fn profiles_list(
    store: State<'_, ProfileStoreHandle>,
) -> Result<Vec<ProfileSummary>, AppError> {
    let store = store.inner.lock().await;
    let profiles = store.list();
    Ok(profiles.iter().map(ProfileSummary::from).collect())
}

/// Return the full detail for a single profile.
///
/// Returns `AppError::NotFound` when no profile with `profile_id` exists.
#[tauri::command]
pub async fn profile_get(
    profile_id: ProfileId,
    store: State<'_, ProfileStoreHandle>,
) -> Result<ProfileDetail, AppError> {
    let store = store.inner.lock().await;
    store
        .get(&profile_id)
        .map(|p| ProfileDetail::from(&p))
        .ok_or_else(|| AppError::NotFound {
            resource: format!("profile:{}", profile_id.as_str()),
        })
}

/// Create a new manual profile.
///
/// The secret (`access_key_id`, `secret_access_key`, `session_token`) crosses
/// the IPC boundary here and is immediately handed off to the keychain.
/// The returned [`ProfileSummary`] contains no secret fields.
///
/// # Validation
///
/// Returns `AppError::Validation` when `name` or `access_key_id` is empty.
#[tauri::command]
pub async fn profile_create_manual(
    name: String,
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    default_region: Option<String>,
    compat_flags: Option<CompatFlags>,
    store: State<'_, ProfileStoreHandle>,
    keychain: State<'_, KeychainHandle>,
) -> Result<ProfileSummary, AppError> {
    if name.trim().is_empty() {
        return Err(AppError::Validation {
            field: "name".to_string(),
            hint: "must not be empty".to_string(),
        });
    }
    if access_key_id.trim().is_empty() {
        return Err(AppError::Validation {
            field: "accessKeyId".to_string(),
            hint: "must not be empty".to_string(),
        });
    }

    let secret = Secret {
        access_key_id,
        secret_access_key,
        session_token,
    };

    let mut store = store.inner.lock().await;
    let mut keychain = keychain.inner.lock().await;

    let profile =
        store.create_manual(name, secret, default_region, compat_flags, &mut *keychain)?;
    Ok(ProfileSummary::from(&profile))
}

/// Update a manual profile's display name, compat flags, and/or default region.
///
/// Returns `AppError::NotFound` when the profile does not exist or is not a
/// manual profile (discovered profiles are read-only).
#[tauri::command]
pub async fn profile_update(
    profile_id: ProfileId,
    patch: ProfileUpdatePatch,
    store: State<'_, ProfileStoreHandle>,
) -> Result<ProfileSummary, AppError> {
    let mut store = store.inner.lock().await;
    let updated = store.update(&profile_id, patch)?;
    Ok(ProfileSummary::from(&updated))
}

/// Delete a manual profile and its associated keychain entry.
///
/// Returns `AppError::NotFound` when the profile does not exist in the manual
/// set (discovered profiles cannot be deleted).
#[tauri::command]
pub async fn profile_delete(
    profile_id: ProfileId,
    store: State<'_, ProfileStoreHandle>,
    keychain: State<'_, KeychainHandle>,
) -> Result<(), AppError> {
    let mut store = store.inner.lock().await;
    let mut keychain = keychain.inner.lock().await;
    store.delete(&profile_id, &mut *keychain)
}

/// Unlock the keychain fallback (FileBackend) with a user-supplied passphrase.
///
/// Called from the `KeychainFallbackPrompt` UI component when the OS keychain
/// is unavailable and the app has fallen back to the encrypted-file backend.
///
/// The passphrase is forwarded to `KeychainBackend::unlock`. For backends
/// that do not need a passphrase (e.g. `KeyringBackend`) this is a no-op that
/// returns `Ok(())`. Full FileBackend re-key logic is wired here; the trait
/// method default handles all other backends transparently.
///
/// # TODO
///
/// Wire `keychain_dir` + passphrase back into a live `FileBackend` once the
/// app emits `KeychainFallbackRequired` at startup (task 19+). For now this
/// command delegates to the generic `unlock` trait method so the frontend
/// pathway is exercised end-to-end without requiring a complete startup rework.
#[tauri::command]
pub async fn keychain_fallback_unlock(
    passphrase: String,
    keychain: State<'_, KeychainHandle>,
) -> Result<(), AppError> {
    let mut keychain = keychain.inner.lock().await;
    keychain.unlock(&passphrase)
}

/// Validate a profile by running the appropriate probe.
///
/// - AWS profiles (no `endpoint_url`): `sts:GetCallerIdentity`.
/// - Compat providers (has `endpoint_url`): `s3:ListBuckets`.
///
/// On success, persists `validated_at` via `ProfileStore::mark_validated`.
/// Returns the full [`ValidationReport`] regardless of success/failure.
#[tauri::command]
pub async fn profile_validate(
    profile_id: ProfileId,
    store: State<'_, ProfileStoreHandle>,
    keychain: State<'_, KeychainHandle>,
    pool: State<'_, S3ClientPoolHandle>,
) -> Result<ValidationReport, AppError> {
    // 1. Look up the profile.
    let profile = {
        let store = store.inner.lock().await;
        store.get(&profile_id).ok_or_else(|| AppError::NotFound {
            resource: format!("profile:{}", profile_id.as_str()),
        })?
    };

    // 2. Fetch the secret from keychain for manual profiles.
    //    AWS-discovered / env profiles rely on the SDK's credential provider chain.
    let secret = {
        use crate::profiles::ProfileSource;
        if profile.source == ProfileSource::Manual {
            let keychain = keychain.inner.lock().await;
            keychain.get(profile_id.as_str())?
        } else {
            None
        }
    };

    // 3. Run the validation probe.
    let report = validate_profile(&profile, secret.as_ref(), &pool.inner).await?;

    // 4. Persist validated_at on success and register the profile with the
    //    shared S3 client pool so subsequent buckets_list / objects_list
    //    calls can build a client. Without this every post-validate command
    //    would fail with Internal { trace_id: "pool_miss:..." } because the
    //    pool only learns about a profile via register_profile().
    if report.ok {
        {
            let mut store = store.inner.lock().await;
            store.mark_validated(&profile_id, report.validated_at);
        }
        pool.inner
            .register_profile(profile_id.clone(), profile.compat_flags.clone())
            .await;

        // Also register credentials so get_or_build can sign requests. Without
        // this the pool falls back to the SDK's default chain — which only
        // loads the user's default ~/.aws/credentials profile — and every
        // request against a non-default profile fails with "dispatch failure".
        if let Some(creds) = build_credentials_provider(&profile, secret.as_ref()).await {
            pool.inner
                .register_credentials(profile_id.clone(), creds)
                .await;
        }
    }

    Ok(report)
}

/// Build a `SharedCredentialsProvider` for a profile.
///
/// - Manual profiles: use the keychain secret directly.
/// - AWS-discovered profiles: load the full SDK config for the named profile so
///   the SSO / assume-role / credential-process providers are wired in. A bare
///   `ProfileFileCredentialsProvider` only understands static `aws_access_key_id`
///   entries and silently fails on SSO profiles.
/// - Env profiles: fall through to None — the SDK's default chain will pick up
///   the env vars on its own.
///
/// Returns `None` when no provider can be constructed.
async fn build_credentials_provider(
    profile: &crate::profiles::Profile,
    secret: Option<&crate::profiles::keychain::Secret>,
) -> Option<aws_credential_types::provider::SharedCredentialsProvider> {
    use crate::profiles::ProfileSource;
    use aws_config::BehaviorVersion;
    use aws_credential_types::provider::SharedCredentialsProvider;
    use aws_credential_types::Credentials;

    if let Some(secret) = secret {
        let creds = Credentials::new(
            &secret.access_key_id,
            &secret.secret_access_key,
            secret.session_token.clone(),
            None,
            "brows3r-manual",
        );
        return Some(SharedCredentialsProvider::new(creds));
    }

    match profile.source {
        ProfileSource::AwsCredentials | ProfileSource::AwsConfig => {
            let sdk_config = aws_config::defaults(BehaviorVersion::latest())
                .profile_name(profile.display_name.as_str())
                .load()
                .await;
            sdk_config.credentials_provider()
        }
        // Env/Manual paths handled above; nothing to register here.
        _ => None,
    }
}
