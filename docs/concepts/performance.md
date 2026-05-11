# Performance Budgets and Lab Benchmark Conditions

This document is the canonical reference for brows3r performance targets (AC-8),
lab baseline conditions, and how to reproduce each measurement from a clean
checkout.

---

## AC-8 Budgets

### List view — scroll smoothness

| Metric | Target |
|--------|--------|
| Frame rate at p95 with 10 000 objects visible | 60 fps |
| Initial render of 10 000-object prefix | < 300 ms to first paint |
| Sort re-render (name, ascending) | < 50 ms |

The virtualizer (`@tanstack/react-virtual`) renders only the visible window
(~20 rows at 32 px row height in a 600 px viewport).  The 60 fps target is
only meaningful with a real layout engine; see **Gap: jsdom vs real hardware**
below.

### Memory budget

| Scenario | Limit |
|----------|-------|
| App idle (no bucket loaded) | ≤ 80 MB resident |
| Large list view (10 000 objects loaded, inspector closed) | ≤ 250 MB resident |
| During a 1 GB multipart upload | ≤ 400 MB resident (parts streamed, not buffered) |

### Transfer throughput

| Scenario | Target |
|----------|--------|
| Single-part upload (< 5 MB) | ≥ 50 MB/s on localhost / LocalStack |
| Multipart upload (≥ 5 MB, 4 concurrent parts) | ≥ 100 MB/s on localhost / LocalStack |
| Single-file download | ≥ 100 MB/s on localhost / LocalStack |

These targets are measured at the Rust layer against a LocalStack endpoint on
the same machine.  Real-world throughput is network-bound.

---

## Lab Conditions

### Developer machine (baseline)

- macOS 15 (Apple Silicon M-series or Intel Core i7 / i9)
- 16 GB RAM minimum
- Node 22, pnpm 9
- Rust 1.78 stable, criterion 0.5

### CI runner (GitHub Actions)

- `ubuntu-latest` (currently Ubuntu 22.04, 2-core, 7 GB RAM)
- Same toolchain versions as above via `rust-toolchain.toml` and `.nvmrc`

### jsdom limitations

Tests under `src/views/modes/__perf__/` run in jsdom, which has no layout
engine.  All perf numbers measured there reflect pure JavaScript CPU time
(sort, array allocation) — they do not capture React reconciliation overhead,
paint time, or GPU compositing.

---

## How to Reproduce

### Rust bench: transfer subsystem

```bash
# From the repo root
cargo bench --bench transfers --manifest-path src-tauri/Cargo.toml
```

Results are written to `src-tauri/target/criterion/`.  Open
`src-tauri/target/criterion/report/index.html` in a browser for the HTML
report.

Benches included:

| Bench function | What it measures |
|----------------|-----------------|
| `progress_throttle/should_emit_throttled` | `ProgressThrottle::should_emit` — throttled path (fast return) |
| `progress_throttle/should_emit_open_time` | `ProgressThrottle::should_emit` — time gate opens |
| `progress_throttle/should_emit_open_bytes` | `ProgressThrottle::should_emit` — byte gate opens |
| `part_size_calculation/1_mb` … `1_tb` | `compute_part_size` across the full size range |

Expected order-of-magnitude: single-digit nanoseconds for both groups.  A
regression into the microsecond range indicates an unintended allocation or
system call.

### Frontend perf smoke: jsdom-based sort / virtualizer index

```bash
pnpm perf
```

This runs only the tests whose describe block contains the word `perf`:

```
src/views/modes/__perf__/details.perf.test.ts
```

Budgets:

| Test | CI budget | Local recommendation |
|------|-----------|----------------------|
| Sort 10k entries by name | 100 ms | 50 ms |
| Sort 10k entries by size | 100 ms | 50 ms |
| Build virtual-item index (10k rows) | 100 ms | 50 ms |

These are smoke tests.  Passing them means the hot path has not regressed
catastrophically.  They do not substitute for manual frame-rate measurement.

### Manual 60fps verification (real hardware)

1. Start a dev build: `pnpm tauri dev`
2. Connect a profile pointing at a bucket with ≥ 10 000 objects (or use
   LocalStack with the seed fixture from `src-tauri/tests/fixtures/`).
3. Navigate to that bucket.
4. Open DevTools → Performance tab → record while scrolling the list.
5. Verify p95 frame time ≤ 16.7 ms (60 fps).

This step cannot be automated in CI — it requires a native WebView and a real
GPU compositor.

---

## Gap: jsdom vs Real Hardware

The jsdom-based perf tests in `src/views/modes/__perf__/` are **smoke tests
only**.  They verify that the sort and index-building algorithms have not
regressed in raw CPU cost.  They do not and cannot measure:

- React reconciliation time
- DOM mutation / repaint cost
- GPU compositing or vsync alignment
- Tauri IPC serialization overhead
- Memory pressure from a live 10 000-item query result

For accurate frame-rate data, always run against a native Tauri build on real
hardware and use the DevTools Performance panel or Instruments (macOS) /
PerfView (Windows).
