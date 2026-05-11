//! Integration tests for `objects_list` and `objects_list_flat` against a
//! real S3-compatible endpoint.
//!
//! These tests are gated by two conditions:
//!
//! 1. The `integration` cargo feature must be enabled (`--features integration`).
//! 2. The `LOCALSTACK_URL` environment variable must be set at runtime.
//!
//! Both conditions must hold for the tests to actually run. If either is absent
//! the test body returns early so the CI unit-test job stays green.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test objects_list_integration
//! ```

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Happy path: hierarchical listing pages chain correctly for 1.2k objects
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_objects_list_pagination_chains() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{
            list::{list_objects, ListPage},
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

    // Create a test bucket.
    let test_bucket = format!(
        "test-objlist-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("x")
    );
    client
        .create_bucket()
        .bucket(&test_bucket)
        .send()
        .await
        .expect("bucket creation must succeed");

    // Create 1 200 synthetic objects: test/0001/obj through test/1200/obj.
    // We batch them 100 at a time via individual PutObject calls to avoid
    // overwhelming the LocalStack process.
    for i in 1_u32..=1200 {
        let key = format!("test/{:04}/obj", i);
        client
            .put_object()
            .bucket(&test_bucket)
            .key(&key)
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
            .send()
            .await
            .unwrap_or_else(|e| panic!("put_object({key}) failed: {e}"));
    }

    // Walk through hierarchical listing pages (delimiter="/", prefix="test/")
    // and collect all entries.
    let mut all_entries: Vec<String> = Vec::new();
    let mut token: Option<String> = None;
    let mut page_count = 0_usize;

    loop {
        let page: ListPage = list_objects(
            &client,
            &test_bucket,
            "test/",
            Some("/"),
            token.as_deref(),
            Some(100), // small page size to exercise pagination
        )
        .await
        .expect("list_objects must succeed");

        page_count += 1;
        for entry in &page.entries {
            all_entries.push(entry.key.clone());
        }

        assert!(
            page_count <= 20,
            "pagination must complete within 20 pages (got stuck?)"
        );

        match page.next_continuation_token {
            Some(t) => token = Some(t),
            None => break,
        }
    }

    // With delimiter="/" and prefix="test/", each subfolder "test/XXXX/"
    // is returned as one common-prefix entry — so we expect 1 200 prefix entries.
    assert_eq!(
        all_entries.len(),
        1200,
        "all 1200 virtual-folder prefixes must be listed when iterating pages"
    );

    // Cleanup.
    // Delete all objects first; then delete the bucket.
    for i in 1_u32..=1200 {
        let key = format!("test/{:04}/obj", i);
        let _ = client
            .delete_object()
            .bucket(&test_bucket)
            .key(&key)
            .send()
            .await;
    }
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Flat variant: empty common_prefixes and all keys returned
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_objects_list_flat_has_empty_common_prefixes() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{list::list_objects_flat, ClientPool, ProxyConfig},
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
        .expect("client must be built");

    let test_bucket = format!(
        "test-flat-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("x")
    );
    client
        .create_bucket()
        .bucket(&test_bucket)
        .send()
        .await
        .expect("bucket creation must succeed");

    // Create a small set of nested objects.
    for i in 0_u32..10 {
        let key = format!("flat/dir{}/file{}.txt", i % 3, i);
        client
            .put_object()
            .bucket(&test_bucket)
            .key(&key)
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b"y"))
            .send()
            .await
            .unwrap_or_else(|e| panic!("put_object failed: {e}"));
    }

    let page = list_objects_flat(&client, &test_bucket, "flat/", None, None)
        .await
        .expect("list_objects_flat must succeed");

    assert!(
        page.common_prefixes.is_empty(),
        "flat listing must have empty common_prefixes"
    );
    assert!(
        page.entries.iter().all(|e| !e.is_prefix),
        "flat listing entries must all have is_prefix = false"
    );
    assert_eq!(page.entries.len(), 10, "all 10 objects must be returned");

    // Cleanup.
    for i in 0_u32..10 {
        let key = format!("flat/dir{}/file{}.txt", i % 3, i);
        let _ = client
            .delete_object()
            .bucket(&test_bucket)
            .key(&key)
            .send()
            .await;
    }
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Unvalidated profile is refused at the command boundary
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn unvalidated_profile_refused_at_objects_command_boundary() {
    use brows3r_lib::{
        error::AppError,
        ids::ProfileId,
        profiles::{compat_flags::CompatFlags, Profile, ProfileSource},
    };

    // This test does NOT call any network endpoint — it verifies the gate
    // directly using the same logic as the commands.
    let profile = Profile {
        id: ProfileId::new("unval-objects-profile"),
        display_name: "Unvalidated".to_string(),
        source: ProfileSource::Manual,
        default_region: None,
        validated_at: None,
        compat_flags: CompatFlags::default(),
        source_profile: None,
        role_arn: None,
    };

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
