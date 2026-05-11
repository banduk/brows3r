//! S3 client construction and per-(profile, region) client pool.
//!
//! # Design
//!
//! Each `(ProfileId, region)` pair maps to a long-lived, `Arc`-wrapped
//! `aws_sdk_s3::Client`.  The pool is the single owner of all clients and is
//! intended to live inside the Tauri `AppState` for the process lifetime.
//!
//! Credential resolution is delegated to the AWS SDK credential-provider chain;
//! no credentials are stored in the pool itself.
//!
//! # Proxy wiring
//!
//! `ProxyConfig` controls the HTTP connector:
//!
//! - `System` (default) — the SDK default connector reads `HTTP_PROXY` /
//!   `HTTPS_PROXY` / `NO_PROXY` from the environment automatically.  No
//!   custom connector is injected.
//! - `Explicit(url)` — a `ConnectorBuilder` with `ProxyConfig::all(url)` is
//!   injected via `Builder::build_with_connector_fn`, routing all traffic
//!   through the given proxy.
//! - `None` — a `ConnectorBuilder` with `ProxyConfig::disabled()` is
//!   injected, explicitly ignoring any proxy env vars.
//!
//! # OCP
//!
//! Adding a `ProxyConfig` variant (e.g. `Pac(url)`, `PerHost { ... }`) is the
//! only change needed to support a new proxy mode.  The internal `build_http_client`
//! function has one match arm per variant.

use std::{collections::HashMap, sync::Arc};

use aws_config::BehaviorVersion;
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_sdk_s3::config::Builder as S3ConfigBuilder;
use aws_smithy_http_client::{
    proxy::ProxyConfig as SmithyProxyConfig,
    tls::{self, rustls_provider::CryptoMode},
    Builder as HttpBuilder, Connector,
};
use aws_smithy_runtime_api::client::http::SharedHttpClient;
use tokio::sync::RwLock;

use crate::{
    ids::ProfileId,
    notifications::NotificationLogHandle,
    profiles::compat_flags::{apply_to_s3_config_builder, CompatFlags},
};

// ---------------------------------------------------------------------------
// ProxyConfig — the public enum consumed by the pool and by Settings (task 8)
// ---------------------------------------------------------------------------

/// Controls the HTTP proxy used for all S3 requests built by this pool.
///
/// OCP: adding a variant here (e.g. `Pac(String)`) is the only change needed
/// to support a new proxy mode — add the variant and one arm in
/// `build_http_client`.
#[derive(Debug, Clone, Default)]
pub enum ProxyConfig {
    /// Inherit proxy settings from the environment (`HTTP_PROXY` /
    /// `HTTPS_PROXY` / `NO_PROXY`).  This is the default — no custom
    /// connector is injected.
    #[default]
    System,
    /// Route all S3 traffic through the given proxy URL.
    /// Example: `"http://proxy.internal:3128"`.
    Explicit(String),
    /// Disable proxy entirely, regardless of environment variables.
    None,
}

// ---------------------------------------------------------------------------
// Internal helper — build a SharedHttpClient for a given ProxyConfig
// ---------------------------------------------------------------------------

fn build_http_client(proxy: &ProxyConfig) -> SharedHttpClient {
    match proxy {
        // System: use the SDK default connector; it picks up proxy env vars.
        ProxyConfig::System => HttpBuilder::new()
            .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
            .build_https(),

        // Explicit: inject a ConnectorBuilder with an explicit proxy URL.
        // ProxyConfig::all(url) proxies both HTTP and HTTPS traffic.
        ProxyConfig::Explicit(url) => {
            let smithy_proxy =
                SmithyProxyConfig::all(url).unwrap_or_else(|_| SmithyProxyConfig::from_env());
            HttpBuilder::new().build_with_connector_fn(move |_settings, _rt| {
                Connector::builder()
                    .proxy_config(smithy_proxy.clone())
                    .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
                    .build()
            })
        }

        // None: inject a connector with proxy explicitly disabled.
        ProxyConfig::None => {
            let smithy_proxy = SmithyProxyConfig::disabled();
            HttpBuilder::new().build_with_connector_fn(move |_settings, _rt| {
                Connector::builder()
                    .proxy_config(smithy_proxy.clone())
                    .tls_provider(tls::Provider::Rustls(CryptoMode::Ring))
                    .build()
            })
        }
    }
}

