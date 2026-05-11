//! Tauri command modules.
//!
//! Each sub-module exposes one or more `#[tauri::command]` functions that
//! are registered in `lib.rs` via `tauri::generate_handler!`.

pub mod bookmarks_cmd;
pub mod buckets_cmd;
pub mod diagnostics_cmd;
pub mod diff_cmd;
pub mod inspector_cmd;
pub mod locks_cmd;
pub mod media_cmd;
pub mod notifications_cmd;
pub mod objects_cmd;
pub mod profiles_cmd;
pub mod search_cmd;
pub mod settings_cmd;
pub mod transfers_cmd;
pub mod updater_cmd;
