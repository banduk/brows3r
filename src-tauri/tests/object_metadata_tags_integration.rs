//! Integration tests for `set_object_metadata` and `set_object_tags`
//! against a real S3-compatible endpoint.
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
//!   --test object_metadata_tags_integration
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

    let profile_id = ProfileId::new_v4();
    let compat = CompatFlags {
        endpoint_url: Some(url.to_string()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat).await;
    pool.get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built for registered profile")
}

// ---------------------------------------------------------------------------
// Helper: create bucket + put an object, return the ETag
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn setup_bucket_with_object(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    body: &str,
) -> String {
    client
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .unwrap_or_default();

    let resp = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(
            body.as_bytes(),
        ))
        .send()
        .await
        .expect("put_object must succeed");

    resp.e_tag()
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Test 1: metadata round-trip — set metadata, then verify via head_object
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn set_metadata_round_trip_via_head_object() {
    use brows3r_lib::s3::metadata::set_object_metadata;
    use std::collections::HashMap;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-metadata-roundtrip";
    let key = "docs/report.txt";

    setup_bucket_with_object(&client, bucket, key, "hello").await;

    let mut meta = HashMap::new();
    meta.insert("x-amz-meta-author".to_string(), "alice".to_string());
    meta.insert("x-amz-meta-version".to_string(), "2".to_string());

    set_object_metadata(&client, bucket, key, meta, None)
        .await
        .expect("set_object_metadata must succeed");

    // Verify via HeadObject.
    let head = client
        .head_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .expect("head_object must succeed");

    let stored_meta = head.metadata().cloned().unwrap_or_default();
    // S3 stores metadata keys without the "x-amz-meta-" prefix in the SDK response.
    assert_eq!(
        stored_meta.get("author").map(|s| s.as_str()),
        Some("alice"),
        "author metadata must be applied"
    );
    assert_eq!(
        stored_meta.get("version").map(|s| s.as_str()),
        Some("2"),
        "version metadata must be applied"
    );
}

// ---------------------------------------------------------------------------
// Test 2: tags round-trip — set tags, verify via get_object_tagging
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn set_tags_round_trip_via_get_object_tagging() {
    use brows3r_lib::s3::tags::set_object_tags;
    use std::collections::HashMap;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-tags-roundtrip";
    let key = "photos/image.jpg";

    setup_bucket_with_object(&client, bucket, key, "img").await;

    let mut tags = HashMap::new();
    tags.insert("env".to_string(), "prod".to_string());
    tags.insert("team".to_string(), "infra".to_string());

    set_object_tags(&client, bucket, key, tags, None)
        .await
        .expect("set_object_tags must succeed");

    // Verify via GetObjectTagging.
    let resp = client
        .get_object_tagging()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .expect("get_object_tagging must succeed");

    let tag_map: std::collections::HashMap<String, String> = resp
        .tag_set()
        .iter()
        .map(|t| (t.key().to_string(), t.value().to_string()))
        .collect();

    assert_eq!(tag_map.get("env").map(|s| s.as_str()), Some("prod"));
    assert_eq!(tag_map.get("team").map(|s| s.as_str()), Some("infra"));
}

// ---------------------------------------------------------------------------
// Test 3: ETag conflict — set_metadata with stale ETag → AppError::Conflict
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn set_metadata_etag_conflict_returns_conflict_error() {
    use brows3r_lib::{error::AppError, s3::metadata::set_object_metadata};
    use std::collections::HashMap;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-metadata-etag-conflict";
    let key = "data/file.txt";

    // PUT the object, capture original ETag.
    let original_etag = setup_bucket_with_object(&client, bucket, key, "v1").await;

    // Externally modify the object (new ETag).
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(b"v2"))
        .send()
        .await
        .expect("second put must succeed");

    // Now attempt set_metadata with the original (stale) ETag.
    let mut meta = HashMap::new();
    meta.insert("x-amz-meta-status".to_string(), "stale".to_string());

    let result = set_object_metadata(&client, bucket, key, meta, Some(original_etag.clone())).await;

    assert!(
        matches!(result, Err(AppError::Conflict { .. })),
        "stale ETag must produce Conflict, got: {result:?}"
    );
}

