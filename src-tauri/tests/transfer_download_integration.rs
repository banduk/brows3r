//! Integration tests for streaming download against a real S3-compatible endpoint.
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
//!   --test transfer_download_integration
//! ```

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Local event recorder — mirrors MockChannel but without #[cfg(test)] gate
// ---------------------------------------------------------------------------

/// Records every emitted event for test assertions.
///
/// We define this locally because `events::MockChannel` is `#[cfg(test)]`-gated
/// in the library and is therefore not accessible from external test crates.
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
// Helper: build a client pointing at LocalStack
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

// ---------------------------------------------------------------------------
// Happy path: 5 MB blob, byte equality, ≥1 progress event per 256 KB
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn localstack_download_5mb_byte_equality_and_progress_events() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        locks::LockRegistry,
        transfers::{
            download::download_object, Transfer, TransferKind, TransferRegistryHandle,
            TransferState,
        },
    };
    use std::sync::Arc;
    use tempfile::tempdir;

    let (client, profile_id) = make_client(&url).await;

    // Create a test bucket.
    let test_bucket = format!(
        "test-dl-{}",
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

    // Upload a 5 MB blob.
    let data: Vec<u8> = (0u8..=255).cycle().take(5 * 1024 * 1024).collect();
    let key = "test/5mb.bin".to_string();
    client
        .put_object()
        .bucket(&test_bucket)
        .key(&key)
        .body(aws_sdk_s3::primitives::ByteStream::from(data.clone()))
        .send()
        .await
        .expect("put_object must succeed");

    // Set up registry and lock registry.
    let registry = TransferRegistryHandle::default();
    let lock_registry = Arc::new(LockRegistry::new());
    let channel = EventRecorder::default();
    let request_id = uuid::Uuid::new_v4().to_string();

    let dir = tempdir().unwrap();
    let dest_path = dir.path().join("5mb_output.bin");

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Download,
        profile_id: profile_id.clone(),
        bucket: BucketId::new(test_bucket.clone()),
        key: key.clone(),
        source_path: None,
        dest_path: Some(dest_path.clone()),
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: 0,
        finished_at: None,
        error: None,
    };

    let cancel_rx = {
        let mut reg = registry.0.write().await;
        let (_, rx) = reg.register(transfer);
        rx
    };

    // Run the download.
    let log = brows3r_lib::notifications::NotificationLogHandle::default();
    let os_notifier = brows3r_lib::notifications::os::OsNotifier::noop();
    let result = download_object(
        client.clone(),
        BucketId::new(test_bucket.clone()),
        key.clone(),
        dest_path.clone(),
        request_id.clone(),
        &channel,
        registry.clone(),
        lock_registry.clone(),
        cancel_rx,
        profile_id.clone(),
        300,
        log,
        &os_notifier,
    )
    .await;

    assert!(
        result.is_ok(),
        "download_object must succeed: {:?}",
        result.err()
    );

    // Verify byte equality.
    let downloaded = tokio::fs::read(&dest_path)
        .await
        .expect("downloaded file must be readable");
    assert_eq!(
        downloaded.len(),
        data.len(),
        "downloaded file size must match"
    );
    assert_eq!(
        downloaded, data,
        "downloaded bytes must be identical to uploaded bytes"
    );

    // Verify partial file was removed.
    let mut partial_path = dest_path.clone();
    let pname = partial_path
        .file_name()
        .map(|n| format!("{}.partial", n.to_string_lossy()))
        .unwrap_or_default();
    partial_path.set_file_name(&pname);
    assert!(
        !partial_path.exists(),
        ".partial file must be removed after successful download"
    );

    // Verify progress events: 5 MB / 256 KB = ~20 chunks, expect ≥1 per 256 KB.
    let events = channel.emitted();
    let progress_events: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "transfer:progress")
        .collect();
    let expected_min = 5 * 1024 * 1024 / 262_144; // ≥20 progress events
    assert!(
        progress_events.len() >= expected_min,
        "expected ≥{expected_min} progress events, got {}",
        progress_events.len()
    );
    for (_, payload) in &progress_events {
        assert_eq!(
            payload["requestId"].as_str().unwrap(),
            request_id,
            "every progress event must carry the correct requestId"
        );
    }

    // Verify terminal state event is Done.
    let state_events: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "transfer:state")
        .collect();
    let last_state = state_events
        .iter()
        .last()
        .expect("at least one state event must be emitted");
    assert_eq!(
        last_state.1["state"].as_str().unwrap(),
        "done",
        "final state must be 'done'"
    );

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
// Cancel test: spawn download, cancel, assert .partial removed + state Canceled
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
#[tokio::test]
async fn localstack_download_cancel_cleans_partial_and_emits_canceled() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        ids::BucketId,
        locks::LockRegistry,
        transfers::{
            download::download_object, Transfer, TransferKind, TransferRegistryHandle,
            TransferState,
        },
    };
    use std::sync::Arc;
    use tempfile::tempdir;

    let (client, profile_id) = make_client(&url).await;

    // Create a test bucket and a 5 MB object.
    let test_bucket = format!(
        "test-dl-cancel-{}",
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

    let data: Vec<u8> = (0u8..=255).cycle().take(5 * 1024 * 1024).collect();
    let key = "test/cancel_target.bin".to_string();
    client
        .put_object()
        .bucket(&test_bucket)
        .key(&key)
        .body(aws_sdk_s3::primitives::ByteStream::from(data))
        .send()
        .await
        .expect("put_object must succeed");

    let registry = TransferRegistryHandle::default();
    let lock_registry = Arc::new(LockRegistry::new());
    let channel = EventRecorder::default();
    let request_id = uuid::Uuid::new_v4().to_string();

    let dir = tempdir().unwrap();
    let dest_path = dir.path().join("cancel_output.bin");

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Download,
        profile_id: profile_id.clone(),
        bucket: BucketId::new(test_bucket.clone()),
        key: key.clone(),
        source_path: None,
        dest_path: Some(dest_path.clone()),
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: 0,
        finished_at: None,
        error: None,
    };

    let cancel_rx = {
        let mut reg = registry.0.write().await;
        let (_, rx) = reg.register(transfer);
        rx
    };

    // Cancel immediately — the download will see the cancel signal between
    // the first chunk and the next.
    {
        let mut reg = registry.0.write().await;
        reg.cancel(&request_id).expect("cancel must succeed");
    }

    let log = brows3r_lib::notifications::NotificationLogHandle::default();
    let os_notifier = brows3r_lib::notifications::os::OsNotifier::noop();
    let result = download_object(
        client.clone(),
        BucketId::new(test_bucket.clone()),
        key.clone(),
        dest_path.clone(),
        request_id.clone(),
        &channel,
        registry.clone(),
        lock_registry.clone(),
        cancel_rx,
        profile_id.clone(),
        300,
        log,
        &os_notifier,
    )
    .await;

    // Cancel is encoded as Err(AppError::Cancelled).
    assert!(result.is_err(), "canceled download must return an error");

    // Partial file must not exist.
    let mut partial_path = dest_path.clone();
    let pname = partial_path
        .file_name()
        .map(|n| format!("{}.partial", n.to_string_lossy()))
        .unwrap_or_default();
    partial_path.set_file_name(&pname);
    assert!(
        !partial_path.exists(),
        ".partial file must be removed after cancellation"
    );

    // Final file must not exist.
    assert!(
        !dest_path.exists(),
        "final file must not exist after cancellation"
    );

    // State event must end with 'canceled'.
    let events = channel.emitted();
    let state_events: Vec<_> = events
        .iter()
        .filter(|(kind, _)| kind == "transfer:state")
        .collect();
    let last_state = state_events
        .iter()
        .last()
        .expect("at least one state event must be emitted");
    assert_eq!(
        last_state.1["state"].as_str().unwrap(),
        "canceled",
        "final state must be 'canceled'"
    );

    // Cleanup.
    let _ = client
        .delete_object()
        .bucket(&test_bucket)
        .key(&key)
        .send()
        .await;
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}
