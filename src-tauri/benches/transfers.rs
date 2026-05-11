//! Criterion benchmarks for transfer subsystem hot paths.
//!
//! # Running
//!
//! ```bash
//! cargo bench --bench transfers
//! ```
//!
//! Results land in `target/criterion/`.
//!
//! # OCP contract
//!
//! Adding a new bench is one new `c.bench_function(…)` call or a new file
//! under `benches/`.  No changes to library code are required.

use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

use brows3r_lib::transfers::{progress::ProgressThrottle, upload::compute_part_size};

// ---------------------------------------------------------------------------
// bench_progress_throttle
// ---------------------------------------------------------------------------

/// Measure the CPU cost of `ProgressThrottle::should_emit` — the hot path
/// called once per chunk in every transfer loop.
///
/// Expected order-of-magnitude: single-digit nanoseconds.  Any regression into
/// the microsecond range indicates an inadvertent allocation or syscall in the
/// throttle logic.
fn bench_progress_throttle(c: &mut Criterion) {
    c.bench_function("progress_throttle/should_emit_throttled", |b| {
        let mut throttle = ProgressThrottle::new();
        // Seed a prior emission so the "throttled" branch is exercised.
        throttle.record_emission(1_700_000_000_000, 0);

        b.iter(|| {
            // 100 ms later, 1 KB transferred — both conditions unmet → false.
            black_box(throttle.should_emit(black_box(1_700_000_000_100), black_box(1_024)))
        });
    });

    c.bench_function("progress_throttle/should_emit_open_time", |b| {
        let mut throttle = ProgressThrottle::new();
        throttle.record_emission(1_700_000_000_000, 0);

        b.iter(|| {
            // 250 ms later → time gate opens → true.
            black_box(throttle.should_emit(black_box(1_700_000_000_250), black_box(1_024)))
        });
    });

    c.bench_function("progress_throttle/should_emit_open_bytes", |b| {
        let mut throttle = ProgressThrottle::new();
        throttle.record_emission(1_700_000_000_000, 0);

        b.iter(|| {
            // 100 ms but 256 KB transferred → byte gate opens → true.
            black_box(throttle.should_emit(black_box(1_700_000_000_100), black_box(262_144)))
        });
    });
}

// ---------------------------------------------------------------------------
// bench_part_size_calculation
// ---------------------------------------------------------------------------

/// Measure the CPU cost of `compute_part_size` across a representative spread
/// of file sizes (1 MB to 1 TB).
///
/// Expected order-of-magnitude: single-digit nanoseconds (pure integer math).
fn bench_part_size_calculation(c: &mut Criterion) {
    let file_sizes: &[(&str, u64)] = &[
        ("1_mb", 1024 * 1024),
        ("50_mb", 50 * 1024 * 1024),
        ("500_mb", 500 * 1024 * 1024),
        ("5_gb", 5 * 1024 * 1024 * 1024),
        ("50_gb", 50 * 1024 * 1024 * 1024),
        ("200_gb", 200 * 1024 * 1024 * 1024),
        ("1_tb", 1024 * 1024 * 1024 * 1024),
    ];

    let mut group = c.benchmark_group("part_size_calculation");
    for (label, size) in file_sizes {
        group.bench_function(*label, |b| {
            b.iter(|| black_box(compute_part_size(black_box(*size))))
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Criterion harness
// ---------------------------------------------------------------------------

criterion_group!(
    benches,
    bench_progress_throttle,
    bench_part_size_calculation
);
criterion_main!(benches);
