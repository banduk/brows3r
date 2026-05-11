//! MinIO contract tests — upload + list with path-style and checksum disabled.
//!
//! These tests are gated by two conditions:
//!
//! 1. The `minio_contract` cargo feature must be enabled.
//! 2. The `MINIO_URL` environment variable must be set at runtime.
//!
//! Both conditions must hold for the tests to run. If either is absent the
//! test body returns early (no assertion failure) so the CI unit-test job
//! stays green.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 9000:9000 -p 9001:9001 \
//!   -e MINIO_ROOT_USER=minioadmin \
//!   -e MINIO_ROOT_PASSWORD=minioadmin \
//!   quay.io/minio/minio server /data --console-address ":9001"
//!
//! MINIO_URL=http://localhost:9000 cargo test --features minio_contract \
//!   --test minio_contract
//! ```
//!
//! # Flags under test
//!
//! - `addressing_style = Path`   → `force_path_style=true`
//! - `checksum_mode = Disabled`  → `request_checksum_calculation=WhenRequired`

use std::sync::Arc;

#[cfg_attr(not(feature = "minio_contract"), ignore)]
#[tokio::test]
async fn minio_upload_and_list_with_path_style_and_checksum_disabled() {
    // Runtime gate: if MINIO_URL is not set, skip silently.
    let minio_url = match std::env::var("MINIO_URL") {
        Ok(url) => url,
        Err(_) => return,
    };

    use aws_credential_types::provider::SharedCredentialsProvider;
    use aws_credential_types::Credentials;
    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, ChecksumMode, CompatFlags},
        s3::{ClientPool, ProxyConfig},
    };

    // MinIO default root credentials (adjust via env if needed).
    let access_key = std::env::var("MINIO_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".to_string());
    let secret_key = std::env::var("MINIO_SECRET_KEY").unwrap_or_else(|_| "minioadmin".to_string());

    let _creds = SharedCredentialsProvider::new(Credentials::new(
        &access_key,
        &secret_key,
        None,
        None,
        "minio_contract_test",
    ));

    let flags = CompatFlags {
        endpoint_url: Some(minio_url.clone()),
        addressing_style: AddressingStyle::Path,
        checksum_mode: ChecksumMode::Disabled,
        ..Default::default()
    };

    // Build a client via the pool to exercise the full apply-flags path.
    let profile_id = ProfileId::new("minio-contract-test");
    let pool = Arc::new(ClientPool::new(ProxyConfig::None));
    pool.register_profile(profile_id.clone(), flags).await;

    let client = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("pool must return a client for a registered profile");

    // ------------------------------------------------------------------
    // Create test bucket (idempotent — ignore AlreadyOwnedByYou errors).
    // ------------------------------------------------------------------
    let bucket = "brows3r-contract-test";
    let create_result = client.create_bucket().bucket(bucket).send().await;
    match create_result {
        Ok(_) => {}
        Err(e) => {
            let err_str = format!("{e:?}");
            // MinIO returns BucketAlreadyOwnedByYou when the bucket exists.
            if !err_str.contains("BucketAlreadyOwnedByYou")
                && !err_str.contains("BucketAlreadyExists")
            {
                panic!("create_bucket failed: {err_str}");
            }
        }
    }

    // ------------------------------------------------------------------
    // Upload a small object.
    // ------------------------------------------------------------------
    let key = "contract-test-object.txt";
    let body = b"hello from brows3r contract test".to_vec();
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(body.into())
        .send()
        .await
        .expect("put_object must succeed against MinIO with path_style + checksum_disabled");

    // ------------------------------------------------------------------
    // List the bucket and verify the object is present.
    // ------------------------------------------------------------------
    let list = client
        .list_objects_v2()
        .bucket(bucket)
        .send()
        .await
        .expect("list_objects_v2 must succeed");

    let contents = list.contents();
    let found = contents
        .iter()
        .any(|obj| obj.key().map(|k| k == key).unwrap_or(false));
    assert!(
        found,
        "Uploaded object '{key}' must appear in list_objects_v2 response; \
         got: {:?}",
        contents.iter().map(|o| o.key()).collect::<Vec<_>>()
    );

    // ------------------------------------------------------------------
    // Clean up — delete the test object.
    // ------------------------------------------------------------------
    client
        .delete_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .expect("delete_object must succeed");
}
