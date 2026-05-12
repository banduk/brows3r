//! OS keychain integration with encrypted-file fallback.
//!
//! # Architecture
//!
//! [`KeychainBackend`] is a trait with three operations: `set`, `get`,
//! `delete`. Three concrete implementations live here:
//!
//! - [`KeyringBackend`] — wraps the `keyring` crate; active on macOS
//!   (Keychain), Windows (Credential Manager), and Linux (Secret Service).
//! - `FileBackend` — AES-256-GCM encrypted `secrets.enc` sidecar; used
//!   when `KeyringBackend` init fails (headless Linux, CI, locked DBus).
//!   Passphrase is supplied by the caller; prompting the user is deferred
//!   to the Credential Manager UI in task 18.
//! - `StubBackend` — in-memory `HashMap` for unit tests; gated behind
//!   the `test-keyring-stub` cargo feature.
//!
//! # OCP contract
//!
//! Adding a new backend (e.g. `OnePasswordBackend`) requires only:
//!   1. A new struct implementing `KeychainBackend`.
//!   2. Optionally, extending `select_backend` to return it.
//! No existing code changes.
//!
//! # Security contract
//!
//! [`Secret`] carries `#[serde(skip_serializing)]` on every field so it
//! can never be emitted across Tauri IPC by accident. Fields are zeroed in
//! memory on drop via [`zeroize::ZeroizeOnDrop`].
//!
//! Internal storage (keyring JSON blob, FileBackend map) uses `StoredSecret`,
//! a private mirror that CAN serialize all fields. The two structs are
//! intentionally separate to enforce the IPC-safe contract on `Secret`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Secret — IPC-safe credential payload (fields skip_serializing)
// ---------------------------------------------------------------------------

/// AWS / provider credentials stored by a profile.
///
/// Every field carries `#[serde(skip_serializing)]` so the struct, when
/// serialized via Tauri IPC (e.g. returned from a command), never leaks
/// credentials. Memory is zeroed on drop via [`ZeroizeOnDrop`].
///
/// Internal storage backends use `StoredSecret` to persist the actual values.
#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Secret {
    #[serde(skip_serializing)]
    pub access_key_id: String,
    #[serde(skip_serializing)]
    pub secret_access_key: String,
    #[serde(skip_serializing)]
    pub session_token: Option<String>,
}

/// Private mirror of [`Secret`] used for serialization inside storage
/// backends. All fields are serialized normally. Never exposed over IPC.
#[derive(Debug, Serialize, Deserialize)]
struct StoredSecret {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

impl From<&Secret> for StoredSecret {
    fn from(s: &Secret) -> Self {
        Self {
            access_key_id: s.access_key_id.clone(),
            secret_access_key: s.secret_access_key.clone(),
            session_token: s.session_token.clone(),
        }
    }
}

impl From<StoredSecret> for Secret {
    fn from(s: StoredSecret) -> Self {
        Self {
            access_key_id: s.access_key_id,
            secret_access_key: s.secret_access_key,
            session_token: s.session_token,
        }
    }
}

// ---------------------------------------------------------------------------
// KeychainBackend trait
// ---------------------------------------------------------------------------

/// Backend-agnostic interface for persisting and retrieving credential
/// secrets keyed by profile ID.
pub trait KeychainBackend: Send + Sync {
    /// Persist `secret` under `profile_id`, replacing any existing entry.
    fn set(&mut self, profile_id: &str, secret: &Secret) -> Result<(), AppError>;

    /// Retrieve the secret for `profile_id`, or `None` if not present.
    fn get(&self, profile_id: &str) -> Result<Option<Secret>, AppError>;

    /// Remove the secret for `profile_id`. No-op if it does not exist.
    fn delete(&mut self, profile_id: &str) -> Result<(), AppError>;