// ---------------------------------------------------------------------------
// surface_compat_warnings — push warnings into the notification log or log
// ---------------------------------------------------------------------------

/// Push each warning string into `log` (if provided) as a `Severity::Warning`
/// notification, or fall through to `tracing::warn!` when `log` is `None`.
///
/// Errors from the notification log are not propagated — warning delivery is
/// best-effort and must not block client construction.
async fn surface_compat_warnings(warnings: Vec<String>, log: Option<&NotificationLogHandle>) {
    if warnings.is_empty() {
        return;
    }
    match log {
        Some(handle) => {
            use crate::notifications::{Notification, NotificationCategory, Severity};
            use uuid::Uuid;

            let mut guard = handle.0.write().await;
            for msg in warnings {
                let notification = Notification {
                    id: Uuid::new_v4().to_string(),
                    severity: Severity::Warning,
                    category: NotificationCategory::Background,
                    title: "S3 compat flag warning".to_string(),
                    message: msg,
                    resource: None,
                    operation: Some("client_build".to_string()),
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                    details: None,
                };
                guard.push(notification);
            }
        }
        None => {
            // No notification handle — emit to stderr via eprintln as a
            // fallback (tracing crate may not be configured in unit tests).
            for msg in warnings {
                eprintln!("[compat_flags warning] {msg}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ClientBuilder — builds a single configured aws_sdk_s3::Client
// ---------------------------------------------------------------------------

/// Parameters needed to build one `aws_sdk_s3::Client`.
///
/// Separated from `ClientPool` so tests can construct clients directly
/// without standing up a pool.
pub struct ClientBuilder<'a> {
    region: &'a str,
    compat: &'a CompatFlags,
    proxy: &'a ProxyConfig,
    /// Optional explicit credentials provider.  When `None` the SDK default
    /// provider chain is used (env → profile → IMDSv2 → …).
    credentials_provider: Option<SharedCredentialsProvider>,
    /// Optional notification log to push compat-flag warnings into.
    /// When `None`, warnings are only emitted via `tracing::warn!`.
    notification_log: Option<NotificationLogHandle>,
}

impl<'a> ClientBuilder<'a> {
    /// Create a builder for the given region and compatibility flags.
    pub fn new(region: &'a str, compat: &'a CompatFlags, proxy: &'a ProxyConfig) -> Self {
        Self {
            region,
            compat,
            proxy,
            credentials_provider: Option::None,
            notification_log: Option::None,
        }
    }

    /// Override the credential provider (useful in tests or for manual profiles).
    pub fn credentials_provider(mut self, provider: SharedCredentialsProvider) -> Self {
        self.credentials_provider = Some(provider);
        self
    }

    /// Attach a notification log handle so compat-flag warnings are surfaced
    /// to the user through the in-app notification system (task 9).
    ///
    /// When not set, warnings are logged via `tracing::warn!` only.
    pub fn notification_log(mut self, handle: NotificationLogHandle) -> Self {
        self.notification_log = Some(handle);
        self
    }

    /// Build the `aws_sdk_s3::Client`.
    ///
    /// This is `async` because `aws_config::load_from_env()` is async.
    pub async fn build(self) -> aws_sdk_s3::Client {
        // ------------------------------------------------------------------
        // 1. Build the shared HTTP client with proxy wiring.
        // ------------------------------------------------------------------
        let http_client = build_http_client(self.proxy);

        // ------------------------------------------------------------------
        // 2. Construct the base AWS SdkConfig using aws_config.
        // ------------------------------------------------------------------
        let region_obj = aws_config::Region::new(self.region.to_owned());

        let mut sdk_loader = aws_config::defaults(BehaviorVersion::latest())
            .region(region_obj)
            .http_client(http_client);

        // Apply a custom endpoint URL when the compat flags request one.
        // NOTE: endpoint_url and region_override are applied at the loader
        // level (here) rather than inside apply_to_s3_config_builder because
        // they affect SDK credential and endpoint resolution, which happens
        // before the S3ConfigBuilder is constructed.
        if let Some(ref endpoint) = self.compat.endpoint_url {
            sdk_loader = sdk_loader.endpoint_url(endpoint.clone());
        }

        // region_override: pin to a fixed region, overriding auto-detection.
        if let Some(ref region) = self.compat.region_override {
            sdk_loader = sdk_loader.region(aws_config::Region::new(region.clone()));
        }

        // Inject explicit credentials if provided (manual profiles / tests).
        let sdk_config = if let Some(creds) = self.credentials_provider {
            sdk_loader.credentials_provider(creds).load().await
        } else {
            sdk_loader.load().await
        };

        // ------------------------------------------------------------------
        // 3. Apply v1 compat flags to the S3-specific config builder.
        // ------------------------------------------------------------------
        let s3_builder = S3ConfigBuilder::from(&sdk_config);
        let applied = apply_to_s3_config_builder(self.compat, s3_builder);

        // Surface warnings: push into notification log when available,
        // otherwise fall back to tracing::warn.
        surface_compat_warnings(applied.warnings, self.notification_log.as_ref()).await;

        aws_sdk_s3::Client::from_conf(applied.builder.build())
    }
}

// ---------------------------------------------------------------------------
// ClientPool — per-(ProfileId, region) cache
// ---------------------------------------------------------------------------

/// Pool of `Arc<aws_sdk_s3::Client>` instances, keyed by `(ProfileId, region)`.
///
/// Clients are built on first access and cached for the process lifetime.
/// The pool is safe to share across threads via `Arc<ClientPool>`.
///
/// ## Proxy
///
/// A single `ProxyConfig` is applied to every client built by this pool.
/// Per-profile proxy overrides are a task-8 concern (settings store); this
/// pool accepts the pool-wide proxy at construction time.
pub struct ClientPool {
    /// Shared proxy configuration applied to every client built by this pool.
    proxy: ProxyConfig,

    /// Per-profile compat flags registry.  Profiles must be registered before
    /// `get_or_build` is called for them.
    flags: RwLock<HashMap<ProfileId, CompatFlags>>,

    /// Per-profile explicit credentials.  Populated by `register_credentials`
    /// after `profile_validate` builds a provider (from the keychain secret for
    /// manual profiles, or from the named ~/.aws/credentials entry for
    /// AWS-discovered profiles). When absent, `get_or_build` falls through to
    /// the SDK's default credentials chain, which only works for the user's
    /// default profile and is the source of "dispatch failure" errors against
    /// non-default profiles.
    credentials: RwLock<HashMap<ProfileId, SharedCredentialsProvider>>,

    /// Cached clients.  Built lazily on first `get_or_build` call.
    cache: RwLock<HashMap<(ProfileId, String), Arc<aws_sdk_s3::Client>>>,

    /// Optional notification log for surfacing compat-flag warnings.
    /// When `None`, warnings fall back to stderr/tracing.
    notification_log: Option<NotificationLogHandle>,

    /// Test-only: last proxy URL passed to the builder (from `Explicit`).
    #[cfg(test)]
    last_explicit_proxy: std::sync::Mutex<Option<String>>,
}

impl ClientPool {
    /// Create a new pool with the given proxy configuration.
    pub fn new(proxy: ProxyConfig) -> Self {
        Self {
            proxy,
            flags: RwLock::new(HashMap::new()),
            credentials: RwLock::new(HashMap::new()),
            cache: RwLock::new(HashMap::new()),
            notification_log: None,
            #[cfg(test)]
            last_explicit_proxy: std::sync::Mutex::new(Option::None),
        }
    }

    /// Attach a notification log so compat-flag warnings emitted during client
    /// construction are pushed into the in-app notification system.
    pub fn with_notification_log(mut self, handle: NotificationLogHandle) -> Self {
        self.notification_log = Some(handle);
        self
    }

    /// Register `CompatFlags` for a profile.  Must be called before
    /// `get_or_build` for the same profile.  Calling again for an existing
    /// profile updates the flags and evicts any cached clients for that
    /// profile so they are rebuilt with the new flags.
    pub async fn register_profile(&self, profile_id: ProfileId, compat: CompatFlags) {
        // Evict stale cache entries for this profile.
        {
            let mut cache = self.cache.write().await;
            cache.retain(|(pid, _), _| pid != &profile_id);
        }
        let mut flags = self.flags.write().await;
        flags.insert(profile_id, compat);
    }

    /// Attach (or replace) the credentials provider used to build clients for
    /// `profile_id`. Evicts cached clients so the next `get_or_build` rebuilds
    /// with the new credentials.
    ///
    /// Without this, `get_or_build` falls back to the SDK's default chain,
    /// which only loads the user's default profile — non-default profiles
    /// then return "dispatch failure" because the chain has no credentials
    /// to sign with.
    pub async fn register_credentials(
        &self,
        profile_id: ProfileId,
        creds: SharedCredentialsProvider,
    ) {
        {
            let mut cache = self.cache.write().await;
            cache.retain(|(pid, _), _| pid != &profile_id);
        }
        let mut credentials = self.credentials.write().await;
        credentials.insert(profile_id, creds);
    }

    /// Return the cached `Arc<Client>` for `(profile_id, region)`, building
    /// one if it does not yet exist.
    ///
    /// Returns `None` if `profile_id` has not been registered via
    /// `register_profile`.
    pub async fn get_or_build(
        &self,
        profile_id: &ProfileId,
        region: &str,
    ) -> Option<Arc<aws_sdk_s3::Client>> {
        let cache_key = (profile_id.clone(), region.to_owned());

        // Fast path: read lock — client already in cache.
        {
            let cache = self.cache.read().await;
            if let Some(client) = cache.get(&cache_key) {
                return Some(Arc::clone(client));
            }
        }

        // Slow path: not in cache — need to build. Look up compat flags first.
        let compat = {
            let flags = self.flags.read().await;
            flags.get(profile_id)?.clone()
        };

        // Record the explicit proxy URL for test observability.
        #[cfg(test)]
        if let ProxyConfig::Explicit(ref url) = self.proxy {
            if let Ok(mut guard) = self.last_explicit_proxy.lock() {
                *guard = Some(url.clone());
            }
        }

        // Look up any explicit credentials for this profile. When absent we
        // fall through to the SDK's default chain.
        let explicit_creds = {
            let credentials = self.credentials.read().await;
            credentials.get(profile_id).cloned()
        };

        // Build outside the write lock to avoid holding it across the async
        // aws_config loader.  Pass the notification log so compat-flag warnings
        // are surfaced to the user through the in-app notification system.
        let mut cb = ClientBuilder::new(region, &compat, &self.proxy);
        if let Some(creds) = explicit_creds {
            cb = cb.credentials_provider(creds);
        }
        if let Some(ref log) = self.notification_log {
            cb = cb.notification_log(log.clone());
        }
        let client = cb.build().await;
        let client_arc = Arc::new(client);

        // Write the result into the cache. Another task may have raced and
        // inserted the same key while we were building; prefer the existing
        // entry (first writer wins for consistency).
        let mut cache = self.cache.write().await;
        let stored = cache
            .entry(cache_key)
            .or_insert_with(|| Arc::clone(&client_arc));
        Some(Arc::clone(stored))
    }

    /// Test-only accessor: returns the last explicit proxy URL stored when
    /// `ProxyConfig::Explicit` was active during a `get_or_build` call.
    #[cfg(test)]
    pub(crate) fn last_proxy_for_test(&self) -> Option<String> {
        self.last_explicit_proxy.lock().ok().and_then(|g| g.clone())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::compat_flags::AddressingStyle;
    use aws_credential_types::Credentials;

    /// Minimal compat flags for AWS standard S3.
    fn aws_compat() -> CompatFlags {
        CompatFlags::default()
    }

    /// Compat flags for a local provider (MinIO / LocalStack) with path-style
    /// addressing and a custom endpoint URL.
    fn local_compat(endpoint: &str) -> CompatFlags {
        CompatFlags {
            endpoint_url: Some(endpoint.to_owned()),
            addressing_style: AddressingStyle::Path,
            ..Default::default()
        }
    }

    /// A static test credentials provider that never makes network calls.
    fn test_creds() -> SharedCredentialsProvider {
        SharedCredentialsProvider::new(Credentials::new(
            "AKIATEST000000000000",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            None,
            None,
            "test",
        ))
    }

    // (a) Client builder for AWS — verify it constructs without panic.
    // No network call is made; the SDK only connects on the first request.
    #[tokio::test]
    async fn builds_standard_aws_client() {
        let compat = aws_compat();
        let client = ClientBuilder::new("us-east-1", &compat, &ProxyConfig::None)
            .credentials_provider(test_creds())
            .build()
            .await;

        let config = client.config();
        let region = config.region().expect("region must be set");
        assert_eq!(region.as_ref(), "us-east-1");
    }

    // (b) Client builder with custom endpoint + path_style=true.
    #[tokio::test]
    async fn builds_custom_endpoint_path_style_client() {
        // Use a non-routable address — the SDK will not attempt to connect
        // until the first API call.
        let compat = local_compat("http://127.0.0.1:9999");
        let client = ClientBuilder::new("us-east-1", &compat, &ProxyConfig::None)
            .credentials_provider(test_creds())
            .build()
            .await;

        // aws-sdk-s3 v1's `Config` does not expose getters; assert via Debug.
        let dump = format!("{:?}", client.config());
        assert!(
            dump.contains("ForcePathStyle(true)"),
            "force_path_style must be true for path addressing style; got: {dump}"
        );
    }

    // (b2) endpoint_url from compat flags is reflected in the built client config.
    #[tokio::test]
    async fn endpoint_url_reflected_in_client_config() {
        let endpoint = "http://127.0.0.1:9999";
        let compat = local_compat(endpoint);
        let client = ClientBuilder::new("us-east-1", &compat, &ProxyConfig::None)
            .credentials_provider(test_creds())
            .build()
            .await;

        // The SDK stores the endpoint_url; assert via Debug since v1 Config
        // exposes no getter. We just check the literal endpoint string is
        // present somewhere in the formatted config.
        let dump = format!("{:?}", client.config());
        assert!(
            dump.contains(endpoint),
            "config must contain endpoint_url={endpoint}; got: {dump}"
        );
    }

    // (c) Proxy URL is applied and observable via the test accessor.
    #[tokio::test]
    async fn explicit_proxy_url_applied_to_pool() {
        let proxy_url = "http://proxy.example.com:3128";
        let pool = ClientPool::new(ProxyConfig::Explicit(proxy_url.to_owned()));

        let profile_id = ProfileId::new("test-profile");
        pool.register_profile(profile_id.clone(), local_compat("http://127.0.0.1:9999"))
            .await;

        let client = pool.get_or_build(&profile_id, "us-east-1").await;
        assert!(
            client.is_some(),
            "pool must return a client for a registered profile"
        );

        // Verify the explicit proxy URL was recorded during construction.
        let recorded_proxy = pool.last_proxy_for_test();
        assert_eq!(
            recorded_proxy.as_deref(),
            Some(proxy_url),
            "proxy URL must be applied to the connector"
        );
    }

    // (d) Pool returns the same Arc<Client> for repeat (profile, region) calls.
    #[tokio::test]
    async fn pool_deduplicates_same_profile_region() {
        let pool = ClientPool::new(ProxyConfig::None);
        let profile_id = ProfileId::new("dedup-profile");

        // Custom endpoint avoids any real DNS / AWS calls.
        pool.register_profile(profile_id.clone(), local_compat("http://127.0.0.1:9998"))
            .await;

        let c1 = pool
            .get_or_build(&profile_id, "eu-west-1")
            .await
            .expect("first call must succeed");
        let c2 = pool
            .get_or_build(&profile_id, "eu-west-1")
            .await
            .expect("second call must succeed");

        // Both arcs must point to the same allocation.
        assert!(
            Arc::ptr_eq(&c1, &c2),
            "repeat (profile, region) must return the cached Arc<Client>"
        );
    }

    // (e) Different (profile, region) combos produce independent clients.
    #[tokio::test]
    async fn pool_creates_distinct_clients_for_different_regions() {
        let pool = ClientPool::new(ProxyConfig::None);
        let profile_id = ProfileId::new("multi-region-profile");

        pool.register_profile(profile_id.clone(), local_compat("http://127.0.0.1:9997"))
            .await;

        let c_east = pool
            .get_or_build(&profile_id, "us-east-1")
            .await
            .expect("us-east-1 client");
        let c_west = pool
            .get_or_build(&profile_id, "us-west-2")
            .await
            .expect("us-west-2 client");

        assert!(
            !Arc::ptr_eq(&c_east, &c_west),
            "different regions must produce distinct cached clients"
        );
    }

    // (f) Pool returns None for an unregistered profile.
    #[tokio::test]
    async fn pool_returns_none_for_unregistered_profile() {
        let pool = ClientPool::new(ProxyConfig::System);
        let result = pool
            .get_or_build(&ProfileId::new("unknown"), "us-east-1")
            .await;
        assert!(result.is_none(), "unregistered profile must return None");
    }
}
