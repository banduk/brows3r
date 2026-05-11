//! Progress event emission helpers for transfers.
//!
//! # Design
//!
//! `emit_progress` throttles emissions to at most one per 250 ms **or** per
//! 256 KB transferred, whichever condition is met first.  This avoids flooding
//! the IPC channel while still giving the frontend a responsive progress bar.
//!
//! `emit_state` is unthrottled — state transitions (Queued → Running → Done /
//! Failed / Canceled) must always reach the frontend.
//!
//! # OCP contract
//!
//! The same helpers are reused for uploads (task 32) — the throttle logic lives
//! in one place and is called identically from both `download.rs` and
//! `upload.rs`.

use serde::Serialize;

use crate::{
    error::AppError,
    events::{EventEmitter, EventKind},
    transfers::TransferState,
};

// ---------------------------------------------------------------------------
// Throttle constants
// ---------------------------------------------------------------------------

/// Minimum milliseconds between progress events for one transfer.
pub const PROGRESS_THROTTLE_MS: i64 = 250;

/// Minimum bytes transferred between progress events.
pub const PROGRESS_THROTTLE_BYTES: u64 = 262_144; // 256 KB

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/// Payload for `transfer:progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressPayload {
    pub request_id: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub parts_done: u32,
    pub parts_total: u32,
}

/// Payload for `transfer:state`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatePayload {
    pub request_id: String,
    pub state: TransferState,
}

// ---------------------------------------------------------------------------
// ProgressThrottle — per-transfer state tracker
// ---------------------------------------------------------------------------

/// Tracks when the last progress event was emitted so `emit_progress` can
/// apply the 250 ms / 256 KB throttle.
///
/// Instantiate one `ProgressThrottle` per transfer at the start of the stream
/// loop and pass it mutably to each `emit_progress` call.
#[derive(Debug)]
pub struct ProgressThrottle {
    /// Millisecond timestamp of the last emitted event (0 = never).
    pub last_emitted_at_ms: i64,
    /// `transferred_bytes` value at the time of the last emitted event.
    pub last_emitted_bytes: u64,
}

impl ProgressThrottle {
    /// Create a new throttle state.  `now_ms` is the current time in ms.
    pub fn new() -> Self {
        Self {
            last_emitted_at_ms: 0,
            last_emitted_bytes: 0,
        }
    }

    /// Returns `true` when a progress event should be emitted now.
    ///
    /// The gate opens when:
    /// - no event has been emitted yet (`last_emitted_at_ms == 0`), OR
    /// - at least 250 ms have elapsed since the last emission, OR
    /// - at least 256 KB more have been transferred since the last emission.
    pub fn should_emit(&self, now_ms: i64, bytes_done: u64) -> bool {
        if self.last_emitted_at_ms == 0 {
            return true;
        }
        let elapsed_ms = now_ms - self.last_emitted_at_ms;
        let delta_bytes = bytes_done.saturating_sub(self.last_emitted_bytes);
        elapsed_ms >= PROGRESS_THROTTLE_MS || delta_bytes >= PROGRESS_THROTTLE_BYTES
    }

    /// Record that an event was just emitted.
    pub fn record_emission(&mut self, now_ms: i64, bytes_done: u64) {
        self.last_emitted_at_ms = now_ms;
        self.last_emitted_bytes = bytes_done;
    }
}

