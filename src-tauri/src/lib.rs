pub mod bookmarks;
pub mod cache;
pub mod commands;
pub mod diagnostics;
pub mod diff;
pub mod error;
pub mod events;
pub mod ids;
pub mod locks;
pub mod media_server;
pub mod menus;
pub mod notifications;
pub mod path;
pub mod profiles;
pub mod s3;
pub mod search;
pub mod settings;
pub mod transfers;
pub mod updater;

use std::path::PathBuf;
use std::sync::Arc;

use bookmarks::{
    BookmarkStore, BookmarkStoreHandle, BookmarkStoreState, RecentsHandle, RecentsStore,
};
use cache::{store::CacheHandle, CacheConfig, CapabilityHandle};
use diagnostics::DiagnosticsRedactorHandle;
use diff::DiffStoreHandle;
use locks::{lifecycle, LockRegistryHandle, ReleaseReason};
use media_server::{start_on_localhost, TokenRegistry, TokenRegistryHandle};
use notifications::NotificationLogHandle;
use profiles::{KeychainHandle, ProfileStore, ProfileStoreHandle};
use s3::cross_account::ConfirmationCacheHandle;
use s3::multipart::{MultipartTable, MultipartTableHandle};
use s3::{ClientPool, ProxyConfig, S3ClientPoolHandle};
use search::SearchRegistryHandle;
use settings::{Settings, SettingsHandle};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;
use transfers::{TransferQueue, TransferQueueHandle};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Resolve `${app_config_dir}/settings.json` from the Tauri app handle.
///
/// Falls back to a temp-dir path in tests / non-standard environments so
/// the app does not panic on startup.
fn settings_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

/// Resolve `${app_config_dir}/profiles.json` from the Tauri app handle.
fn profiles_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("profiles.json")
}

/// Resolve `${app_config_dir}/cache.redb` from the Tauri app handle.
fn cache_db_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cache.redb")
}

/// Resolve `${app_config_dir}/bookmarks.json` from the Tauri app handle.
fn bookmarks_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bookmarks.json")
}

