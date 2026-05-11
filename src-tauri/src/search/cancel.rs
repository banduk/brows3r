//! Lightweight cancellation token for long-running search operations.
//!
//! `CancellationToken` is an `Arc<AtomicBool>` wrapper.  The `cancel()` call
//! sets the flag; the background task polls `is_cancelled()` between pages and
//! exits early when the flag is set.
//!
//! This deliberately avoids `tokio_util::sync::CancellationToken` to keep the
//! dependency surface small — the atomics-based approach is sufficient for a
//! single-flag stop signal.
//!
//! OCP: wrapping the `Arc<AtomicBool>` in this struct means the token shape
//! can be extended (e.g. adding a reason code) without changing call sites.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

// ---------------------------------------------------------------------------
// CancellationToken
// ---------------------------------------------------------------------------

/// A cloneable, thread-safe cancellation flag.
///
/// Clone the token to share it between the producer (registry) and the
/// consumer (background task).  Calling `cancel()` on any clone sets the flag
/// for all clones.
#[derive(Clone, Default)]
pub struct CancellationToken {
    atomic: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Create a new, uncancelled token.
    pub fn new() -> Self {
        Self {
            atomic: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Signal cancellation.  Idempotent — safe to call multiple times.
    pub fn cancel(&self) {
        self.atomic.store(true, Ordering::Relaxed);
    }

    /// Returns `true` once `cancel()` has been called on any clone.
    pub fn is_cancelled(&self) -> bool {
        self.atomic.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_token_is_not_cancelled() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancel_sets_flag() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancel_is_idempotent() {
        let token = CancellationToken::new();
        token.cancel();
        token.cancel(); // second call must not panic
        assert!(token.is_cancelled());
    }

    #[test]
    fn clone_shares_flag() {
        let token = CancellationToken::new();
        let clone = token.clone();
        token.cancel();
        assert!(clone.is_cancelled(), "clone must see the cancellation");
    }

    #[test]
    fn cancel_on_clone_visible_on_original() {
        let token = CancellationToken::new();
        let clone = token.clone();
        clone.cancel();
        assert!(
            token.is_cancelled(),
            "original must see clone's cancellation"
        );
    }
}