impl Default for ProgressThrottle {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// emit_progress
// ---------------------------------------------------------------------------

/// Emit a `transfer:progress` event if the throttle gate is open.
///
/// Updates `throttle` on emission.  `now_ms` is the current wall-clock time
/// in milliseconds (callers obtain this via
/// `std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64`).
///
/// Returns `Ok(true)` when an event was emitted, `Ok(false)` when throttled.
pub fn emit_progress<E: EventEmitter>(
    channel: &E,
    request_id: &str,
    bytes_done: u64,
    bytes_total: Option<u64>,
    parts_done: u32,
    parts_total: u32,
    throttle: &mut ProgressThrottle,
    now_ms: i64,
) -> Result<bool, AppError> {
    if !throttle.should_emit(now_ms, bytes_done) {
        return Ok(false);
    }

    crate::events::emit(
        channel,
        EventKind::TransferProgress,
        TransferProgressPayload {
            request_id: request_id.to_owned(),
            bytes_done,
            bytes_total,
            parts_done,
            parts_total,
        },
    )?;

    throttle.record_emission(now_ms, bytes_done);
    Ok(true)
}

// ---------------------------------------------------------------------------
// emit_state
// ---------------------------------------------------------------------------

/// Emit a `transfer:state` event (unthrottled).
pub fn emit_state<E: EventEmitter>(
    channel: &E,
    request_id: &str,
    state: TransferState,
) -> Result<(), AppError> {
    crate::events::emit(
        channel,
        EventKind::TransferState,
        TransferStatePayload {
            request_id: request_id.to_owned(),
            state,
        },
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, MockChannel};

    fn now() -> i64 {
        1_700_000_000_000_i64
    }

    // -----------------------------------------------------------------------
    // ProgressThrottle::should_emit
    // -----------------------------------------------------------------------

    #[test]
    fn throttle_always_emits_first_event() {
        let throttle = ProgressThrottle::new();
        assert!(throttle.should_emit(now(), 0));
    }

    #[test]
    fn throttle_blocks_within_window_and_threshold() {
        let mut throttle = ProgressThrottle::new();
        throttle.record_emission(now(), 0);

        // 100 ms later, only 1 KB transferred — both conditions unmet.
        let blocked = !throttle.should_emit(now() + 100, 1024);
        assert!(blocked, "should NOT emit within throttle window");
    }

    #[test]
    fn throttle_opens_after_250ms() {
        let mut throttle = ProgressThrottle::new();
        throttle.record_emission(now(), 0);

        // Exactly 250 ms later.
        assert!(
            throttle.should_emit(now() + 250, 1024),
            "should emit after 250 ms"
        );
    }

    #[test]
    fn throttle_opens_after_256kb() {
        let mut throttle = ProgressThrottle::new();
        throttle.record_emission(now(), 0);

        // Only 100 ms elapsed, but 256 KB transferred.
        assert!(
            throttle.should_emit(now() + 100, 262_144),
            "should emit after 256 KB"
        );
    }

    // -----------------------------------------------------------------------
    // emit_progress collapses multiple rapid calls into one
    // -----------------------------------------------------------------------

    #[test]
    fn rapid_progress_calls_collapse_into_one_emission() {
        let channel = MockChannel::default();
        let mut throttle = ProgressThrottle::new();
        let t0 = now();

        // First call — always emitted.
        let emitted = emit_progress(
            &channel,
            "req-1",
            0,
            Some(1_000_000),
            0,
            0,
            &mut throttle,
            t0,
        )
        .expect("emit must not error");
        assert!(emitted, "first call must emit");

        // Five calls within 100 ms and < 256 KB each — all throttled.
        for i in 1_u64..=5 {
            let emitted = emit_progress(
                &channel,
                "req-1",
                i * 10_000, // only 10 KB per step
                Some(1_000_000),
                0,
                0,
                &mut throttle,
                t0 + 20 * i as i64, // 20 ms apart
            )
            .expect("emit must not error");
            assert!(!emitted, "call {i} must be throttled");
        }

        // Only one event should have been emitted.
        let emitted_events = channel.emitted();
        assert_eq!(
            emitted_events.len(),
            1,
            "rapid calls must collapse into one emission"
        );
        assert_eq!(emitted_events[0].0, EventKind::TransferProgress);
        assert_eq!(emitted_events[0].1["requestId"], "req-1");
        assert_eq!(emitted_events[0].1["bytesDone"], 0_u64);
    }

    #[test]
    fn progress_emits_again_after_250ms() {
        let channel = MockChannel::default();
        let mut throttle = ProgressThrottle::new();
        let t0 = now();

        emit_progress(
            &channel,
            "req-2",
            0,
            Some(1_000_000),
            0,
            0,
            &mut throttle,
            t0,
        )
        .unwrap();
        // Advance 250 ms.
        let emitted = emit_progress(
            &channel,
            "req-2",
            256_000,
            Some(1_000_000),
            0,
            0,
            &mut throttle,
            t0 + 250,
        )
        .unwrap();

        assert!(emitted, "must emit again after 250 ms");
        assert_eq!(channel.emitted().len(), 2);
    }

    // -----------------------------------------------------------------------
    // emit_state — always fires
    // -----------------------------------------------------------------------

    #[test]
    fn emit_state_always_fires() {
        let channel = MockChannel::default();
        emit_state(&channel, "req-3", TransferState::Running).expect("must succeed");
        emit_state(&channel, "req-3", TransferState::Done).expect("must succeed");

        let events = channel.emitted();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, EventKind::TransferState);
        assert_eq!(events[0].1["state"], "running");
        assert_eq!(events[1].1["state"], "done");
    }

    // -----------------------------------------------------------------------
    // TransferProgressPayload serializes to camelCase
    // -----------------------------------------------------------------------

    #[test]
    fn progress_payload_serializes_camel_case() {
        let channel = MockChannel::default();
        let mut throttle = ProgressThrottle::new();
        emit_progress(
            &channel,
            "req-4",
            512,
            Some(1024),
            1,
            4,
            &mut throttle,
            now(),
        )
        .unwrap();
        let events = channel.emitted();
        let payload = &events[0].1;
        assert!(
            payload.get("requestId").is_some(),
            "requestId must be present"
        );
        assert!(
            payload.get("bytesDone").is_some(),
            "bytesDone must be present"
        );
        assert!(
            payload.get("bytesTotal").is_some(),
            "bytesTotal must be present"
        );
        assert!(
            payload.get("partsDone").is_some(),
            "partsDone must be present"
        );
        assert!(
            payload.get("partsTotal").is_some(),
            "partsTotal must be present"
        );
    }
}