/// Resolve `${app_config_dir}/recents.json` from the Tauri app handle.
fn recents_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("recents.json")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let path = settings_path(app);
            // Use the sync loader — the setup callback is synchronous and the
            // file is small, so a blocking read is acceptable here.
            let settings = Settings::load_sync(&path);

            // Derive values from settings before moving it into the handle.
            // This avoids locking the async Mutex from within the synchronous
            // setup callback (which would panic inside a Tokio runtime).
            let cache_config = CacheConfig {
                default_ttl_secs: settings.cache_ttl_secs,
                ..CacheConfig::default()
            };
            let transfer_concurrency = settings.transfer_concurrency;

            app.manage(SettingsHandle::new(settings, path));
            app.manage(NotificationLogHandle::default());

            // Diagnostics redactor: built once with Full level, reused by all
            // diagnostics_collect calls.  The Arc makes it cheaply clonable.
            let redactor = Arc::new(diagnostics::redact::Redactor::new());
            app.manage::<DiagnosticsRedactorHandle>(redactor);

            // Profile store: load manual profiles from disk; errors are
            // non-fatal (store starts empty and the user can re-add profiles).
            let profiles_path = profiles_path(app);
            // Derive keychain fallback dir before moving profiles_path.
            let keychain_dir = profiles_path
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(std::env::temp_dir);
            let store = ProfileStore::load(&profiles_path).unwrap_or_else(|_| {
                ProfileStore::load(std::env::temp_dir().join("profiles.json"))
                    .expect("fallback profile store must succeed")
            });
            // Snapshot every known profile's (id, compat_flags) so we can
            // pre-register them with the S3 client pool below. Without this,
            // a profile validated in a previous session has validated_at
            // persisted (so the UI gate is open) but the pool has no entry
            // for it, and the next buckets_list fails with pool_miss.
            let initial_profiles: Vec<(ids::ProfileId, profiles::CompatFlags)> = store
                .list()
                .into_iter()
                .map(|p| (p.id.clone(), p.compat_flags.clone()))
                .collect();
            app.manage(ProfileStoreHandle::new(store));

            // Keychain: select best available backend at runtime.
            // Passphrase comes from task 18 (Credential Manager UI); for now
            // we use a placeholder empty string.
            let backend = profiles::keychain::select_backend(keychain_dir, "");
            app.manage(KeychainHandle::from_box(backend));

            // S3 client pool: shared across all commands; uses system proxy by default.
            let pool = ClientPool::new(ProxyConfig::System);
            // Pre-register every known profile so the pool can build clients
            // without waiting on profile_validate (which is the only other
            // place that calls register_profile).
            tauri::async_runtime::block_on(async {
                for (profile_id, compat) in initial_profiles {
                    pool.register_profile(profile_id, compat).await;
                }
            });
            let pool_handle = S3ClientPoolHandle::new(pool);
            // Clone before managing so the media server can reference the pool.
            let pool_handle_for_media = pool_handle.clone();
            app.manage(pool_handle);

            // Authoritative SWR cache: redb-backed, opened at cache.redb.
            // Falls back to an in-memory-only store if the file cannot be opened
            // (e.g. read-only filesystem in sandboxed environments).
            let cache_path = cache_db_path(app);
            let cache_handle: CacheHandle =
                cache::store::CacheStore::open(&cache_path, cache_config).unwrap_or_else(|_| {
                    cache::store::CacheStore::in_memory(CacheConfig::default())
                });

            // Multipart bookkeeping table: shares the same redb Database as the
            // SWR cache to avoid holding two file handles on cache.redb.
            // Falls back to a temp-file redb if the shared DB is unavailable.
            let multipart_table_handle = if let Some(db) = cache_handle.db() {
                MultipartTable::new(db)
                    .map(MultipartTableHandle::new)
                    .unwrap_or_else(|_| {
                        let fallback_db = std::sync::Arc::new(
                            redb::Database::create(
                                std::env::temp_dir().join("brows3r_multipart_fallback.redb"),
                            )
                            .expect("fallback multipart db must open"),
                        );
                        MultipartTableHandle::new(
                            MultipartTable::new(fallback_db)
                                .expect("fallback multipart table must open"),
                        )
                    })
            } else {
                let fallback_db = std::sync::Arc::new(
                    redb::Database::create(
                        std::env::temp_dir().join("brows3r_multipart_fallback.redb"),
                    )
                    .expect("fallback multipart db must open"),
                );
                MultipartTableHandle::new(
                    MultipartTable::new(fallback_db).expect("fallback multipart table must open"),
                )
            };
            app.manage(multipart_table_handle);

            app.manage(cache_handle);

            // Capability classification cache: in-memory, no disk persistence in v1.
            app.manage(CapabilityHandle::default());

            // Resource lock registry: in-memory, cleared at startup.
            let lock_registry = LockRegistryHandle::default();
            // Clear any locks left over from a prior crash; emit StartupCleanup events.
            let leftover = lock_registry.inner().startup_cleanup();
            for lock in &leftover {
                // Best-effort — the frontend may not be ready yet; ignore errors.
                let _ = locks::emit_released(app.app_handle(), lock, ReleaseReason::StartupCleanup);
            }
            // Start the background TTL scanner (every 150 s ≈ TTL/2 for default 5-min TTL).
            let heartbeat_interval = std::time::Duration::from_secs(150);
            lifecycle::start_heartbeat_loop_handle(
                &lock_registry,
                heartbeat_interval,
                std::sync::Arc::new(app.app_handle().clone()),
            );
            app.manage(lock_registry);

            // Transfer queue: wraps the registry with a concurrency cap from settings.
            let queue = TransferQueue::new(transfer_concurrency);
            app.manage(TransferQueueHandle::new(queue));

            // Cross-account confirmation cache: in-memory, tokens expire after 5 min.
            app.manage(ConfirmationCacheHandle::default());

            // Diff preview store: in-memory, TTL 5 min per record.
            app.manage(DiffStoreHandle::default());

            // Search registry: tracks in-flight prefix searches by request_id.
            app.manage(SearchRegistryHandle::new());

            // Bookmark store: persisted JSON; errors fall back to empty store.
            let bm_path = bookmarks_path(app);
            let bm_store = BookmarkStore::load(&bm_path).unwrap_or_default();
            let bm_handle: BookmarkStoreHandle =
                Arc::new(RwLock::new(BookmarkStoreState::new(bm_store, bm_path)));
            app.manage(bm_handle);

            // Recents ring buffer: loaded from disk; at-exit flush is triggered
            // by `recents_clear` or implicitly when the frontend tracks locations.
            let rec_path = recents_path(app);
            let rec_store = RecentsStore::load(rec_path);
            let rec_handle: RecentsHandle = Arc::new(RwLock::new(rec_store));
            app.manage(rec_handle);

            // Loopback media server: binds to 127.0.0.1:0 at startup.
            // A session UUID tags all tokens so they can be swept on exit via
            // revoke_session.
            let media_session_id = uuid::Uuid::new_v4().to_string();
            let media_registry: TokenRegistryHandle = std::sync::Arc::new(TokenRegistry::new());
            let media_handle = tauri::async_runtime::block_on(start_on_localhost(
                pool_handle_for_media,
                media_registry,
                media_session_id,
            ))
            .expect("media server must start");
            app.manage(media_handle);

            // Native menu: build and attach.
            // Errors here are non-fatal — the app still works without a menu
            // bar (e.g. in headless CI environments).
            if let Ok(menu) = menus::build_menu(app.app_handle()) {
                let _ = app.set_menu(menu);
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Forward menu item activations as Tauri events so the frontend
            // command bridge can dispatch them to the registry.
            // The event id is already namespaced as "menu:<command-id>".
            let _ = app.emit(event.id().0.as_str(), ());
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::settings_cmd::settings_get,
            commands::settings_cmd::settings_update,
            commands::notifications_cmd::notifications_list,
            commands::notifications_cmd::notification_dismiss,
            commands::profiles_cmd::profiles_list,
            commands::profiles_cmd::profile_get,
            commands::profiles_cmd::profile_create_manual,
            commands::profiles_cmd::profile_update,
            commands::profiles_cmd::profile_delete,
            commands::profiles_cmd::profile_validate,
            commands::profiles_cmd::keychain_fallback_unlock,
            commands::inspector_cmd::bucket_inspect,
            commands::inspector_cmd::object_inspect,
            commands::inspector_cmd::object_head,
            commands::inspector_cmd::capability_get,
            commands::inspector_cmd::capability_clear,
            commands::locks_cmd::locks_list,
            commands::locks_cmd::lock_release_stale,
            commands::buckets_cmd::buckets_list,
            commands::buckets_cmd::bucket_region_get,
            commands::objects_cmd::objects_list,
            commands::objects_cmd::objects_list_flat,
            commands::objects_cmd::object_copy,
            commands::objects_cmd::object_move,
            commands::objects_cmd::object_create_folder,
            commands::objects_cmd::object_delete_batch,
            commands::objects_cmd::object_set_metadata,
            commands::objects_cmd::object_set_tags,
            commands::objects_cmd::object_presign,
            commands::objects_cmd::cross_account_confirm,
            commands::transfers_cmd::transfer_download,
            commands::transfers_cmd::transfer_upload,
            commands::transfers_cmd::transfer_list,
            commands::transfers_cmd::transfer_cancel,
            commands::transfers_cmd::transfer_retry,
            commands::transfers_cmd::transfer_upload_many,
            commands::transfers_cmd::transfer_download_many,
            commands::transfers_cmd::multipart_scan,
            commands::transfers_cmd::multipart_abort,
            commands::diff_cmd::diff_preview_create,
            commands::diff_cmd::diff_preview_cancel,
            commands::objects_cmd::object_set_storage_class,
            commands::media_cmd::media_register,
            commands::media_cmd::media_revoke,
            commands::objects_cmd::object_get_text,
            commands::objects_cmd::object_get_bytes,
            commands::objects_cmd::object_put_text,
            commands::search_cmd::search_local_filter,
            commands::search_cmd::search_prefix,
            commands::search_cmd::search_cancel,
            commands::bookmarks_cmd::bookmarks_list,
            commands::bookmarks_cmd::bookmark_add,
            commands::bookmarks_cmd::bookmark_remove,
            commands::bookmarks_cmd::bookmark_update,
            commands::bookmarks_cmd::recents_list,
            commands::bookmarks_cmd::recent_track,
            commands::bookmarks_cmd::recents_clear,
            commands::updater_cmd::updater_check,
            commands::updater_cmd::updater_install,
            commands::diagnostics_cmd::diagnostics_collect,
            commands::diagnostics_cmd::diagnostics_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    // These imports exercise name resolution at compile time,
    // proving each plugin crate is correctly linked.
    use tauri_plugin_dialog::init as dialog_init;
    use tauri_plugin_fs::init as fs_init;
    use tauri_plugin_notification::init as notification_init;
    use tauri_plugin_shell::init as shell_init;

    #[test]
    fn plugin_init_symbols_are_reachable() {
        // We cannot construct a full Tauri app in a unit test, but we can
        // verify the init symbols resolve at link time. Bind to a concrete
        // Runtime via turbofish so Rust can infer the generic.
        type R = tauri::Wry;
        let _ = fs_init::<R>;
        let _ = dialog_init::<R>;
        let _ = shell_init::<R>;
        let _ = notification_init::<R>;
    }

    #[test]
    fn updater_plugin_builder_is_constructible() {
        // Verify the tauri-plugin-updater crate is correctly linked.
        // We cannot call `.build()` without a Tauri runtime, but constructing
        // the builder proves the dep resolves at link time.
        let _builder = tauri_plugin_updater::Builder::new();
    }
}