    /// Supply a passphrase to unlock a passphrase-protected backend.
    ///
    /// For backends that do not require a passphrase (e.g. `KeyringBackend`,
    /// `StubBackend`) this is a no-op that always returns `Ok(())`.
    ///
    /// `FileBackend` overrides this to re-derive the encryption key from the
    /// supplied passphrase and attempt to decrypt the secrets file.
    ///
    /// Called by `keychain_fallback_unlock` in response to the user submitting
    /// the `KeychainFallbackPrompt` in the Credential Manager UI.
    fn unlock(&mut self, _passphrase: &str) -> Result<(), AppError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// KeyringBackend — OS keychain via the `keyring` crate
// ---------------------------------------------------------------------------

/// Wraps the [`keyring`] crate to store one entry per profile.
///
/// Service name is fixed at `"brows3r"`. The per-entry credential name is
/// `"profile:<profile_id>"`.
///
/// Secrets are serialized as `StoredSecret` JSON before storage; the
/// `keyring` crate treats its value as an opaque password string, so JSON is
/// the simplest portable encoding.
pub struct KeyringBackend;

impl KeyringBackend {
    /// Construct a new `KeyringBackend`. The service name `"brows3r"` is
    /// hard-coded; profile-specific entry names are derived at call time.
    pub fn new() -> Self {
        Self
    }

    fn entry_name(profile_id: &str) -> String {
        format!("profile:{profile_id}")
    }
}

impl Default for KeyringBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl KeychainBackend for KeyringBackend {
    fn set(&mut self, profile_id: &str, secret: &Secret) -> Result<(), AppError> {
        let stored = StoredSecret::from(secret);
        let json = serde_json::to_string(&stored).map_err(|e| AppError::Internal {
            trace_id: format!("keyring::set::serialize:{e}"),
        })?;
        keyring::Entry::new("brows3r", &Self::entry_name(profile_id))
            .map_err(|e| AppError::Internal {
                trace_id: format!("keyring::set::entry:{e}"),
            })?
            .set_password(&json)
            .map_err(|e| AppError::Internal {
                trace_id: format!("keyring::set::write:{e}"),
            })
    }

    fn get(&self, profile_id: &str) -> Result<Option<Secret>, AppError> {
        let entry = keyring::Entry::new("brows3r", &Self::entry_name(profile_id)).map_err(|e| {
            AppError::Internal {
                trace_id: format!("keyring::get::entry:{e}"),
            }
        })?;
        match entry.get_password() {
            Ok(json) => {
                let stored: StoredSecret =
                    serde_json::from_str(&json).map_err(|e| AppError::Internal {
                        trace_id: format!("keyring::get::deserialize:{e}"),
                    })?;
                Ok(Some(Secret::from(stored)))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Internal {
                trace_id: format!("keyring::get::read:{e}"),
            }),
        }
    }

