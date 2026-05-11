//! Integration tests for the multipart cleanup scanner and abort guard.
//!
//! # Gate
//!
//! These tests are gated behind the `integration` feature flag and require the
//! `LOCALSTACK_URL` environment variable to be set.  They will be skipped
//! silently in normal CI runs.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test multipart_cleanup_integration
//! ```

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn make_client(
    url: &str,
) -> (
    std::sync::Arc<aws_sdk_s3::Client>,
    brows3r_lib::ids::ProfileId,
) {
    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{ClientPool, ProxyConfig},
    };

    let profile_id = ProfileId::new_v4();
    let compat = CompatFlags {
        endpoint_url: Some(url.to_owned()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat).await;
    let client = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built");

    (client, profile_id)
}

#[cfg(feature = "integration")]
fn make_multipart_table() -> std::sync::Arc<brows3r_lib::s3::multipart::MultipartTable> {
    use brows3r_lib::s3::multipart::MultipartTable;
    let dir = tempfile::tempdir().expect("tempdir");
    let db = std::sync::Arc::new(
        redb::Database::create(dir.path().join("test_multipart_cleanup.redb"))
            .expect("test redb must open"),
    );
    // Keep `dir` alive for the test duration — leak it.
    std::mem::forget(dir);
    std::sync::Arc::new(MultipartTable::new(db).expect("multipart table must open"))
}

// ---------------------------------------------------------------------------
// Test 1: Foreign upload is classified as Unknown
// ---------------------------------------------------------------------------

/// Start a multipart upload directly via the SDK (bypassing our upload path)
/// to simulate a foreign upload, then verify `multipart_scan` returns it as
/// `Unknown`.
#[cfg(feature = "integration")]
#[tokio::test]
async fn foreign_upload_is_classified_as_unknown() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        s3::multipart::{scan_multipart_uploads, MultipartSource},
    };

    let (client, _profile_id) = make_client(&url).await;
    let table = make_multipart_table();

    let test_bucket = format!(
        "test-mpu-unknown-{}",
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

    // Start a multipart upload directly via SDK — not through our upload path.
    let create_resp = client
        .create_multipart_upload()
        .bucket(&test_bucket)
        .key("foreign/object.bin")
        .send()
        .await
        .expect("create_multipart_upload must succeed");

    let foreign_upload_id = create_resp
        .upload_id
        .expect("create_multipart_upload must return an upload_id");

    let bucket_id = BucketId::new(&test_bucket);

    // Scan without any age filter — must return the foreign upload.
    let uploads = scan_multipart_uploads(&client, &bucket_id, &table, None)
        .await
        .expect("scan must succeed");

    let found = uploads
        .iter()
        .find(|u| u.upload_id == foreign_upload_id)
        .expect("foreign upload must appear in scan results");

    assert_eq!(
        found.source,
        MultipartSource::Unknown,
        "upload not in our table must be classified as Unknown"
    );

    // Cleanup: abort the upload so LocalStack stays clean.
    client
        .abort_multipart_upload()
        .bucket(&test_bucket)
        .key("foreign/object.bin")
        .upload_id(&foreign_upload_id)
        .send()
        .await
        .expect("cleanup abort must succeed");
}

// ---------------------------------------------------------------------------
// Test 2: Unknown + no confirmation → Validation error
// ---------------------------------------------------------------------------

/// Verify that aborting an `Unknown`-sourced upload without
/// `confirmed_unknown = true` returns a `Validation` error.
#[cfg(feature = "integration")]
#[tokio::test]
async fn abort_unknown_without_confirmation_returns_validation_error() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        error::AppError,
        ids::BucketId,
        s3::multipart::{abort_multipart_upload, MultipartSource},
    };

    let (client, profile_id) = make_client(&url).await;
    let table = make_multipart_table();

    let test_bucket = format!(
        "test-mpu-guard-{}",
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

    let create_resp = client
        .create_multipart_upload()
        .bucket(&test_bucket)
        .key("guarded/object.bin")
        .send()
        .await
        .expect("create_multipart_upload must succeed");

    let upload_id = create_resp.upload_id.expect("must return an upload_id");

    let bucket_id = BucketId::new(&test_bucket);

    // Attempt to abort without confirmation — must be rejected.
    let err = abort_multipart_upload(
        &client,
        &bucket_id,
        "guarded/object.bin",
        &upload_id,
        MultipartSource::Unknown,
        &table,
        &profile_id,
        false, // confirmed_unknown = false
    )
    .await
    .expect_err("must return an error without confirmation");

    assert!(
        matches!(err, AppError::Validation { ref field, .. } if field == "confirmedUnknown"),
        "error must be Validation on confirmedUnknown, got: {err}"
    );

    // Cleanup: abort so LocalStack stays clean.
    client
        .abort_multipart_upload()
        .bucket(&test_bucket)
        .key("guarded/object.bin")
        .upload_id(&upload_id)
        .send()
        .await
        .expect("cleanup abort must succeed");
}