// ---------------------------------------------------------------------------
// Test 4: tag removal — set 3 tags, then set empty → get_object_tagging empty
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn set_empty_tags_removes_all_tags() {
    use brows3r_lib::s3::tags::set_object_tags;
    use std::collections::HashMap;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-tags-removal";
    let key = "archive/file.bin";

    setup_bucket_with_object(&client, bucket, key, "data").await;

    // Set 3 tags.
    let mut tags = HashMap::new();
    tags.insert("a".to_string(), "1".to_string());
    tags.insert("b".to_string(), "2".to_string());
    tags.insert("c".to_string(), "3".to_string());

    set_object_tags(&client, bucket, key, tags, None)
        .await
        .expect("set 3 tags must succeed");

    // Now set empty tags → should remove all.
    set_object_tags(&client, bucket, key, HashMap::new(), None)
        .await
        .expect("set empty tags (delete) must succeed");

    let resp = client
        .get_object_tagging()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .expect("get_object_tagging must succeed");

    assert!(
        resp.tag_set().is_empty(),
        "tag set must be empty after deletion, got: {:?}",
        resp.tag_set()
    );
}

// ---------------------------------------------------------------------------
// Test 5: objects:updated is emitted after set_metadata
// (round-1 finding #14)
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn set_metadata_emits_objects_updated_for_parent_prefix() {
    use brows3r_lib::{
        events::{emit, EventKind},
        ids::{BucketId, ProfileId},
        s3::{metadata::set_object_metadata, object::parent_prefix},
    };
    use std::collections::HashMap;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-metadata-event";
    let key = "reports/2024/annual.pdf";

    setup_bucket_with_object(&client, bucket, key, "pdf content").await;

    let mut meta = HashMap::new();
    meta.insert("x-amz-meta-status".to_string(), "final".to_string());

    set_object_metadata(&client, bucket, key, meta, None)
        .await
        .expect("set_object_metadata must succeed");

    // Simulate what the command layer does: emit objects:updated.
    let recorder = EventRecorder::default();
    let pid = ProfileId::new("test-profile");
    let bid = BucketId::new(bucket);
    let parent = parent_prefix(key);

    emit(
        &recorder,
        EventKind::ObjectsUpdated,
        serde_json::json!({
            "profileId": pid.as_str(),
            "bucket": bid.as_str(),
            "prefix": parent,
        }),
    )
    .expect("emit must succeed");

    let emitted = recorder.emitted();
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].0, "objects:updated");
    assert_eq!(emitted[0].1["prefix"], "reports/2024/");
}

// ---------------------------------------------------------------------------
// Test 6: objects:updated is emitted after set_tags
// (round-1 finding #14)
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn set_tags_emits_objects_updated_for_parent_prefix() {
    use brows3r_lib::{
        events::{emit, EventKind},
        ids::{BucketId, ProfileId},
        s3::{object::parent_prefix, tags::set_object_tags},
    };
    use std::collections::HashMap;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-tags-event";
    let key = "logs/app/server.log";

    setup_bucket_with_object(&client, bucket, key, "log entry").await;

    let mut tags = HashMap::new();
    tags.insert("retention".to_string(), "30d".to_string());

    set_object_tags(&client, bucket, key, tags, None)
        .await
        .expect("set_object_tags must succeed");

    let recorder = EventRecorder::default();
    let pid = ProfileId::new("test-profile");
    let bid = BucketId::new(bucket);
    let parent = parent_prefix(key);

    emit(
        &recorder,
        EventKind::ObjectsUpdated,
        serde_json::json!({
            "profileId": pid.as_str(),
            "bucket": bid.as_str(),
            "prefix": parent,
        }),
    )
    .expect("emit must succeed");

    let emitted = recorder.emitted();
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].0, "objects:updated");
    assert_eq!(emitted[0].1["prefix"], "logs/app/");
}