    fn delete(&mut self, profile_id: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new("brows3r", &Self::entry_name(profile_id)).map_err(|e| {
            AppError::Internal {
                trace_id: format!("keyring::delete::entry:{e}"),
            }
        })?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Deleting a non-existent entry is not an error.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Internal {
                trace_id: format!("keyring::delete::remove:{e}"),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// FileBackend — passphrase-encrypted secrets.enc sidecar
// ---------------------------------------------------------------------------
//
// Encryption scheme:
//   - Key derivation: Argon2id with a per-file random 32-byte salt.
//   - Cipher: AES-256-GCM with a random 12-byte nonce per write.
//   - Layout of the binary file:
//       [32 bytes salt][12 bytes nonce][ciphertext]
//   - Plaintext is the JSON-serialized `BTreeMap<String, StoredSecret>`.
//
// The backend keeps the plaintext map in memory after first decrypt; every
// `set`/`delete` re-encrypts and overwrites the file.

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Argon2, Params};

/// Passphrase-encrypted file-based fallback for environments where the OS
/// keychain is unavailable.
///
/// Secrets are stored in `${path}/secrets.enc` as an AES-256-GCM blob whose
/// key is derived from `passphrase` via Argon2id. The entire map is
/// re-encrypted on every `set` / `delete`.
///
/// This backend is not exposed directly; callers use
/// [`FileBackendWithPassphrase`] which stores the passphrase securely and
/// implements the full [`KeychainBackend`] trait.
struct FileBackend {
    /// Directory where `secrets.enc` lives.
    path: std::path::PathBuf,
    /// Argon2id-derived 32-byte AES-256-GCM key (zero-salt placeholder,
    /// overridden on load from the real per-file salt).
    key_bytes: [u8; 32],
    /// In-memory mirror of the decrypted map; populated lazily.
    map: BTreeMap<String, StoredSecret>,
    /// True after the file has been loaded (or determined to not exist).
    loaded: bool,
}

impl FileBackend {
    fn new(dir: impl Into<std::path::PathBuf>, passphrase: &str) -> Self {
        // Store a placeholder key derived from a zero salt. The real key is
        // re-derived from the on-disk salt in ensure_loaded.
        let key_bytes = derive_key(passphrase, &[0u8; 32]);
        Self {
            path: dir.into(),
            key_bytes,
            map: BTreeMap::new(),
            loaded: false,
        }
    }

    fn file_path(&self) -> std::path::PathBuf {
        self.path.join("secrets.enc")
    }

    /// Load and decrypt the file into `self.map`. Idempotent after first call.
    fn ensure_loaded(&mut self, passphrase: &str) -> Result<(), AppError> {
        if self.loaded {
            return Ok(());
        }
        self.loaded = true;

        let file_path = self.file_path();
        if !file_path.exists() {
            return Ok(());
        }

        let blob = std::fs::read(&file_path).map_err(|e| AppError::Internal {
            trace_id: format!("file_backend::read:{e}"),
        })?;

        // Layout: [32 salt][12 nonce][ciphertext]
        if blob.len() < 44 {
            return Err(AppError::Internal {
                trace_id: "file_backend::truncated_blob".to_string(),
            });
        }

        let salt: [u8; 32] = blob[..32].try_into().unwrap();
        let nonce_bytes: [u8; 12] = blob[32..44].try_into().unwrap();
        let ciphertext = &blob[44..];

        let key_bytes = derive_key(passphrase, &salt);
        // Update the stored key to match the on-disk salt.
        self.key_bytes = key_bytes;

        let key: Key<Aes256Gcm> = key_bytes.into();
        let cipher = Aes256Gcm::new(&key);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| AppError::Auth {
                reason: "invalid passphrase or corrupted secrets file".to_string(),
            })?;

        self.map = serde_json::from_slice(&plaintext).map_err(|e| AppError::Internal {
            trace_id: format!("file_backend::deserialize:{e}"),
        })?;

        Ok(())
    }

    /// Serialize and encrypt `self.map`, then write `secrets.enc`.
    fn flush(&self, passphrase: &str) -> Result<(), AppError> {
        let json = serde_json::to_vec(&self.map).map_err(|e| AppError::Internal {
            trace_id: format!("file_backend::serialize:{e}"),
        })?;

        // Generate a fresh random salt and nonce on every write.
        let salt: [u8; 32] = {
            let mut s = [0u8; 32];
            use aes_gcm::aead::rand_core::RngCore;
            OsRng.fill_bytes(&mut s);
            s
        };

        let key_bytes = derive_key(passphrase, &salt);
        let key: Key<Aes256Gcm> = key_bytes.into();
        let cipher = Aes256Gcm::new(&key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

        let ciphertext = cipher
            .encrypt(&nonce, json.as_ref())
            .map_err(|e| AppError::Internal {
                trace_id: format!("file_backend::encrypt:{e}"),
            })?;

        // Layout: [32 salt][12 nonce][ciphertext]
        let mut blob = Vec::with_capacity(44 + ciphertext.len());
        blob.extend_from_slice(&salt);
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ciphertext);

        if let Some(parent) = self.file_path().parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Internal {
                trace_id: format!("file_backend::mkdir:{e}"),
            })?;
        }
        std::fs::write(self.file_path(), &blob).map_err(|e| AppError::Internal {
            trace_id: format!("file_backend::write:{e}"),
        })
    }
}

impl Drop for FileBackend {
    fn drop(&mut self) {
        self.key_bytes.zeroize();
    }
}

// ---------------------------------------------------------------------------
// FileBackendWithPassphrase — public wrapper that holds the passphrase
// ---------------------------------------------------------------------------

/// Public file-based keychain backend.
///
/// Wraps `FileBackend` and stores the passphrase as a
/// [`zeroize::Zeroizing`] string so it is scrubbed from memory on drop.
pub struct FileBackendWithPassphrase {
    inner: FileBackend,
    passphrase: zeroize::Zeroizing<String>,
}

impl FileBackendWithPassphrase {
    /// Create a new file-based backend.
    ///
    /// `dir` is the directory for `secrets.enc`.
    /// `passphrase` is the user-supplied passphrase for key derivation; it
    /// is zeroed on drop. The passphrase prompt UX lands in task 18.
    pub fn new(dir: impl Into<std::path::PathBuf>, passphrase: impl Into<String>) -> Self {
        let passphrase: String = passphrase.into();
        let inner = FileBackend::new(dir, &passphrase);
        Self {
            inner,
            passphrase: zeroize::Zeroizing::new(passphrase),
        }
    }
}

impl KeychainBackend for FileBackendWithPassphrase {
    fn set(&mut self, profile_id: &str, secret: &Secret) -> Result<(), AppError> {
        self.inner.ensure_loaded(self.passphrase.as_str())?;
        self.inner
            .map
            .insert(profile_id.to_string(), StoredSecret::from(secret));
        self.inner.flush(self.passphrase.as_str())
    }

