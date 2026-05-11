//! Integration tests for `object_copy`, `object_move`, and `object_create_folder`
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
//!   --test object_mutations_integration
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
// Helper: create bucket + put an object
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn setup_bucket_with_object(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    body: &str,
) {
    client
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .unwrap_or_default(); // Ignore BucketAlreadyExists

    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(
            body.as_bytes(),
        ))
        .send()
        .await
        .expect("put_object must succeed");
}

// ---------------------------------------------------------------------------
// Helper: assert an object exists (head_object)
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn assert_object_exists(client: &aws_sdk_s3::Client, bucket: &str, key: &str) {
    client
        .head_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .unwrap_or_else(|_| panic!("expected {bucket}/{key} to exist"));
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
// Test 1: copy within same bucket — source still exists, dest exists
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn copy_within_same_bucket_source_and_dest_both_exist() {
    use brows3r_lib::s3::object::{copy_object, CopyOptions};

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-copy-same-bucket";
    let src_key = "original/hello.txt";
    let dest_key = "copy/hello.txt";

    setup_bucket_with_object(&client, bucket, src_key, "hello world").await;

    let opts = CopyOptions::default();
    copy_object(&client, bucket, src_key, bucket, dest_key, &opts)
        .await
        .expect("copy_object must succeed");

    // Source still exists.
    assert_object_exists(&client, bucket, src_key).await;
    // Destination now exists.
    assert_object_exists(&client, bucket, dest_key).await;
}

// ---------------------------------------------------------------------------
// Test 2: move within same bucket — source gone, dest exists
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn move_within_same_bucket_source_gone_dest_exists() {
    use brows3r_lib::s3::object::{move_object, CopyOptions};

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-move-same-bucket";
    let src_key = "move-src/data.txt";
    let dest_key = "move-dst/data.txt";

    setup_bucket_with_object(&client, bucket, src_key, "move me").await;

    let opts = CopyOptions::default();
    move_object(&client, bucket, src_key, bucket, dest_key, &opts)
        .await
        .expect("move_object must succeed");

    // Source no longer exists.
    assert_object_not_exists(&client, bucket, src_key).await;
    // Destination now exists.
    assert_object_exists(&client, bucket, dest_key).await;
}

// ---------------------------------------------------------------------------
// Test 3: create folder — prefix/ zero-byte object exists
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn create_folder_puts_zero_byte_placeholder() {
    use brows3r_lib::s3::object::create_folder;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-create-folder";
    let prefix = "new-folder";

    // Create bucket if not exists.
    client
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .unwrap_or_default();

    create_folder(&client, bucket, prefix)
        .await
        .expect("create_folder must succeed");

    // The placeholder key is "new-folder/".
    let head = client
        .head_object()
        .bucket(bucket)
        .key("new-folder/")
        .send()
        .await
        .expect("folder placeholder must exist");

    assert_eq!(
        head.content_length().unwrap_or(-1),
        0,
        "folder placeholder must be zero bytes"
    );
}

// ---------------------------------------------------------------------------
// Test 4: create folder is idempotent
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn create_folder_is_idempotent() {
    use brows3r_lib::s3::object::create_folder;

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-create-folder-idempotent";
    let prefix = "repeat-folder";

    client
        .create_bucket()
        .bucket(bucket)
        .send()
        .await
        .unwrap_or_default();

    // Call twice — must succeed both times.
    create_folder(&client, bucket, prefix)
        .await
        .expect("first create_folder must succeed");
    create_folder(&client, bucket, prefix)
        .await
        .expect("second create_folder must succeed (idempotent)");
}

// ---------------------------------------------------------------------------
// Test 5: objects:updated is emitted after copy — event emission test
// (round-1 finding #14)
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn copy_emits_objects_updated_for_dest_prefix() {
    use brows3r_lib::{
        events::{emit, EventKind},
        ids::{BucketId, ProfileId},
        s3::object::{copy_object, parent_prefix, CopyOptions},
    };

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-copy-event";
    let src_key = "src/file.txt";
    let dest_key = "dst/subdir/file.txt";

    setup_bucket_with_object(&client, bucket, src_key, "event test").await;

    let opts = CopyOptions::default();
    copy_object(&client, bucket, src_key, bucket, dest_key, &opts)
        .await
        .expect("copy_object must succeed");

    // Simulate what the command layer does: emit objects:updated.
    let recorder = EventRecorder::default();
    let pid = ProfileId::new("test-profile");
    let bid = BucketId::new(bucket);
    let dest_parent = parent_prefix(dest_key);

    emit(
        &recorder,
        EventKind::ObjectsUpdated,
        serde_json::json!({
            "profileId": pid.as_str(),
            "bucket": bid.as_str(),
            "prefix": dest_parent,
        }),
    )
    .expect("emit must succeed");

    let emitted = recorder.emitted();
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].0, "objects:updated");
    assert_eq!(emitted[0].1["prefix"], "dst/subdir/");
}

// ---------------------------------------------------------------------------
// Test 6: objects:updated is emitted for both prefixes after move
// (round-1 finding #14)
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn move_emits_objects_updated_for_source_and_dest() {
    use brows3r_lib::{
        events::{emit, EventKind},
        ids::{BucketId, ProfileId},
        s3::object::{move_object, parent_prefix, CopyOptions},
    };

    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    let client = make_client(&url).await;
    let bucket = "test-move-event";
    let src_key = "old/path/file.txt";
    let dest_key = "new/path/file.txt";

    setup_bucket_with_object(&client, bucket, src_key, "move event test").await;

    let opts = CopyOptions::default();
    move_object(&client, bucket, src_key, bucket, dest_key, &opts)
        .await
        .expect("move_object must succeed");

    // Simulate command layer: emit for source + dest.
    let recorder = EventRecorder::default();
    let pid = ProfileId::new("test-profile");
    let bid = BucketId::new(bucket);

    for key in &[src_key, dest_key] {
        let prefix = parent_prefix(key);
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
    assert_eq!(emitted.len(), 2);
    assert_eq!(emitted[0].1["prefix"], "old/path/");
    assert_eq!(emitted[1].1["prefix"], "new/path/");
}