// ---------------------------------------------------------------------------
// Test 3: Unknown + confirmed_unknown = true → succeeds
// ---------------------------------------------------------------------------

/// Verify that aborting an `Unknown`-sourced upload with
/// `confirmed_unknown = true` succeeds and the upload disappears from the
/// subsequent `list_multipart_uploads` result.
#[cfg(feature = "integration")]
#[tokio::test]
async fn abort_unknown_with_confirmation_succeeds() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        s3::multipart::{abort_multipart_upload, scan_multipart_uploads, MultipartSource},
    };

    let (client, profile_id) = make_client(&url).await;
    let table = make_multipart_table();

    let test_bucket = format!(
        "test-mpu-confirm-{}",
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

    let create_resp = client
        .create_multipart_upload()
        .bucket(&test_bucket)
        .key("confirmed/object.bin")
        .send()
        .await
        .expect("create_multipart_upload must succeed");

    let upload_id = create_resp.upload_id.expect("must return an upload_id");

    let bucket_id = BucketId::new(&test_bucket);

    // Abort with confirmation — must succeed.
    abort_multipart_upload(
        &client,
        &bucket_id,
        "confirmed/object.bin",
        &upload_id,
        MultipartSource::Unknown,
        &table,
        &profile_id,
        true, // confirmed_unknown = true
    )
    .await
    .expect("abort with confirmation must succeed");

    // Verify the upload is gone from the bucket.
    let remaining = scan_multipart_uploads(&client, &bucket_id, &table, None)
        .await
        .expect("scan after abort must succeed");

    assert!(
        remaining.iter().all(|u| u.upload_id != upload_id),
        "aborted upload must not appear in subsequent scan"
    );
}

// ---------------------------------------------------------------------------
// Test 4: Brows3r-sourced upload aborts without confirmation and removes record
// ---------------------------------------------------------------------------

/// Verify that a `Brows3r`-sourced upload (present in our table) can be
/// aborted without a confirmation flag, and the record is removed from the
/// `multipart_active` table afterwards.
#[cfg(feature = "integration")]
#[tokio::test]
async fn brows3r_abort_succeeds_and_removes_record() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        s3::multipart::{
            abort_multipart_upload, scan_multipart_uploads, MultipartRecord, MultipartSource,
        },
    };

    let (client, profile_id) = make_client(&url).await;
    let table = make_multipart_table();

    let test_bucket = format!(
        "test-mpu-brows3r-{}",
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

    let create_resp = client
        .create_multipart_upload()
        .bucket(&test_bucket)
        .key("brows3r/object.bin")
        .send()
        .await
        .expect("create_multipart_upload must succeed");

    let upload_id = create_resp.upload_id.expect("must return an upload_id");

    let bucket_id = BucketId::new(&test_bucket);

    // Register the upload in our bookkeeping table (simulates what upload_object does).
    let record = MultipartRecord {
        upload_id: upload_id.clone(),
        started_at: 1_700_000_000_000,
        source: "brows3r".to_owned(),
        profile_id: profile_id.clone(),
        bucket: bucket_id.clone(),
        key: "brows3r/object.bin".to_owned(),
    };
    table.record(&record).expect("record must succeed");

    // Scan: upload must appear as Brows3r.
    let uploads = scan_multipart_uploads(&client, &bucket_id, &table, None)
        .await
        .expect("scan must succeed");

    let found = uploads
        .iter()
        .find(|u| u.upload_id == upload_id)
        .expect("brows3r upload must appear in scan");
    assert_eq!(found.source, MultipartSource::Brows3r);

    // Abort without confirmation — must succeed for Brows3r-sourced uploads.
    abort_multipart_upload(
        &client,
        &bucket_id,
        "brows3r/object.bin",
        &upload_id,
        MultipartSource::Brows3r,
        &table,
        &profile_id,
        false, // confirmed_unknown not needed for Brows3r
    )
    .await
    .expect("brows3r abort must succeed without confirmation");

    // Verify the record was removed from the bookkeeping table.
    let still_there = table
        .find_by_upload_id(&upload_id)
        .expect("find_by_upload_id must not error");
    assert!(
        still_there.is_none(),
        "record must be removed from table after successful brows3r abort"
    );
}