    fn get(&self, profile_id: &str) -> Result<Option<Secret>, AppError> {
        // `ensure_loaded` requires `&mut self`. When the map is already loaded
        // (after any previous set/delete/get via a mut path), serve from
        // self.inner.map directly. Otherwise decrypt the file on the spot.
        if self.inner.loaded {
            return Ok(self.inner.map.get(profile_id).map(|s| {
                Secret::from(StoredSecret {
                    access_key_id: s.access_key_id.clone(),
                    secret_access_key: s.secret_access_key.clone(),
                    session_token: s.session_token.clone(),
                })
            }));
        }

        let file_path = self.inner.file_path();
        if !file_path.exists() {
            return Ok(None);
        }

        // Decrypt into a temporary map without mutating self.
        let map = decrypt_file(&file_path, self.passphrase.as_str())?;
        Ok(map.get(profile_id).map(|s| {
            Secret::from(StoredSecret {
                access_key_id: s.access_key_id.clone(),
                secret_access_key: s.secret_access_key.clone(),
                session_token: s.session_token.clone(),
            })
        }))
    }

    fn delete(&mut self, profile_id: &str) -> Result<(), AppError> {
        self.inner.ensure_loaded(self.passphrase.as_str())?;
        self.inner.map.remove(profile_id);
        self.inner.flush(self.passphrase.as_str())
    }
}

/// Decrypt a `secrets.enc` file and return the stored map.
fn decrypt_file(
    path: &std::path::Path,
    passphrase: &str,
) -> Result<BTreeMap<String, StoredSecret>, AppError> {
    let blob = std::fs::read(path).map_err(|e| AppError::Internal {
        trace_id: format!("file_backend::get::read:{e}"),
    })?;

    if blob.len() < 44 {
        return Err(AppError::Internal {
            trace_id: "file_backend::get::truncated_blob".to_string(),
        });
    }

    let salt: [u8; 32] = blob[..32].try_into().unwrap();
    let nonce_bytes: [u8; 12] = blob[32..44].try_into().unwrap();
    let ciphertext = &blob[44..];

    let key_bytes = derive_key(passphrase, &salt);
    let key: Key<Aes256Gcm> = key_bytes.into();
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Auth {
            reason: "invalid passphrase or corrupted secrets file".to_string(),
        })?;

    serde_json::from_slice(&plaintext).map_err(|e| AppError::Internal {
        trace_id: format!("file_backend::get::deserialize:{e}"),
    })
}

// ---------------------------------------------------------------------------
// Key derivation helpers
// ---------------------------------------------------------------------------

