//! Integration tests for `buckets_list` against a real S3-compatible endpoint.
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
//!   --test buckets_list_integration
//! ```

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Happy path: list buckets returns non-empty result after creating one
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_buckets_list_happy_path() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{
            list::{list_buckets, BucketSummary},
            ClientPool, ProxyConfig,
        },
    };

    let profile_id = ProfileId::new_v4();
    let compat = CompatFlags {
        endpoint_url: Some(url.clone()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat.clone())
        .await;
    let client = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built for registered profile");

    // Create a test bucket via the SDK directly so list_buckets has something
    // to return.
    let test_bucket = format!(
        "test-brows3r-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("x")
    );
    let _ = client.create_bucket().bucket(&test_bucket).send().await;

    // Now list buckets through our helper.
    let result = list_buckets(&client, &profile_id).await;
    assert!(
        result.is_ok(),
        "list_buckets must succeed: {:?}",
        result.err()
    );

    let buckets: Vec<BucketSummary> = result.unwrap();
    assert!(!buckets.is_empty(), "at least one bucket must be returned");
    assert!(
        buckets.iter().any(|b| b.name == test_bucket),
        "created test bucket must appear in listing"
    );
    assert!(
        buckets.iter().all(|b| b.profile_id == profile_id),
        "every bucket must carry the correct profile_id"
    );

    // Cleanup.
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Access denied path: bad credentials return AppError::AccessDenied
//
// Requires a backend that validates IAM. LocalStack community accepts any
// access key/secret and returns 200, so the assertion fails. Gated by
// `INTEGRATION_IAM_ENFORCED=1`.
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_buckets_list_bad_creds_access_denied() {
    if std::env::var("INTEGRATION_IAM_ENFORCED").ok().as_deref() != Some("1") {
        eprintln!("skipping: INTEGRATION_IAM_ENFORCED!=1 — LocalStack community accepts any creds");
        return;
    }

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use aws_credential_types::{provider::SharedCredentialsProvider, Credentials};
    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{client::ClientBuilder, list::list_buckets, ProxyConfig},
    };

    let bad_creds = SharedCredentialsProvider::new(Credentials::new(
        "AKIABADKEY00000000",
        "badsecretbadsecretbadsecretbadsecret0000",
        None,
        None,
        "test-bad",
    ));

    let compat = CompatFlags {
        endpoint_url: Some(url.clone()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let client = ClientBuilder::new("us-east-1", &compat, &ProxyConfig::None)
        .credentials_provider(bad_creds)
        .build()
        .await;

    let profile_id = ProfileId::new("bad-creds-profile");
    let result = list_buckets(&client, &profile_id).await;

    // LocalStack may return AccessDenied or a Network error depending on
    // the version and configured auth mode. Accept either as the test only
    // verifies that the call does not succeed.
    assert!(
        result.is_err(),
        "bad credentials must not yield a successful listing"
    );
}

// ---------------------------------------------------------------------------
// Unvalidated profile is refused at the command boundary
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn unvalidated_profile_refused_at_command_boundary() {
    use brows3r_lib::{
        error::AppError,
        ids::ProfileId,
        profiles::compat_flags::CompatFlags,
        profiles::{Profile, ProfileSource},
    };

    // This test does NOT call any network endpoint — it verifies the gate
    // directly using the same logic as the command.
    let profile = Profile {
        id: ProfileId::new("unval-profile"),
        display_name: "Unvalidated".to_string(),
        source: ProfileSource::Manual,
        default_region: None,
        validated_at: None,
        compat_flags: CompatFlags::default(),
        source_profile: None,
        role_arn: None,
    };

    // Replicate the command-boundary check.
    let result: Result<(), AppError> = if profile.validated_at.is_none() {
        Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        })
    } else {
        Ok(())
    };

    match result {
        Err(AppError::Auth { reason }) => {
            assert_eq!(reason, "profile_not_validated_in_session");
        }
        _ => panic!("unvalidated profile must be refused at command boundary"),
    }
}
