//! Integration tests for single-part and multipart upload against a real
//! S3-compatible endpoint.
//!
//! These tests are gated by two conditions:
//!
//! 1. The `integration` cargo feature must be enabled (`--features integration`).
//! 2. The `LOCALSTACK_URL` environment variable must be set at runtime.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test transfer_upload_integration
//! ```

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Local EventRecorder — mirrors MockChannel without #[cfg(test)] gate
// ---------------------------------------------------------------------------

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
            .push((kind.as_str().to_owned(), value));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helper: build client + bucket + multipart table
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
        redb::Database::create(dir.path().join("test_multipart.redb"))
            .expect("test redb must open"),
    );
    // Keep `dir` alive for the test duration — leak it.
    std::mem::forget(dir);
    std::sync::Arc::new(MultipartTable::new(db).expect("multipart table must open"))
}

// ---------------------------------------------------------------------------
// Test 1: Single-part upload — 1 MB file
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn localstack_single_part_upload_1mb() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        locks::LockRegistry,
        transfers::{
            upload::upload_object, Transfer, TransferKind, TransferRegistryHandle, TransferState,
        },
    };
    use std::sync::{atomic::AtomicBool, Arc};
    use tempfile::tempdir;

    let (client, profile_id) = make_client(&url).await;

    let test_bucket = format!(
        "test-ul-single-{}",
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

    // Create a 1 MB source file.
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("source_1mb.bin");
    let data: Vec<u8> = (0u8..=255).cycle().take(1024 * 1024).collect();
    tokio::fs::write(&source_path, &data)
        .await
        .expect("write source file must succeed");

    let key = "uploads/single_1mb.bin".to_string();

    let registry = TransferRegistryHandle::default();
    let lock_registry = Arc::new(LockRegistry::new());
    let channel = EventRecorder::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let multipart_table = make_multipart_table();

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Upload,
        profile_id: profile_id.clone(),
        bucket: BucketId::new(test_bucket.clone()),
        key: key.clone(),
        source_path: Some(source_path.clone()),
        dest_path: None,
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: 0,
        finished_at: None,
        error: None,
    };

    {
        let mut reg = registry.0.write().await;
        let _ = reg.register(transfer);
    }

    let log = brows3r_lib::notifications::NotificationLogHandle::default();
    let os_notifier = brows3r_lib::notifications::os::OsNotifier::noop();
    let result = upload_object(
        client.clone(),
        BucketId::new(test_bucket.clone()),
        key.clone(),
        source_path,
        request_id.clone(),
        &channel,
        registry.clone(),
        lock_registry.clone(),
        Arc::clone(&multipart_table),
        4,
        profile_id.clone(),
        300,
        cancel_flag,
        log,
        &os_notifier,
    )
    .await;

    assert!(
        result.is_ok(),
        "upload_object must succeed: {:?}",
        result.err()
    );

    // Verify the object exists on S3 with the right size.
    let head = client
        .head_object()
        .bucket(&test_bucket)
        .key(&key)
        .send()
        .await
        .expect("head_object must succeed");
    assert_eq!(
        head.content_length().unwrap_or(0) as usize,
        data.len(),
        "uploaded object size must match"
    );

    // Verify objects:updated event was emitted with correct payload.
    let events = channel.emitted();
    let updated: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "objects:updated")
        .collect();
    assert_eq!(
        updated.len(),
        1,
        "exactly one objects:updated event must be emitted"
    );
    assert_eq!(
        updated[0].1["profileId"].as_str().unwrap(),
        profile_id.as_str(),
        "objects:updated must carry correct profileId"
    );
    assert_eq!(
        updated[0].1["bucket"].as_str().unwrap(),
        test_bucket,
        "objects:updated must carry correct bucket"
    );
    // Prefix for "uploads/single_1mb.bin" → "uploads/"
    assert_eq!(
        updated[0].1["prefix"].as_str().unwrap(),
        "uploads/",
        "objects:updated must carry correct prefix"
    );

    // Verify multipart_active table is empty (single-part upload never touches it).
    let all = multipart_table.list_all().expect("list_all must succeed");
    assert!(
        all.is_empty(),
        "multipart_active must be empty after single-part upload"
    );

    // Terminal state must be 'done'.
    let state_events: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "transfer:state")
        .collect();
    let last_state = state_events
        .iter()
        .last()
        .expect("at least one state event");
    assert_eq!(last_state.1["state"].as_str().unwrap(), "done");

    // Cleanup.
    let _ = client
        .delete_object()
        .bucket(&test_bucket)
        .key(&key)
        .send()
        .await;
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Test 2: Multipart upload — 20 MB file, verify ETag has "-N" suffix
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn localstack_multipart_upload_20mb_etag_suffix() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        locks::LockRegistry,
        transfers::{
            upload::upload_object, Transfer, TransferKind, TransferRegistryHandle, TransferState,
        },
    };
    use std::sync::{atomic::AtomicBool, Arc};
    use tempfile::tempdir;

    let (client, profile_id) = make_client(&url).await;

    let test_bucket = format!(
        "test-ul-multi-{}",
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

    // Create a 20 MB source file (above 5 MB single-part threshold → multipart).
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("source_20mb.bin");
    let data: Vec<u8> = (0u8..=255).cycle().take(20 * 1024 * 1024).collect();
    tokio::fs::write(&source_path, &data)
        .await
        .expect("write source file must succeed");

    let key = "uploads/multi_20mb.bin".to_string();

    let registry = TransferRegistryHandle::default();
    let lock_registry = Arc::new(LockRegistry::new());
    let channel = EventRecorder::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let multipart_table = make_multipart_table();

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Upload,
        profile_id: profile_id.clone(),
        bucket: BucketId::new(test_bucket.clone()),
        key: key.clone(),
        source_path: Some(source_path.clone()),
        dest_path: None,
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: 0,
        finished_at: None,
        error: None,
    };

    {
        let mut reg = registry.0.write().await;
        let _ = reg.register(transfer);
    }

    let log = brows3r_lib::notifications::NotificationLogHandle::default();
    let os_notifier = brows3r_lib::notifications::os::OsNotifier::noop();
    let result = upload_object(
        client.clone(),
        BucketId::new(test_bucket.clone()),
        key.clone(),
        source_path,
        request_id.clone(),
        &channel,
        registry.clone(),
        lock_registry.clone(),
        Arc::clone(&multipart_table),
        4,
        profile_id.clone(),
        300,
        cancel_flag,
        log,
        &os_notifier,
    )
    .await;

    assert!(
        result.is_ok(),
        "multipart upload must succeed: {:?}",
        result.err()
    );

    // Verify via head_object: size correct.
    let head = client
        .head_object()
        .bucket(&test_bucket)
        .key(&key)
        .send()
        .await
        .expect("head_object must succeed");
    assert_eq!(
        head.content_length().unwrap_or(0) as usize,
        data.len(),
        "object size must match after multipart upload"
    );

    // ETag for multipart uploads contains a '-' followed by part count.
    // e.g. "\"d8e8fca2dc0f896fd7cb4cb0031ba249-3\""
    let etag = head.e_tag().unwrap_or("");
    assert!(
        etag.contains('-'),
        "multipart ETag must contain '-N' suffix, got: {etag}"
    );

    // Verify multipart_active is empty after completion.
    let all = multipart_table.list_all().expect("list_all must succeed");
    assert!(
        all.is_empty(),
        "multipart_active must be empty after successful complete"
    );

    // Verify objects:updated event emitted.
    let events = channel.emitted();
    let updated: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "objects:updated")
        .collect();
    assert_eq!(updated.len(), 1, "one objects:updated must be emitted");

    // Cleanup.
    let _ = client
        .delete_object()
        .bucket(&test_bucket)
        .key(&key)
        .send()
        .await;
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Test 3: Cancel multipart mid-upload — no orphan parts, table empty
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn localstack_cancel_multipart_leaves_no_orphan_parts() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        locks::LockRegistry,
        transfers::{
            upload::upload_object, Transfer, TransferKind, TransferRegistryHandle, TransferState,
        },
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tempfile::tempdir;

    let (client, profile_id) = make_client(&url).await;

    let test_bucket = format!(
        "test-ul-cancel-{}",
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

    // Create a 10 MB source file (above 5 MB threshold → multipart).
    let dir = tempdir().unwrap();
    let source_path = dir.path().join("source_cancel.bin");
    let data: Vec<u8> = (0u8..=255).cycle().take(10 * 1024 * 1024).collect();
    tokio::fs::write(&source_path, &data)
        .await
        .expect("write source file must succeed");

    let key = "uploads/cancel_target.bin".to_string();

    let registry = TransferRegistryHandle::default();
    let lock_registry = Arc::new(LockRegistry::new());
    let channel = EventRecorder::default();
    let request_id = uuid::Uuid::new_v4().to_string();

    // Set cancel flag before calling upload_object — upload checks it before
    // initiating create_multipart_upload.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_flag_clone = Arc::clone(&cancel_flag);

    let multipart_table = make_multipart_table();

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Upload,
        profile_id: profile_id.clone(),
        bucket: BucketId::new(test_bucket.clone()),
        key: key.clone(),
        source_path: Some(source_path.clone()),
        dest_path: None,
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: 0,
        finished_at: None,
        error: None,
    };

    {
        let mut reg = registry.0.write().await;
        let _ = reg.register(transfer);
    }

    // Cancel after a short delay so the upload gets past CreateMultipartUpload.
    tokio::spawn({
        let flag = Arc::clone(&cancel_flag_clone);
        async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            flag.store(true, Ordering::Release);
        }
    });

    let log = brows3r_lib::notifications::NotificationLogHandle::default();
    let os_notifier = brows3r_lib::notifications::os::OsNotifier::noop();
    let result = upload_object(
        client.clone(),
        BucketId::new(test_bucket.clone()),
        key.clone(),
        source_path,
        request_id.clone(),
        &channel,
        registry.clone(),
        lock_registry.clone(),
        Arc::clone(&multipart_table),
        1, // single-threaded part upload to make cancel more predictable
        profile_id.clone(),
        300,
        cancel_flag,
        log,
        &os_notifier,
    )
    .await;

    // Either Cancelled or Ok depending on exact timing — both are valid.
    // The key invariants are:
    // 1. No ongoing multipart uploads in S3.
    // 2. multipart_active table is empty.
    let _ = result;

    // 1. S3 list_multipart_uploads must be empty for this key.
    let list_resp = client
        .list_multipart_uploads()
        .bucket(&test_bucket)
        .prefix(&key)
        .send()
        .await
        .expect("list_multipart_uploads must succeed");
    let ongoing = list_resp.uploads().len();
    assert_eq!(
        ongoing, 0,
        "no ongoing multipart uploads must remain after cancel"
    );

    // 2. multipart_active table must be empty for this key.
    let records = multipart_table
        .list_for_profile(&profile_id)
        .expect("list_for_profile must succeed");
    let in_table: Vec<_> = records
        .iter()
        .filter(|r| r.key == key && r.bucket.as_str() == test_bucket)
        .collect();
    assert!(
        in_table.is_empty(),
        "multipart_active must be empty for this key after cancel/complete"
    );

    // Cleanup.
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}