/// Derive a 32-byte AES-256-GCM key from `passphrase` using Argon2id.
fn derive_key(passphrase: &str, salt: &[u8; 32]) -> [u8; 32] {
    let mut key = [0u8; 32];
    // Argon2id with interactive parameters (64 MiB, 3 iterations, 1 lane).
    // Parameters are intentionally conservative and can be made configurable
    // in a future task without changing the file layout (only the salt is
    // stored, not the Argon2 params).
    let params = Params::new(
        65536, // 64 MiB memory cost
        3,     // 3 iterations
        1,     // 1 lane (portable default)
        Some(32),
    )
    .expect("argon2 params are valid constants");
    Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .expect("argon2 hash_password_into must not fail with valid params");
    key
}

// ---------------------------------------------------------------------------
// StubBackend — in-memory backend for unit tests
// ---------------------------------------------------------------------------

/// In-memory keychain backend for unit tests.
///
/// Gated behind the `test-keyring-stub` cargo feature so that CI never
/// requires a real OS keychain.
#[cfg(feature = "test-keyring-stub")]
pub struct StubBackend {
    map: std::collections::HashMap<String, Secret>,
}

#[cfg(feature = "test-keyring-stub")]
impl StubBackend {
    pub fn new() -> Self {
        Self {
            map: std::collections::HashMap::new(),
        }
    }
}

#[cfg(feature = "test-keyring-stub")]
impl Default for StubBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "test-keyring-stub")]
impl KeychainBackend for StubBackend {
    fn set(&mut self, profile_id: &str, secret: &Secret) -> Result<(), AppError> {
        self.map.insert(profile_id.to_string(), secret.clone());
        Ok(())
    }

    fn get(&self, profile_id: &str) -> Result<Option<Secret>, AppError> {
        Ok(self.map.get(profile_id).cloned())
    }

