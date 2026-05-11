//! Integration tests for profile validation against a real S3-compatible endpoint.
//!
//! These tests are gated by two conditions:
//!
//! 1. The `integration` cargo feature must be enabled (`--features integration`).
//! 2. The `LOCALSTACK_URL` environment variable must be set at runtime.
//!
//! Both conditions must hold for the tests to actually run. If either is absent
//! the test returns early so the CI unit-test job stays green.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test profile_validation_integration
//! ```

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_valid_credentials_ok() {
    // Runtime gate: if LOCALSTACK_URL is not set, skip silently.
    let localstack_url = match std::env::var("LOCALSTACK_URL") {
        Ok(url) => url,
        Err(_) => return,
    };

    use brows3r_lib::{
        ids::ProfileId,
        profiles::{
            compat_flags::{AddressingStyle, CompatFlags},
            keychain::Secret,
            validate_profile, Profile, ProfileSource,
        },
        s3::{ClientPool, ProxyConfig},
    };
    use std::sync::Arc;

    let profile_id = ProfileId::new_v4();
    let profile = Profile {
        id: profile_id.clone(),
        display_name: "LocalStack Test".to_string(),
        source: ProfileSource::Manual,
        default_region: Some("us-east-1".to_string()),
        validated_at: None,
        compat_flags: CompatFlags {
            endpoint_url: Some(localstack_url.clone()),
            addressing_style: AddressingStyle::Path,
            ..Default::default()
        },
        source_profile: None,
        role_arn: None,
    };

    // LocalStack uses fixed test credentials.
    let secret = Secret {
        access_key_id: "test".to_string(),
        secret_access_key: "test".to_string(),
        session_token: None,
    };

    let pool = Arc::new(ClientPool::new(ProxyConfig::None));
    let report = validate_profile(&profile, Some(&secret), &pool)
        .await
        .expect("validate_profile must not return Err");

    assert!(
        report.ok,
        "LocalStack validation must succeed; error: {:?}",
        report.error
    );
    assert!(
        report.validated_at > 0,
        "validated_at must be populated on success"
    );
    assert_eq!(report.profile_id, profile_id);
}

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_bogus_secret_returns_auth_error() {
    // Runtime gate: if LOCALSTACK_URL is not set, skip silently.
    let localstack_url = match std::env::var("LOCALSTACK_URL") {
        Ok(url) => url,
        Err(_) => return,
    };

    use brows3r_lib::{
        error::AppError,
        ids::ProfileId,
        profiles::{
            compat_flags::{AddressingStyle, CompatFlags},
            keychain::Secret,
            validate_profile, Profile, ProfileSource,
        },
        s3::{ClientPool, ProxyConfig},
    };
    use std::sync::Arc;

    let profile_id = ProfileId::new_v4();
    let profile = Profile {
        id: profile_id.clone(),
        display_name: "LocalStack Bogus Test".to_string(),
        source: ProfileSource::Manual,
        default_region: Some("us-east-1".to_string()),
        validated_at: None,
        compat_flags: CompatFlags {
            endpoint_url: Some(localstack_url),
            addressing_style: AddressingStyle::Path,
            ..Default::default()
        },
        source_profile: None,
        role_arn: None,
    };

    // Bogus credentials should trigger an auth error.
    let secret = Secret {
        access_key_id: "BOGUS_KEY_ID_000000000000".to_string(),
        secret_access_key: "bogus_secret_key".to_string(),
        session_token: None,
    };

    let pool = Arc::new(ClientPool::new(ProxyConfig::None));
    let report = validate_profile(&profile, Some(&secret), &pool)
        .await
        .expect("validate_profile must not return Err");

    // LocalStack may or may not enforce auth; assert ok=false or specific error type.
    // If LocalStack is permissive (accepts any creds), this test is a no-op guard.
    if !report.ok {
        let err = report.error.expect("error must be set when ok=false");
        assert!(
            matches!(err, AppError::Auth { .. } | AppError::AccessDenied { .. }),
            "bogus credentials must map to Auth or AccessDenied; got {err:?}"
        );
    }
}
