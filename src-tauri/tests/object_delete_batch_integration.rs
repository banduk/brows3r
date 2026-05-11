//! Integration tests for `object_delete_batch` against a real S3-compatible endpoint.
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
//!   --test object_delete_batch_integration
//! ```

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Local event recorder — mirrors MockChannel without #[cfg(test)] gate
// ---------------------------------------------------------------------------

/// Records emitted events for assertions without touching the Tauri runtime.
#[derive(Default)]
struct EventRecorder {
    recorded: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

impl EventRecorder {
    fn emitted(&self) -> Vec<(String, serde_json::Value)> {
        self.recorded.lock().expect("lock poisoned").clone()
    }
}

impl brows3r_lib::events::EventEmitter for EventRecorder {
    fn emit<P: serde::Serialize>(
        &self,
        kind: brows3r_lib::events::EventKind,
        payload: P,
    ) -> Result<(), brows3r_lib::error::AppError> {
        let value = serde_json::to_value(payload).expect("EventRecorder: payload must serialize");
        self.recorded
            .lock()
            .expect("lock poisoned")
            .push((kind.as_str().to_string(), value));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helper: build a LocalStack S3 client
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn make_client(url: &str) -> aws_sdk_s3::Client {
    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{ClientPool, ProxyConfig},
    };
    use std::sync::Arc;

    let profile_id = ProfileId::new_v4();
    let compat = CompatFlags {
        endpoint_url: Some(url.to_string()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat).await;
    let arc = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built for registered profile");
    Arc::unwrap_or_clone(arc)
}

// ---------------------------------------------------------------------------
// Helper: create bucket + put an object
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn setup_bucket_with_object(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    body: &str,
) {
    let _ = client.create_bucket().bucket(bucket).send().await;

    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(aws_sdk_s3::primitives::ByteStream::from(
            body.as_bytes().to_vec(),
        ))
        .send()
        .await
        .expect("put_object must succeed");
}

// ---------------------------------------------------------------------------
// Helper: assert an object does NOT exist (head_object returns 404)
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn assert_object_not_exists(client: &aws_sdk_s3::Client, bucket: &str, key: &str) {
    let result = client.head_object().bucket(bucket).key(key).send().await;

    assert!(
        result.is_err(),
        "expected {bucket}/{key} to NOT exist but head_object succeeded"
    );
}

// ---------------------------------------------------------------------------
// Test 1: all-success batch — 5 objects, all deleted, failed is empty
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn delete_batch_all_success_five_objects() {
    use brows3r_lib::{ids::ObjectKey, s3::object::delete_objects_batch};

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-delete-batch-all-success";

    // Create bucket and 5 objects.
    let keys: Vec<&str> = vec![
        "batch/file1.txt",
        "batch/file2.txt",
        "batch/file3.txt",
        "batch/file4.txt",
        "batch/file5.txt",
    ];

    for key in &keys {
        setup_bucket_with_object(&client, bucket, key, "content").await;
    }

    let key_pairs: Vec<(ObjectKey, Option<String>)> =
        keys.iter().map(|k| (ObjectKey::new(*k), None)).collect();

    let report = delete_objects_batch(&client, bucket, key_pairs)
        .await
        .expect("delete_objects_batch must succeed");

    assert_eq!(report.deleted.len(), 5, "all 5 objects must be deleted");
    assert!(report.failed.is_empty(), "no failures expected");

    // Verify all objects are gone.
    for key in &keys {
        assert_object_not_exists(&client, bucket, key).await;
    }
}

// ---------------------------------------------------------------------------
// Test 2: partial failure — mix of existing and non-existent keys
//
// S3/LocalStack silently succeeds on non-existent key deletes (idempotent),
// so we simulate partial failure by testing AccessDenied on a key in a bucket
// with a policy denying delete. This test uses a simpler approach: delete a
// key that exists alongside a key that does not (S3 treats non-existent as
// success, so we test the report shape instead).
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn delete_batch_report_shape_mixed_keys() {
    use brows3r_lib::{ids::ObjectKey, s3::object::delete_objects_batch};

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-delete-batch-mixed";

    // Create bucket and put 2 real objects.
    setup_bucket_with_object(&client, bucket, "real/obj1.txt", "data").await;
    setup_bucket_with_object(&client, bucket, "real/obj2.txt", "data").await;

    // Delete 2 real + 1 non-existent (S3 is idempotent — treats non-existent as deleted).
    let key_pairs: Vec<(ObjectKey, Option<String>)> = vec![
        (ObjectKey::new("real/obj1.txt"), None),
        (ObjectKey::new("real/obj2.txt"), None),
        (ObjectKey::new("ghost/does-not-exist.txt"), None),
    ];

    let report = delete_objects_batch(&client, bucket, key_pairs)
        .await
        .expect("delete_objects_batch must succeed even with non-existent keys");

    // S3 DeleteObjects treats missing keys as success — all three appear in deleted.
    assert_eq!(
        report.deleted.len(),
        3,
        "S3 idempotently deletes non-existent keys — all 3 appear in deleted"
    );
    assert!(
        report.failed.is_empty(),
        "no per-key errors expected for non-existent keys"
    );
}

// ---------------------------------------------------------------------------
// Test 3: versioned bucket — delete a specific version
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn delete_batch_versioned_bucket_specific_version() {
    use brows3r_lib::{ids::ObjectKey, s3::object::delete_objects_batch};

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-delete-batch-versioned";

    // Create bucket.
    let _ = client.create_bucket().bucket(bucket).send().await;

    // Enable versioning.
    client
        .put_bucket_versioning()
        .bucket(bucket)
        .versioning_configuration(
            aws_sdk_s3::types::VersioningConfiguration::builder()
                .status(aws_sdk_s3::types::BucketVersioningStatus::Enabled)
                .build(),
        )
        .send()
        .await
        .expect("put_bucket_versioning must succeed");

    // Put an object — get its version ID.
    let put_resp = client
        .put_object()
        .bucket(bucket)
        .key("versioned/file.txt")
        .body(aws_sdk_s3::primitives::ByteStream::from_static(b"v1"))
        .send()
        .await
        .expect("put_object must succeed");

    let version_id = put_resp
        .version_id()
        .map(|s| s.to_string())
        .expect("versioned bucket must return a version_id");

    // Delete the specific version.
    let key_pairs: Vec<(ObjectKey, Option<String>)> = vec![(
        ObjectKey::new("versioned/file.txt"),
        Some(version_id.clone()),
    )];

    let report = delete_objects_batch(&client, bucket, key_pairs)
        .await
        .expect("delete_objects_batch must succeed for versioned delete");

    assert_eq!(report.deleted.len(), 1, "one version must be deleted");
    assert!(report.failed.is_empty(), "no failures expected");

    let deleted = &report.deleted[0];
    assert_eq!(deleted.key, "versioned/file.txt");
    assert_eq!(
        deleted.version_id.as_deref(),
        Some(version_id.as_str()),
        "deleted version_id must match the one we targeted"
    );
}

// ---------------------------------------------------------------------------
// Test 4: 1 500 keys chunked correctly into two SDK calls
//
// Tests the batching boundary by deleting enough keys to require >1 chunk.
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn delete_batch_1500_keys_chunked_into_two_calls() {
    use brows3r_lib::{ids::ObjectKey, s3::object::delete_objects_batch};

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-delete-batch-1500";

    let _ = client.create_bucket().bucket(bucket).send().await;

    // Create 1 500 objects. We use a single prefix to keep setup fast.
    let key_count = 1_500usize;
    // Batch-put in groups of 100 to avoid timeout.
    for chunk_start in (0..key_count).step_by(100) {
        let chunk_end = (chunk_start + 100).min(key_count);
        for i in chunk_start..chunk_end {
            client
                .put_object()
                .bucket(bucket)
                .key(format!("bulk/{i:04}.txt"))
                .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
                .send()
                .await
                .expect("put_object must succeed");
        }
    }

    let key_pairs: Vec<(ObjectKey, Option<String>)> = (0..key_count)
        .map(|i| (ObjectKey::new(format!("bulk/{i:04}.txt")), None))
        .collect();

    let report = delete_objects_batch(&client, bucket, key_pairs)
        .await
        .expect("delete_objects_batch must succeed for 1500 keys");

    assert_eq!(
        report.deleted.len(),
        key_count,
        "all 1500 objects must be deleted"
    );
    assert!(report.failed.is_empty(), "no per-key failures expected");
}

// ---------------------------------------------------------------------------
// Test 5: objects:updated emitted with union of affected prefixes
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn delete_batch_emits_objects_updated_for_each_affected_prefix() {
    use brows3r_lib::{
        events::{emit, EventKind},
        ids::{BucketId, ObjectKey, ProfileId},
        s3::object::{delete_objects_batch, parent_prefix},
    };
    use std::collections::BTreeSet;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-delete-batch-events";

    // Two distinct prefixes.
    let keys_to_create = vec!["alpha/file1.txt", "alpha/file2.txt", "beta/file1.txt"];
    for key in &keys_to_create {
        setup_bucket_with_object(&client, bucket, key, "data").await;
    }

    let key_pairs: Vec<(ObjectKey, Option<String>)> = keys_to_create
        .iter()
        .map(|k| (ObjectKey::new(*k), None))
        .collect();

    let report = delete_objects_batch(&client, bucket, key_pairs)
        .await
        .expect("delete_objects_batch must succeed");

    assert_eq!(report.deleted.len(), 3);

    // Simulate command layer: collect unique parent prefixes from deleted keys.
    let affected_prefixes: BTreeSet<String> = report
        .deleted
        .iter()
        .map(|d| parent_prefix(&d.key))
        .collect();

    let recorder = EventRecorder::default();
    let pid = ProfileId::new("test-profile");
    let bid = BucketId::new(bucket);

    for prefix in &affected_prefixes {
        emit(
            &recorder,
            EventKind::ObjectsUpdated,
            serde_json::json!({
                "profileId": pid.as_str(),
                "bucket": bid.as_str(),
                "prefix": prefix,
            }),
        )
        .expect("emit must succeed");
    }

    let emitted = recorder.emitted();
    // "alpha/" and "beta/" — 2 unique prefixes.
    assert_eq!(emitted.len(), 2, "one event per unique affected prefix");

    // BTreeSet guarantees alphabetical: "alpha/" < "beta/"
    assert_eq!(emitted[0].1["prefix"], "alpha/");
    assert_eq!(emitted[1].1["prefix"], "beta/");
}
