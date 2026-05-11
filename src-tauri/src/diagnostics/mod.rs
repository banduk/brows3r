//! Diagnostics subsystem.
//!
//! Split into two tasks:
//! - task 59: `redact` — credential and path redaction.
//! - task 60: `bundle` — bundle collection and export (this task).

pub mod bundle;
pub mod redact;

use std::sync::Arc;

use redact::Redactor;

/// A cheaply-clonable `Arc<Redactor>` managed as Tauri state.
///
/// Built once at startup with `RedactionLevel::Full` and injected into
/// every command that needs to redact text before including it in a bundle.
pub type DiagnosticsRedactorHandle = Arc<Redactor>;