    fn delete(&mut self, profile_id: &str) -> Result<(), AppError> {
        self.map.remove(profile_id);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// select_backend — factory
// ---------------------------------------------------------------------------

/// Select the best available keychain backend at runtime.
///
/// Probes the OS keychain by writing and deleting a test entry under the
/// `"brows3r"` service. Returns a [`KeyringBackend`] on success; falls back
/// to a [`FileBackendWithPassphrase`] otherwise.
///
/// # Notes on `fallback_passphrase`
/// The passphrase prompt UX lands in task 18 (Credential Manager UI). At
/// this stage the caller supplies the passphrase string directly.
///
/// # OCP note
/// Future selection logic (env-var override, settings flag, 1Password
/// integration) extends only this function without breaking call sites.
pub fn select_backend(
    fallback_dir: impl Into<std::path::PathBuf>,
    fallback_passphrase: &str,
) -> (Box<dyn KeychainBackend + Send + Sync>, bool) {
    // Escape hatch for dev mode: skip the probe and trust the OS keychain.
    // The keyring crate will still fail-loudly when an actual get/set runs
    // against a broken keychain, so this is a safe override for the common
    // case where the probe trips on macOS's per-binary security prompt.
    if std::env::var("BROWS3R_FORCE_OS_KEYCHAIN").is_ok() {
        return (Box::new(KeyringBackend::new()), false);
    }

    // Probe the OS keychain with a read-only lookup. Using a write+delete
    // pair (the previous approach) was unreliable: on macOS the keyring
    // crate's `set_password` and `delete_credential` use different lookup
    // categories, so a freshly-written entry frequently could not be
    // deleted via its own service/account pair — every dev launch fell
    // back even though the keychain was perfectly healthy.
    //
    // A read for a probe entry that does not exist returns
    // `keyring::Error::NoEntry`. We treat that — and any successful read
    // — as "keychain works". Only other error variants (DBus refused,
    // Security framework denied, init failed, …) trigger the fallback.
    let probe_err: Option<String> = match keyring::Entry::new("brows3r", "__probe__") {
        Ok(entry) => match entry.get_password() {
            Ok(_) => None,
            Err(keyring::Error::NoEntry) => None,
            Err(e) => Some(format!("get: {e}")),
        },
        Err(e) => Some(format!("new: {e}")),
    };

    if probe_err.is_none() {
        (Box::new(KeyringBackend::new()), false)
    } else {
        // OS keychain unavailable — use encrypted file fallback.
        // Per design.md §Cross-Platform Considerations: "off by default,
        // surfaced via notification when used". The boolean returned alongside
        // the backend lets the caller emit `KeychainFallbackRequired` so the
        // KeychainFallbackPrompt opens and the user can supply a real
        // passphrase. Without that follow-up `secrets.enc` is encrypted with
        // the placeholder passphrase that lib.rs passes here.
        eprintln!(
            "[brows3r] OS keychain unavailable — falling back to encrypted file backend. \
             Probe error: {}. Until the user supplies a passphrase via the Credential \
             Manager prompt, secrets.enc is encrypted with the empty placeholder passphrase. \
             In dev mode this is often caused by macOS prompting per unsigned binary; \
             set BROWS3R_FORCE_OS_KEYCHAIN=1 to bypass the probe and trust the OS keychain.",
            probe_err.as_deref().unwrap_or("<unknown>"),
        );
        (
            Box::new(FileBackendWithPassphrase::new(
                fallback_dir,
                fallback_passphrase,
            )),
            true,
        )
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // StubBackend — gated behind test-keyring-stub feature
    // ------------------------------------------------------------------

    #[cfg(feature = "test-keyring-stub")]
    mod stub_tests {
        use super::*;

        fn stub() -> StubBackend {
            StubBackend::new()
        }

        fn secret(id: &str) -> Secret {
            Secret {
                access_key_id: format!("AKIA{id}"),
                secret_access_key: format!("secret{id}"),
                session_token: None,
            }
        }

        #[test]
        fn stub_set_and_retrieve() {
            let mut b = stub();
            let s = secret("01");
            b.set("p1", &s).unwrap();
            let got = b.get("p1").unwrap().expect("should be Some");
            assert_eq!(got.access_key_id, s.access_key_id);
            assert_eq!(got.secret_access_key, s.secret_access_key);
            assert!(got.session_token.is_none());
        }

        #[test]
        fn stub_get_missing_returns_none() {
            let b = stub();
            assert!(b.get("nonexistent").unwrap().is_none());
        }

        #[test]
        fn stub_delete_removes_entry() {
            let mut b = stub();
            let s = secret("02");
            b.set("p2", &s).unwrap();
            b.delete("p2").unwrap();
            assert!(b.get("p2").unwrap().is_none());
        }

        #[test]
        fn stub_delete_nonexistent_is_noop() {
            let mut b = stub();
            b.delete("ghost").unwrap(); // must not error
        }

        #[test]
        fn stub_set_overwrites_existing() {
            let mut b = stub();
            let s1 = secret("03a");
            let s2 = secret("03b");
            b.set("p3", &s1).unwrap();
            b.set("p3", &s2).unwrap();
            let got = b.get("p3").unwrap().expect("should be Some");
            assert_eq!(got.access_key_id, s2.access_key_id);
        }

        #[test]
        fn stub_session_token_round_trips() {
            let mut b = stub();
            let s = Secret {
                access_key_id: "AKIATOKEN".to_string(),
                secret_access_key: "secret".to_string(),
                session_token: Some("sess-tok-123".to_string()),
            };
            b.set("p4", &s).unwrap();
            let got = b.get("p4").unwrap().unwrap();
            assert_eq!(got.session_token.as_deref(), Some("sess-tok-123"));
        }
    }

    // ------------------------------------------------------------------
    // FileBackend round-trip tests (always compiled)
    // ------------------------------------------------------------------

    mod file_tests {
        use super::*;

        fn secret(id: &str) -> Secret {
            Secret {
                access_key_id: format!("AKIA{id}"),
                secret_access_key: format!("secret{id}"),
                session_token: None,
            }
        }

        #[test]
        fn file_round_trip_same_passphrase() {
            let dir = tempfile::tempdir().expect("tempdir");
            let s = secret("rt");

            {
                let mut b = FileBackendWithPassphrase::new(dir.path(), "correcthorsebatterystaple");
                b.set("profile-rt", &s).unwrap();
            }

            // Re-open with the same passphrase — should get the secret back.
            let b = FileBackendWithPassphrase::new(dir.path(), "correcthorsebatterystaple");
            let got = b.get("profile-rt").unwrap().expect("should be Some");
            assert_eq!(got.access_key_id, s.access_key_id);
            assert_eq!(got.secret_access_key, s.secret_access_key);
        }

        #[test]
        fn file_wrong_passphrase_returns_auth_error() {
            let dir = tempfile::tempdir().expect("tempdir");
            let s = secret("wp");

            {
                let mut b = FileBackendWithPassphrase::new(dir.path(), "correct");
                b.set("profile-wp", &s).unwrap();
            }

            let b = FileBackendWithPassphrase::new(dir.path(), "wrong");
            match b.get("profile-wp") {
                Err(AppError::Auth { .. }) => {} // expected
                other => panic!("expected Auth error, got {other:?}"),
            }
        }

        #[test]
        fn file_delete_persists_across_instances() {
            let dir = tempfile::tempdir().expect("tempdir");
            let s = secret("del");

            {
                let mut b = FileBackendWithPassphrase::new(dir.path(), "pass");
                b.set("profile-del", &s).unwrap();
            }

            {
                let mut b = FileBackendWithPassphrase::new(dir.path(), "pass");
                b.delete("profile-del").unwrap();
            }

            let b = FileBackendWithPassphrase::new(dir.path(), "pass");
            assert!(b.get("profile-del").unwrap().is_none());
        }

        #[test]
        fn file_multiple_profiles_coexist() {
            let dir = tempfile::tempdir().expect("tempdir");

            {
                let mut b = FileBackendWithPassphrase::new(dir.path(), "multi-pass");
                b.set("p-a", &secret("A")).unwrap();
                b.set("p-b", &secret("B")).unwrap();
            }

            let b = FileBackendWithPassphrase::new(dir.path(), "multi-pass");
            assert_eq!(b.get("p-a").unwrap().unwrap().access_key_id, "AKIAA");
            assert_eq!(b.get("p-b").unwrap().unwrap().access_key_id, "AKIAB");
        }

        #[test]
        fn file_session_token_round_trips() {
            let dir = tempfile::tempdir().expect("tempdir");

            let s = Secret {
                access_key_id: "AKIATOKEN".to_string(),
                secret_access_key: "secret".to_string(),
                session_token: Some("sess-tok-abc".to_string()),
            };

            {
                let mut b = FileBackendWithPassphrase::new(dir.path(), "tok-pass");
                b.set("p-tok", &s).unwrap();
            }

            let b = FileBackendWithPassphrase::new(dir.path(), "tok-pass");
            let got = b.get("p-tok").unwrap().unwrap();
            assert_eq!(got.session_token.as_deref(), Some("sess-tok-abc"));
        }
    }

    // ------------------------------------------------------------------
    // Secret IPC serialization safety
    // ------------------------------------------------------------------

    #[test]
    fn secret_fields_are_not_serialized_to_json() {
        let s = Secret {
            access_key_id: "AKIATEST".to_string(),
            secret_access_key: "supersecret".to_string(),
            session_token: Some("tok".to_string()),
        };
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(
            !json.contains("AKIATEST"),
            "access_key_id must not appear in serialized output: {json}"
        );
        assert!(
            !json.contains("supersecret"),
            "secret_access_key must not appear in serialized output: {json}"
        );
        assert!(
            !json.contains("tok"),
            "session_token must not appear in serialized output: {json}"
        );
    }

    // ------------------------------------------------------------------
    // ZeroizeOnDrop — compile-time contract
    // ------------------------------------------------------------------
    //
    // Runtime memory zeroing is platform-dependent (allocator reuse, etc.).
    // The standard practice is to verify the bound compiles, which means the
    // ZeroizeOnDrop impl is present and the compiler enforces the contract.

    #[test]
    fn secret_implements_zeroize_on_drop() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<Secret>();
    }
}
