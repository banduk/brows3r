# Tasks - s3-native-browser

Each task is exactly one shippable commit. Each task leaves the tree green
(`pnpm lint && pnpm typecheck && pnpm test && cargo fmt --check && cargo
clippy -- -D warnings && cargo test --workspace --all-targets`).
Conventional commit subject is suggested per task. Plan-review round 1
findings are absorbed throughout; design-level decisions taken in
response live in `design.md` `## Decisions`. Plan-review round 2 minor
findings (shortcut-map cross-layer snapshot, task 34 split, drag-out)
are also absorbed below.

## Tasks

### Phase A — Repo bootstrap (commits 1-5)

1. [x] Bootstrap Tauri 2 + Vite + React + TS skeleton
   - Goal: scaffold a runnable empty app via `pnpm create tauri-app` with
     React + TypeScript + Vite template, no extra logic.
   - Scope: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
     `tsconfig.json`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`,
     `src-tauri/{Cargo.toml, tauri.conf.json, src/main.rs, build.rs,
     icons/}`, `index.html`, `.gitignore`.
   - Likely files: all of the above.
   - Validation: `pnpm install && pnpm tauri dev` opens a window;
     `cargo build --manifest-path src-tauri/Cargo.toml` succeeds.
   - Done when: dev window renders the default Tauri starter and the
     working tree is green.
   - Commit: `chore(scaffold): bootstrap tauri 2 react vite typescript app`

2. [x] Configure Biome, Tailwind v4, shadcn/ui, and TS strict mode
   - Goal: lock in formatting/linting and the UI baseline.
   - Scope: `biome.json` (lint+format both on), `tsconfig.json` strict +
     `noUncheckedIndexedAccess`, Tailwind v4 install via
     `@tailwindcss/vite`, `index.css` with `@import "tailwindcss"`,
     `components.json` for shadcn, install `Button` + `Dialog` +
     `Tooltip` as smoke components, package scripts for
     `lint`/`lint:fix`/`typecheck`/`format`.
   - Likely files: `biome.json`, `tsconfig.json`, `vite.config.ts`,
     `index.css`, `components.json`, `src/components/ui/*`.
   - Validation: `pnpm lint`, `pnpm typecheck`, `pnpm build` all pass.
   - Done when: `<Button>` renders with Tailwind classes, all checks
     green.
   - Commit: `chore(tooling): add biome tailwind v4 shadcn baseline`

3. [x] Add lefthook + commitlint + Rust formatting/lint hooks
   - Goal: enforce conventional commits and per-file linters on every
     commit, never `--no-verify`.
   - Scope: `lefthook.yml` (pre-commit: `biome check --staged`,
     `cargo fmt --check`, `cargo clippy -- -D warnings` only on changed
     crate; commit-msg: `commitlint`), `commitlint.config.cjs`,
     installer script in `package.json` postinstall.
   - Likely files: `lefthook.yml`, `commitlint.config.cjs`,
     `package.json`.
   - Validation: a deliberately bad commit message is rejected; a clean
     commit passes.
   - Done when: hooks installed on `pnpm install`; intentional violation
     test (manual) is blocked.
   - Commit: `chore(hooks): wire lefthook commitlint and rust gates`

4. [x] Add README, LICENSE (MIT), CHANGELOG, and CI matrix incl. LocalStack
   - Goal: bootstrap project-facing documentation and a CI matrix that
     runs the full test suite on every PR, including a Linux integration
     job against LocalStack.
   - Scope:
     - `README.md` stub (purpose, dev quickstart, links to `.crafter/`).
     - `LICENSE` (MIT, current year, holder = Mauricio Banduk).
     - `CHANGELOG.md` (Keep a Changelog `## [Unreleased]`).
     - `.github/workflows/ci.yml` with two jobs:
       1. `unit` matrix (macos-latest, ubuntu-latest, windows-latest):
          setup pnpm + node + rust + cache; run `pnpm lint`,
          `pnpm typecheck`, `pnpm test --run`, `cargo fmt --check`,
          `cargo clippy -- -D warnings`,
          `cargo test --workspace --all-targets` (integration tests
          skipped here because they're gated by `--features integration`
          per below).
       2. `integration` (ubuntu-latest only) using `services:` block to
          spin LocalStack (`localstack/localstack:stable` pinned to a
          digest), `LOCALSTACK_URL=http://localhost:4566`, runs
          `cargo test --workspace --features integration -- --include-ignored`.
     - `.github/dependabot.yml`.
     - Document in README that integration tests gate on
       `#[cfg_attr(not(feature = "integration"), ignore)]` — convention
       referenced by every later integration-test task.
     - Document the macOS/Windows gap explicitly: the unit job runs
       lib + frontend on every OS; LocalStack-backed integration runs
       only on Linux. Per-platform integration is deferred to a nightly
       sandbox workflow against AWS itself (set up in a follow-up
       beyond v1).
   - Likely files: above.
   - Validation: workflow file passes `actionlint` locally; tree green
     once tasks 5+ start landing actual integration tests.
   - Done when: PR opened against this branch shows both `unit` (3 OSes)
     and `integration` (linux) jobs running.
   - Commit: `chore(repo): add readme license changelog and ci matrix`

5. [x] Install Tauri plugins fs/dialog/shell/notification with capabilities
   - Goal: install all v1 plugins as a single early commit so consuming
     tasks just import them, eliminating "command added but plugin
     missing" runtime failures (per design Decision D4).
   - Scope:
     - `src-tauri/Cargo.toml`: add `tauri-plugin-fs`,
       `tauri-plugin-dialog`, `tauri-plugin-shell`,
       `tauri-plugin-notification` at matching Tauri 2 versions.
     - `src-tauri/src/main.rs`: register each plugin via
       `tauri::Builder::default().plugin(...)`.
     - `package.json`: add the JS counterparts
       `@tauri-apps/plugin-{fs,dialog,shell,notification}`.
     - `src-tauri/capabilities/default.json`: minimal allowlists —
       dialog open/save, fs read/write within user-selected paths,
       shell `open` for "Reveal in Finder/Explorer", notification
       request/show.
     - `src-tauri/tauri.conf.json`: reference the capability set if
       required by Tauri 2 config.
     - Smoke unit test (`#[cfg(test)]` in `main.rs` or a `tests/`
       smoke) asserts the plugin handles construct without panic.
     - JS-side smoke: `src/test/smoke/plugins.test.ts` imports each JS
       plugin module and asserts the named exports exist.
   - Likely files: above.
   - Validation: `cargo build` and `pnpm test --run` pass; `pnpm tauri
     dev` still opens.
   - Done when: every plugin handle is reachable from Rust and JS.
   - Commit: `chore(tauri): install plugins fs dialog shell notification`

### Phase B — Rust core skeleton (commits 6-9)

6. [x] Add `AppError` (full 12 variants), IDs, and IPC error response shape
   - Goal: unified error type and stable IPC envelope.
   - Scope: `src-tauri/src/error.rs` with `AppError` enum covering all 12
     variants from `design.md` lines 410-423: `Auth`, `AccessDenied`,
     `NotFound`, `Conflict`, `RateLimited`, `Unsupported`, `Network`,
     `Cancelled`, `Locked`, `Validation`, `ProviderSpecific`, and
     `Internal { trace_id }` (per round-1 finding #1; `trace_id` is
     generated from `uuid::Uuid::new_v4()` at construction and is the
     link diagnostics bundles use to tie a presented error to log
     lines); `Serialize` impl producing `{ kind, message, retryable,
     details? }`; `src-tauri/src/ids.rs` with `ProfileId`, `BucketId`,
     `ObjectKey` newtypes; tests covering serialization round-trip for
     every variant including the `Internal { trace_id }` round-trip.
   - Likely files: `src-tauri/src/error.rs`, `src-tauri/src/ids.rs`,
     `src-tauri/src/lib.rs`, `Cargo.toml` (`uuid`, `serde`).
   - Validation: `cargo test --lib` passes; sample `Result<(), AppError>`
     serializes to expected JSON for each variant.
   - Done when: `AppError` is the only error type leaving any future
     command, and `Internal::trace_id` is reachable from the
     diagnostics module.
   - Commit: `feat(core): add AppError envelope and id newtypes`

7. [x] Wire `aws-sdk-s3` client pool with per-(profile,region) caching
       and proxy support
   - Goal: produce `aws-sdk-s3::Client` instances configured by profile +
     region, applying compat flags as scaffolded options and honoring
     the proxy setting from `Settings` (per round-1 finding #19).
   - Scope: `src-tauri/src/s3/{mod.rs,client.rs}`,
     `src-tauri/src/profiles/compat_flags.rs` (struct only — no UI yet),
     in-memory pool keyed by `(ProfileId, Region)`. Build the
     `aws-config::HttpClient` via a `hyper`/`reqwest` connector that
     consumes the proxy URL from `Settings::proxy` (env-var
     `HTTP_PROXY`/`HTTPS_PROXY` honored by default; explicit override
     via settings).
   - Likely files: above + `Cargo.toml` deps (`aws-config`, `aws-sdk-s3`,
     `aws-credential-types`, `hyper`, optional `hyper-proxy` or built-
     in connector).
   - Validation: `cargo test --lib` covers client builder for AWS, for a
     custom-endpoint provider with `path_style=true`, and for proxy URL
     applied to the underlying connector.
   - Done when: pool returns the same client instance for repeat
     `(profile,region)` calls and proxy URL is observable in the
     connector config.
   - Commit: `feat(s3): add client pool with profile region caching and proxy`

8. [x] Add settings store with all v1 defaults from proposal
   - Goal: `Settings` struct mirroring **all** proposal defaults (lines
     190-206); load/save under `${app_config_dir}/settings.json`;
     preserves unknown keys (per round-1 finding #12).
   - Scope:
     - `src-tauri/src/settings/{mod.rs,defaults.rs}` with every v1
       default from the proposal codified — download_dir,
       transfer_concurrency=4, cache_ttl, cache_size_cap,
       preview_size_limit_mb=50, default_view_mode, notifications
       toggles, fallback_threshold_mb=100, transfer_confirmations,
       s3_compatible_endpoints registry, auto_update channel,
       diagnostics_enabled, startup_behavior, proxy="system".
     - Commands `settings_get` and `settings_update` (skeleton — no UI
       yet).
     - Snapshot test asserting `Settings::default()` matches the
       proposal's Settings block byte-for-byte (test fixture pulled
       from `proposal.md` for traceability).
     - Round-trip and unknown-key-preservation tests.
   - Likely files: above + `src-tauri/src/commands/settings_cmd.rs`.
   - Validation: `cargo test --lib` covers defaults equal to proposal,
     load missing file → defaults, unknown keys preserved.
   - Done when: `tauri::generate_handler!` includes the two commands and
     `transfer_concurrency` (and every other v1 setting) is consumable
     by later tasks without a schema bump.
   - Commit: `feat(settings): add typed store with all v1 defaults`

9. [x] Add notification log + typed event helper + OS notification bridge
   - Goal: backend-side notifications log with severity, resource,
     operation, timestamp, copyable details; a single `notification:new`
     event broadcast; a typed `events::emit(event_kind, payload)` helper
     that all event-emitting modules will reuse (per round-1 finding
     #14); the OS-notification bridge wired to
     `tauri-plugin-notification` (which was installed in task 5; per
     round-1 finding #4).
   - Scope:
     - `src-tauri/src/notifications/{mod.rs,os.rs}`, commands
       `notifications_list` and `notification_dismiss`, in-memory ring
       buffer (default 500 entries).
     - `src-tauri/src/events.rs` with a typed `emit(app, EventKind, T)`
       helper exposing `EventKind::{BucketsUpdated, ObjectsUpdated,
       TransferProgress, TransferState, LockAcquired, LockReleased,
       NotificationNew, SearchPage, MediaRevoked, UpdaterStatus}`.
       Every later mutation/event-emitter calls through this helper —
       enables uniform testing of "this command emits event X with
       payload Y".
     - `os.rs` invokes `tauri-plugin-notification` only when
       `Settings::notifications.os_enabled = true` and the event is
       terminal (`done` / `failed`); a settings test covers gating.
     - Tests: emission + dismissal of in-app notifications;
       `events::emit` typed payload contract; OS notification gating by
       settings flag (mock plugin handle).
   - Likely files: above + `src-tauri/src/commands/notifications_cmd.rs`.
   - Validation: `cargo test --lib` covers all three behaviors.
   - Done when: future commits use `events::emit(...)` exclusively, and
     terminal-state transfers can fire OS notifications.
   - Commit: `feat(notifications): add log typed events and os bridge`

### Phase C — Profiles + credentials (commits 10-18)

10. [x] Parse `~/.aws/credentials` and `~/.aws/config`
    - Goal: enumerate AWS-defined profiles incl. role chaining metadata.
    - Scope: `src-tauri/src/profiles/aws_config.rs`; uses `aws-config`
      credential provider chain to surface profiles without resolving
      credentials yet; tests over fixture INI files in
      `src-tauri/tests/fixtures/aws_config/*`.
    - Likely files: above.
    - Validation: `cargo test --lib` covers basic profile, profile with
      `source_profile`, profile with `role_arn` + `mfa_serial`.
    - Done when: a fixture run returns the expected list and chain refs.
    - Commit: `feat(profiles): parse aws credentials and config files`

11. [x] OS keychain store/retrieve via `keyring` with file fallback
    - Goal: persist manual-profile secret material in the OS keychain
      keyed by `brows3r:<profileId>`, with a passphrase-encrypted file
      fallback feature-gated behind `keyring_fallback_file` (off by
      default, surfaced via notification when used).
    - Scope: `src-tauri/src/profiles/keychain.rs`; tests use a feature
      flag stub backend so CI does not require a real keychain.
    - Likely files: above + `Cargo.toml` (`keyring = "*"`).
    - Validation: `cargo test --lib --features test-keyring-stub`
      covers store, retrieve, delete, missing key.
    - Done when: round-trip works on stub backend; real backend
      exercised manually on each OS.
    - Commit: `feat(profiles): add os keychain via keyring crate`

12. [x] Add `ProfileStore` aggregating discovered + manual profiles
    - Goal: unify AWS-discovered profiles, manual profiles, and env-
      derived profile into one read API; assign and persist stable
      `ProfileId` for manual profiles.
    - Scope: `src-tauri/src/profiles/mod.rs`; `profiles_list`,
      `profile_get`, `profile_create_manual`, `profile_update`,
      `profile_delete`; persistence of manual profile metadata in
      `${app_config_dir}/profiles.json`; tests.
    - Likely files: above + `src-tauri/src/commands/profiles_cmd.rs`.
    - Validation: unit tests cover dedup and stable IDs; commands
      registered.
    - Done when: a frontend mock invocation returns a coherent profile
      list including a freshly-created manual profile.
    - Commit: `feat(profiles): add aggregate profile store and commands`

13. [x] Implement profile validation (`sts:GetCallerIdentity` + probe)
    - Goal: `profile_validate` runs `sts:GetCallerIdentity` for AWS or a
      `list_buckets` probe for compat providers; populates per-profile
      `validated_at` used by the validation gate.
    - Scope: `src-tauri/src/profiles/validation.rs`; integration test
      against LocalStack (gated by `--features integration` per
      task 4).
    - Likely files: above.
    - Validation: integration test asserts success against LocalStack
      and a structured `Auth` error against a bogus secret.
    - Done when: cache layer can later refuse to render unvalidated
      profile data.
    - Commit: `feat(profiles): validate via sts get caller identity`

14. [x] Implement compat flags application path with forward-compat tests
    - Goal: apply each v1 compat flag (endpoint URL, region override,
      addressing style, signature version, checksum mode, TLS self-
      signed acceptance, expect-continue, chunked upload, bucket-name
      validation) and warn-and-pass-through unknown flags (per round-1
      finding #21).
    - Scope: extend `s3::client` to consume `CompatFlags`; tests for
      each flag's effect on the resulting `aws-sdk-s3::Config`;
      explicit tests for (a) unknown flag emits a notification but does
      not error, (b) `flags_schema` mismatch is gracefully handled with
      a notification and the known-flag subset is still applied;
      compatibility integration test against a MinIO docker container
      (gated by `MINIO_URL`, off by default in CI).
    - Likely files: `src-tauri/src/profiles/compat_flags.rs`,
      `src-tauri/src/s3/client.rs`.
    - Validation: unit tests assert config side-effects + forward-compat
      behaviors; MinIO test uploads + lists with `path_style=true`,
      `checksum_mode=disabled`.
    - Done when: every flag is exercised by a test and unknown-flag
      and schema-mismatch paths are exercised.
    - Commit: `feat(profiles): apply v1 compat flags with forward compat`

15. [x] Frontend: typed `invoke`/`listen` wrappers, api modules, and
       TanStack Query client + canonical keys
    - Goal: a single `lib/tauri.ts` typed wrapper plus per-domain `api/*`
      modules mirroring the Rust commands shipped so far, plus the
      TanStack Query client and the canonical query-key catalog used by
      every later UI surface (per round-1 finding #8).
    - Scope:
      - `src/lib/tauri.ts`, `src/lib/errors.ts`.
      - `src/api/profiles.ts`, `src/api/settings.ts`,
        `src/api/notifications.ts`.
      - `src/query/client.ts` — TanStack Query client with the SWR
        timing capped at 30s plus a Tauri event adapter that
        translates `objects:updated`/`buckets:updated`/`media:revoked`
        into `queryClient.invalidateQueries`.
      - `src/query/keys.ts` — canonical key factory:
        `keys.buckets(profileId)`, `keys.objects(profileId, bucket,
        prefix)`, `keys.inspector(profileId, bucket, key?)`,
        `keys.transfers()`, `keys.notifications()`.
      - Vitest mocks for `@tauri-apps/api`.
    - Likely files: above + `src/test/setup.ts`,
      `src/test/mocks/tauri.ts`.
    - Validation: `pnpm test --run` covers a happy invoke, an
      `AppError` mapping to UI presentation, and key-stability tests
      (the same args produce the same key).
    - Done when: future UI work imports typed APIs and query keys
      from these modules only.
    - Commit: `feat(frontend): add typed tauri adapter api and query keys`

16. [x] Frontend: command registry + baseline shortcuts + conflict resolver
    - Goal: ship the command registry foundation, the baseline shortcut
      map covering every v1 command, and the conflict resolver — with
      no UI consumers yet (per round-1 finding #7, split a of three).
    - Scope:
      - `src/commands/registry.ts` — `CommandDef { id, title, group,
        defaultShortcut?, run(ctx) }` registry with lookup helpers.
      - `src/commands/shortcuts.ts` — baseline shortcut map keyed by
        command id; per-platform substitution (mac vs win/linux).
        The map must verbatim match the proposal's enumerated baseline
        in `proposal.md` lines 175-176 (arrows, Enter, Space,
        Backspace, Delete, Cmd+C/X/V, Cmd+A, Cmd+F, Cmd+R,
        Cmd+Shift+P, Cmd+1-7, Cmd+Option+Left/Right) — addresses
        round-2 finding #1.
      - `src/commands/conflicts.ts` — pure resolver detecting duplicate
        bindings, returning a structured `ConflictReport`.
      - `src/commands/definitions/` — empty module folder with a
        README; one stub registration so the registry is non-empty.
      - Vitest tests for: registration, lookup, default shortcut
        resolution per platform, conflict detection on overlapping
        bindings, conflict-resolver determinism.
      - **Cross-layer snapshot test** (round-2 finding #1): assert the
        baseline shortcut map exported from `src/commands/shortcuts.ts`
        matches a fixture pulled verbatim from `proposal.md` lines
        175-176. The fixture lives at
        `src/commands/__fixtures__/baseline-shortcuts.proposal.json`
        with a comment pointing at the proposal source.
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: registry exposes `.lookupById`, `.lookupByShortcut`,
      `.detectConflicts`; the shortcut-map snapshot test passes; no UI
      depends on it yet (palette + cred manager arrive in tasks 17-18).
    - Commit: `feat(commands): add registry baseline shortcuts and conflicts`

17. [x] Frontend: command palette skeleton wired to registry
    - Goal: keyboard-invokable command palette UI consuming the registry
      (per round-1 finding #7, split b of three). Empty list until
      later tasks register commands.
    - Scope:
      - `src/store/command_palette.ts` (Zustand slice: open/closed,
        query, focused index).
      - `src/views/shell/CommandPalette.tsx` — modal, fuzzy filter,
        keyboard nav (↑/↓/Enter/Esc), shortcut display per item.
      - Global shortcut binding for `Cmd/Ctrl+K` opens palette.
      - Vitest tests for filter, keyboard nav, shortcut activation,
        empty state.
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: palette opens/closes on shortcut and renders all
      currently-registered commands (initially the stub from task 16).
    - Commit: `feat(commands): add palette skeleton wired to registry`

18. [x] Frontend: Credential Manager UI + keychain fallback prompt
    - Goal: list/add/edit/delete profiles, edit compat flags, validate
      profile button (per round-1 finding #7, split c of three;
      absorbs round-1 finding #23 keychain fallback prompt UX).
    - Scope:
      - `src/views/sidebar/Profiles.tsx`,
        `src/views/settings/ProfileEditor.tsx`.
      - First-run prompt + notification when the keychain fallback
        path is taken (only shown once per session); reads a runtime
        signal from the backend.
      - Registers credential-manager commands with the registry from
        task 16 (Add Profile, Validate Profile, Delete Profile).
      - Includes axe-core a11y assertion in the component test
        (per Decision D5 baseline).
      - Vitest component tests: add/edit/delete flow with mocked
        invoke; validate button disables during in-flight; keychain
        fallback prompt fires exactly once per session test.
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: a manual profile can be created end-to-end against a
      mocked backend, validated, and the fallback prompt appears at
      most once per session.
    - Commit: `feat(profiles): add credential manager ui with fallback prompt`

### Phase D — Cache, locks, capability (commits 19-22)

19. [x] Authoritative SWR cache with validation gate (redb backend)
    - Goal: `cache::store` with TTL, stale-while-revalidate, validation
      gate (no read-through until `profile_validate` succeeds in this
      session), and per-profile invalidation. Backed by `redb` per
      Decision D1 (per round-1 findings #2, #3).
    - Scope:
      - `src-tauri/Cargo.toml`: add `redb = "2"` dependency.
      - `src-tauri/src/cache/{mod.rs,store.rs,invalidation.rs}` with
        the in-memory + `redb`-backed store.
      - Tests for: TTL expiry; SWR stale read; the AC-8 validation
        gate ("Given a profile has not been validated in the current
        session, when cached data exists for that profile, then bucket/
        object cache contents are not displayed until credential
        validation succeeds" — verbatim test name); per-profile
        invalidation; smoke test that `redb` round-trips a listing
        entry.
    - Likely files: above.
    - Validation: `cargo test --lib` covers all behaviors named above.
    - Done when: subsequent commands consume this cache rather than
      hitting S3 directly; cache refuses to read-through for
      unvalidated profiles in the current session.
    - Commit: `feat(cache): add swr cache with validation gate via redb`

20. [x] Capability classification cache
    - Goal: `cache::capability` storing `(profile,bucket?,op)` →
      `{Allowed | Denied | Unsupported | StorageClassBlocked, learnedAt}`
      with TTL and manual clear.
    - Scope: `src-tauri/src/cache/capability.rs`,
      `capability_get`/`capability_clear` commands; tests for
      classification of synthesized errors.
    - Likely files: above + `src-tauri/src/commands/inspector_cmd.rs`.
    - Validation: unit tests classify each known error shape correctly.
    - Done when: future inspector and op commands can call
      `record_capability(...)` after each call.
    - Commit: `feat(cache): add capability classification cache`

21. [x] Resource lock registry with full lifecycle
    - Goal: acquire/release/heartbeat/TTL-expire/startup-cleanup as in
      AC-4; `locks_list`, `lock_release_stale`; `lock:acquired` /
      `lock:released` events emitted via the typed `events::emit`
      helper from task 9.
    - Scope: `src-tauri/src/locks/{mod.rs,lifecycle.rs}`,
      `src-tauri/src/commands/locks_cmd.rs`; unit tests for acquire,
      double-acquire conflict, heartbeat extension, TTL expiry,
      startup cleanup, release reasons; assertion-level tests that
      `lock:acquired`/`lock:released` are emitted with the correct
      scope payloads.
    - Likely files: above.
    - Validation: `cargo test --lib` covers all six lifecycle states +
      event payload assertions.
    - Done when: any future op can acquire a scoped lock and release it
      on every terminal state, and event emission is verified.
    - Commit: `feat(locks): add resource lock registry with lifecycle`

22. [x] Frontend: notification panel + toast/inline error system
    - Goal: in-app notifications panel + toast bus + inline error slot
      driven by backend `notification:new` events; classifies user-
      initiated vs background per AC-9.
    - Scope: `src/views/notifications/*`, `src/store/notifications.ts`,
      `src/lib/errors.ts` mapping policy; axe-core a11y assertion per
      Decision D5; Vitest tests for severity rendering, dismissal,
      copyable details, background-vs-foreground placement.
    - Likely files: above.
    - Validation: tests cover all three placements (panel only, panel +
      toast, panel + inline) and the a11y assertion passes.
    - Done when: every future operation can call a single
      `present(error)` helper.
    - Commit: `feat(notifications): add panel toast and inline system`

### Phase E — Buckets and listing (commits 23-30)

23. [x] `buckets_list` with SWR, validation-gate enforcement, and region discovery
    - Goal: list buckets via `aws-sdk-s3`, store in cache, kick off
      background per-bucket region discovery, and refuse to serve
      cached results to an unvalidated profile session (per round-1
      finding #9 backend layer).
    - Scope: `src-tauri/src/s3/list.rs`,
      `src-tauri/src/commands/buckets_cmd.rs`; integration test
      against LocalStack (gated by `--features integration`) covering
      happy path, access denied, and explicit "unvalidated profile is
      refused at command boundary" case; unit test for region cache
      lookup; assertion-level test that `buckets:updated` event is
      emitted with `{ profileId }` after revalidation (round-1 finding
      #14).
    - Likely files: above.
    - Validation: `cargo test --workspace --features integration`
      against LocalStack.
    - Done when: subsequent calls within TTL hit cache; region is
      eventually-consistent and lazy-resolved on miss; unvalidated
      profile cannot pull bucket list.
    - Commit: `feat(s3): list buckets with swr region and validation gate`

24. [x] `objects_list` and `objects_list_flat` with pagination + validation gate
    - Goal: paginated listing with continuation tokens; flat-key
      variant; backend-side parallel page fetch for large prefixes;
      refuse cached read-through for unvalidated profile (per round-1
      finding #9 backend layer).
    - Scope: `src-tauri/src/s3/list.rs` (extend),
      `src-tauri/src/commands/objects_cmd.rs`; integration tests for
      both shapes against LocalStack including a 1.2k-object prefix
      and the unvalidated-profile refusal case.
    - Likely files: above.
    - Validation: integration tests assert page tokens chain, flat view
      drops `CommonPrefixes`, and unvalidated profile is refused.
    - Done when: frontend can drive infinite scroll via tokens.
    - Commit: `feat(s3): paginated objects list with validation gate`

25. [x] Path encoder: display path vs canonical URI
    - Goal: stable `profile_id`-based canonical URI with percent-encoded
      bucket/key; human display path for breadcrumb.
    - Scope: `src-tauri/src/path/{mod.rs,encode.rs}`; tests cover
      duplicate-name profiles, unicode keys, keys with `?#%/`.
    - Likely files: above.
    - Validation: `cargo test --lib` covers encoding round-trip and AC-2
      duplicate-name scenario.
    - Done when: frontend has a single source for both forms.
    - Commit: `feat(path): canonical uri encoder with stable profile id`

26. [x] Frontend: three-pane shell + sidebar + breadcrumb + a11y baseline + useValidatedProfile
    - Goal: app shell with resizable three-pane layout (sidebar / file
      list placeholder / preview placeholder), profile picker,
      bookmarks placeholder, breadcrumb path bar with click-to-
      navigate. Includes the a11y baseline (focus management, ARIA
      roles, tab order — per Decision D5) and the
      `useValidatedProfile()` hook used by every subsequent UI to gate
      rendering on validation (per round-1 finding #9 frontend layer).
    - Scope:
      - `src/views/shell/*`, `src/views/sidebar/*`,
        `src/views/browser/Breadcrumb.tsx`, `src/store/{ui.ts,
        panes.ts}`.
      - `src/query/hooks/useValidatedProfile.ts` — single source of
        truth for "should we render data for this profile?".
        Composes with `useBuckets`/`useObjects` etc. so they no-op
        when validation is unset.
      - A11y baseline: focus trap helpers, ARIA roles for nav/list
        landmarks, documented tab order, skip-to-main link.
      - Tests: breadcrumb segment click + collapsed state;
        `useValidatedProfile` returns false until backend reports
        validation; axe-core assertion on the empty shell.
    - Likely files: above.
    - Validation: `pnpm test --run` and visual smoke via `pnpm tauri
      dev` show the empty shell.
    - Done when: clicking a profile in the sidebar requests bucket list
      via `useBuckets` only when `useValidatedProfile(profileId)` is
      true; axe-core baseline passes.
    - Commit: `feat(shell): add three pane layout sidebar breadcrumb a11y`

27. [x] Frontend: Details view with TanStack Virtual + multi-select + icons
    - Goal: virtualized details view with sortable columns (name, size,
      modified, storage class), Shift+click range select, Cmd/Ctrl+click
      individual select, keyboard nav, file-icon-by-extension component
      (per round-1 finding #18).
    - Scope: `src/views/modes/DetailsView.tsx`,
      `src/components/Virtualized.tsx`,
      `src/components/FileIcon.tsx`,
      `src/lib/icons.ts` (extension → icon mapping; uses
      `vscode-icons-js` or equivalent),
      `src/lib/selection.ts`; tests for selection model + keyboard
      navigation; icon mapping test (`.ts` → TS icon, unknown → default);
      perf smoke with 1k mocked rows; axe-core assertion (Decision D5).
    - Likely files: above + `package.json` (icon set dep).
    - Validation: `pnpm test --run`; perf smoke <16ms render budget for
      1k rows.
    - Done when: connected to `objects_list` it scrolls smoothly with a
      real listing and icons render per extension.
    - Commit: `feat(browser): add details view with virtualized list`

28. [x] Frontend: icon grid + gallery view modes (split a of three)
    - Goal: Icon/grid and Gallery view modes (per round-1 finding #11
      split a). Lands the switching contract module that subsequent
      splits extend.
    - Scope:
      - `src/views/modes/IconGridView.tsx`,
        `src/views/modes/GalleryView.tsx`.
      - `src/views/modes/switching.ts` — view-mode switch contract
        with selection-preservation rules; initially handles
        Details/Icon/Gallery transitions.
      - Tests for icon/grid virtualization, gallery image loading,
        and the switching contract for Details↔Icon↔Gallery; axe-core
        assertion per Decision D5.
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: `Cmd/Ctrl+1..3` cycles among Details/Icon/Gallery
      with selection rules preserved.
    - Commit: `feat(browser): add icon grid and gallery views`

29. [x] Frontend: tree + column view modes incl. *-to-Column test (split b)
    - Goal: Tree and Column view modes (per round-1 finding #11 split
      b). Extends the switching contract for hierarchical/cascading
      semantics and includes the round-3 derived `*-to-Column` test
      case (per design line 562).
    - Scope:
      - `src/views/modes/TreeView.tsx`,
        `src/views/modes/ColumnView.tsx`.
      - `src/views/modes/switching.ts` (extend) — implements:
        Details/Icon/Gallery/Tree → preserve location and selection;
        Column entry from any other mode and parent-column change →
        preserve location, deeper-column selection resets.
      - Tests cover Tree expansion/collapse, Column cascade
        navigation, and the `*-to-Column` derived test case
        (round-3 residual #2); axe-core assertion per Decision D5.
    - Likely files: above.
    - Validation: `pnpm test --run`; the `*-to-Column` test is named
      to match the residual item for traceability.
    - Done when: `Cmd/Ctrl+4..5` switches to Tree/Column with selection
      rules preserved per AC-3 and the derived test case is green.
    - Commit: `feat(browser): add tree and column views with switching`

30. [x] Frontend: flat key + dual pane view modes (split c)
    - Goal: Flat key and Dual-pane view modes (per round-1 finding #11
      split c). Extends the switching contract for independent-state
      semantics.
    - Scope:
      - `src/views/modes/FlatKeyView.tsx`,
        `src/views/modes/DualPaneView.tsx`.
      - `src/store/panes.ts` (extend) — independent state slice per
        pane in dual-pane mode.
      - `src/views/modes/switching.ts` (extend) — flat-key collapses
        virtual-folder selections to underlying object selections;
        dual-pane preserves per-pane location/selection on entry/
        exit.
      - Tests cover flat-key collapse, dual-pane independence, and
        switching to/from each; axe-core assertion per Decision D5.
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: `Cmd/Ctrl+6..7` switches to Flat/Dual with selection
      rules preserved; AC-3 passes end-to-end across all seven modes.
    - Commit: `feat(browser): add flat key and dual pane views`

### Phase F — File operations (commits 31-42)

31. [x] Streaming download with progress events
    - Goal: `transfer_download` streams `get_object` body in 256 KB
      chunks, emits `transfer:progress` and `transfer:state` via the
      typed events helper, integrates with lock registry.
    - Scope: `src-tauri/src/transfers/{mod.rs,download.rs,progress.rs}`,
      `src-tauri/src/commands/transfers_cmd.rs`; integration test
      downloads a 5 MB blob from LocalStack and verifies events.
    - Likely files: above.
    - Validation: integration test asserts byte equality + ≥1 progress
      event per 256 KB.
    - Done when: cancellation aborts mid-stream.
    - Commit: `feat(transfers): add streaming download with progress`

32. [x] Single-part and multipart upload with progress + redb bookkeeping
    - Goal: `transfer_upload` chooses single vs multipart by 5 MB
      threshold; per-part progress; cancellation aborts the multipart
      upload server-side; multipart bookkeeping recorded in the redb
      `multipart_active` table introduced in task 19 (per round-1
      findings #2, #3).
    - Scope: `src-tauri/src/transfers/upload.rs`,
      `src-tauri/src/s3/multipart.rs`; integration tests for both
      paths and for cancellation cleanup; assertion-level test that
      `objects:updated` is emitted with the correct `(profileId,
      bucket, prefix)` after a successful upload (round-1 finding
      #14).
    - Likely files: above.
    - Validation: integration test confirms no orphan parts after
      cancel via `list_multipart_uploads`; redb table has matching
      entry while in flight and is cleared on terminal state.
    - Done when: large upload completes, cancel leaves no leftover, and
      the event-emission assertion passes.
    - Commit: `feat(transfers): add single and multipart upload`

33. [x] Transfer queue with concurrency cap, retry, and OS notifications
    - Goal: queue transfers, respect `transfer_concurrency` (default 4
      from task 8 settings), expose
      `transfer_list`/`transfer_cancel`/`transfer_retry`, and fire OS
      notifications on terminal `done`/`failed` states gated by the
      settings flag (per round-1 finding #4).
    - Scope: `src-tauri/src/transfers/mod.rs` (extend); unit +
      integration tests for queueing, concurrency cap, retry-from-
      start, and the OS-notification emission gated by settings.
    - Likely files: above.
    - Validation: tests assert at most N concurrent runners and
      OS-notification fires only when settings flag is true.
    - Done when: queue drains in order of submission with cap honored
      and terminal-state notifications fire per settings.
    - Commit: `feat(transfers): add concurrency capped queue with notifications`

34. [x] `object_copy`, `object_move`, `object_create_folder` (split a of three)
    - Goal: server-side copy primitive; move = copy + delete (uses
      low-level `delete_object`); create-folder PUTs zero-byte
      `prefix/` object (per round-2 finding #2 split a). Sets up the
      `s3::object` module that splits b/c extend.
    - Scope: `src-tauri/src/s3/object.rs`,
      `src-tauri/src/commands/objects_cmd.rs` (register `object_copy`,
      `object_move`, `object_create_folder`); integration tests for
      each command against LocalStack including large-blob copy and
      move-leaves-no-source assertions; assertion-level test that
      `objects:updated` is emitted with correct prefix on each
      mutation (round-1 finding #14).
    - Likely files: above.
    - Validation: integration tests verify final state via listing and
      event payload.
    - Done when: the three commands are wired and emit
      `objects:updated` with verified scope.
    - Commit: `feat(s3): add copy move and create folder primitives`

35. [x] `object_delete_batch` (split b of three)
    - Goal: batched delete via `delete_objects` API with partial-
      failure reporting per AC-4 (per round-2 finding #2 split b).
    - Scope: `src-tauri/src/s3/object.rs` (extend),
      `src-tauri/src/commands/objects_cmd.rs` (register
      `object_delete_batch`); integration tests covering: all-success
      batch, partial-failure batch with structured `DeleteReport`,
      versioned-key batch (when bucket has versioning); assertion-
      level test that `objects:updated` fires with the union of
      affected prefixes.
    - Likely files: above.
    - Validation: integration tests pass against LocalStack including
      a partial-failure scenario.
    - Done when: `DeleteReport` shape matches the frontend's expected
      schema and partial-failure surfacing matches AC-4.
    - Commit: `feat(s3): add object delete batch with partial failure`

36. [x] `object_set_metadata`, `object_set_tags` (split c of three)
    - Goal: metadata and tag setters using `copy_object` self-overwrite
      semantics with ETag precondition (per round-2 finding #2 split
      c, closes round-1 finding #13).
    - Scope: `src-tauri/src/s3/{metadata.rs,tags.rs}`,
      `src-tauri/src/commands/objects_cmd.rs` (register
      `object_set_metadata`, `object_set_tags`); integration tests
      covering: metadata round-trip, tag round-trip, ETag precondition
      conflict (412), tag-removal (empty tagset); assertion-level test
      that `objects:updated` is emitted with correct prefix.
    - Likely files: above.
    - Validation: integration tests pass against LocalStack including
      the ETag conflict path.
    - Done when: both commands are wired with ETag precondition
      enforcement and event emission verified.
    - Commit: `feat(s3): add object metadata and tag setters`

37. [x] Cross-account fallback with threshold + confirmation
    - Goal: `object_copy` detects access-denied or cross-account and
      falls back to download+upload below the 100 MB default threshold;
      above threshold, returns `Validation` error requiring an explicit
      confirmation token from the frontend.
    - Scope: `src-tauri/src/s3/object.rs` (extend); integration test
      simulates cross-account by using two LocalStack profiles +
      buckets.
    - Likely files: above.
    - Validation: tests cover both branches.
    - Done when: behaviour matches AC-4 cross-account criteria.
    - Commit: `feat(s3): add cross account fallback with threshold`

38. [x] Multipart upload cleanup scanner with safety guards
    - Goal: `multipart_scan` lists old multipart uploads tagged
      brows3r-vs-unknown via the `multipart_active` redb table;
      `multipart_abort` requires `confirmedUnknown=true` for foreign
      uploads.
    - Scope: `src-tauri/src/s3/multipart.rs` (extend),
      `src-tauri/src/commands/transfers_cmd.rs` (extend); integration
      tests covering both source classes.
    - Likely files: above.
    - Validation: tests confirm refusal without confirmation flag.
    - Done when: scanner output matches AC-4 cleanup scenarios.
    - Commit: `feat(s3): add multipart cleanup scanner with guards`

39. [x] Presigned URL command and clipboard integration
    - Goal: `object_presign` returns a URL with configurable expiry; UI
      copies to clipboard (frontend wiring covered in commit 42 —
      context menu "Copy presigned URL" action).
    - Scope: `src-tauri/src/s3/presign.rs`,
      `src-tauri/src/commands/objects_cmd.rs`; integration test covers
      expiry boundary.
    - Likely files: above.
    - Validation: integration test validates URL expires after the
      configured TTL.
    - Done when: command is registered and tested.
    - Commit: `feat(s3): add presigned url generation`

40. [x] Frontend: Transfer Manager panel with progress + cancel/retry +
       toolbar inspector affordance
    - Goal: Transfer Manager panel mirrors backend `transfer:*` events;
      shows MB/s, percent, ETA; provides cancel/retry; minimization
      preserves access per AC-9/AC-14. Also lands the toolbar
      "Inspect" affordance referenced by round-1 finding #25 (so
      task 45 can tighten its Done-when to keyboard shortcut +
      selection details only).
    - Scope:
      - `src/views/transfers/*`, `src/store/transfers.ts` — panel,
        Zustand mirror, MB/s + ETA computation.
      - `src/views/browser/Toolbar.tsx` — toolbar surface containing
        the Inspect action, registered with the command registry from
        task 16.
      - Gates rendering of transfer rows by
        `useValidatedProfile(profileId)` (round-1 finding #9 frontend
        layer).
      - Tests for state mirroring, cancel/retry, minimization,
        toolbar Inspect activation; axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run` covers all behaviors.
    - Done when: a real transfer surfaces in the panel end-to-end and
      the Inspect toolbar action invokes the inspector.
    - Commit: `feat(transfers): add transfer manager panel ui`

41. [x] Frontend: drag-and-drop upload + S3-to-S3 move/copy + drag-out
    - Goal: drop OS files onto a pane to upload; drag selection between
      panes triggers move (Shift = copy) with destination preview;
      drag S3 selection to Finder/Explorer triggers download to that
      path via Tauri's drag-out API on macOS/Windows, with a "Save
      to..." dialog fallback on Linux (per round-2 finding #3, closes
      proposal line 178 + design line 628 drag-out commitment).
    - Scope:
      - `src/views/browser/DropZone.tsx`,
        `src/views/modes/dnd/*` (drop-in + cross-pane).
      - `src/views/browser/DragOut.tsx` — Tauri 2 `drag` API hook
        wiring the S3-to-OS path; Linux branch detects platform and
        opens the save dialog (`tauri-plugin-dialog`) instead.
      - Tests with synthetic drop events for drop-in + cross-pane;
        platform-conditional test asserting the Linux branch opens
        the save dialog and the macOS/Windows branch invokes the
        drag API; axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run` (platform-conditional tests use
      `vi.mock` to swap the platform indicator).
    - Done when: drop into Dual-pane other side initiates the right
      operation, and dragging an S3 object to Finder on macOS
      downloads it (manual smoke); Linux fallback test green.
    - Commit: `feat(browser): add drag and drop upload cross pane and drag out`

42. [x] Frontend: context menus + lock-aware action gating + optimistic updates
    - Goal: right-click + keyboard-driven context menus for all v1 file
      operations, gated by `useLocks(...)` to disable conflicting
      actions with a clear reason. Also lands the optimistic-update
      adapter for predictable mutations (per Decision D2 + round-1
      finding #22): create-folder, single delete, single rename
      produce optimistic UI state that reconciles against backend
      events and rolls back on `AppError`.
    - Scope:
      - `src/views/browser/ContextMenu.tsx`,
        `src/store/locks.ts`.
      - `src/query/optimistic.ts` — predicted-post-state builder per
        mutation kind; `onMutate` / `onError` rollback wiring against
        TanStack Query mutations.
      - Context-menu actions registered with the command registry
        from task 16, including the "Copy presigned URL" action that
        invokes `object_presign` from task 39 and writes the result
        to the clipboard (closes round-3 finding #1: this is the
        explicit home for the presigned-URL frontend wiring).
      - Tests for: action gating during a held lock; AC-4 "released
        lock makes blocked actions available" scenario; optimistic
        create-folder appears immediately and reconciles with backend
        listing; rollback on simulated `AppError` with toast firing;
        diff-gated and cross-account mutations explicitly do not use
        optimism (regression test); "Copy presigned URL" action
        invokes `object_presign` and writes to clipboard (mocked);
        axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: optimistic mutations show instantly and roll back on
      failure; gated mutations remain event-driven.
    - Commit: `feat(browser): add context menus locks and optimistic updates`

### Phase G — Inspector + diff/confirmation framework (commits 43-46)

43. [x] Bucket inspector backend
    - Goal: `bucket_inspect` returns region, versioning, encryption
      (read-only), lifecycle, object lock, PAB, CORS, tags, replication,
      logging, website, notifications, ownership controls, requester
      pays. Bucket policy intentionally absent (deferred per
      Decisions). Each section gracefully reports unsupported / denied
      capability and feeds the capability cache.
    - Scope: `src-tauri/src/s3/inspector.rs`,
      `src-tauri/src/commands/inspector_cmd.rs`; integration test
      against LocalStack covers happy path + denied-section
      classification.
    - Likely files: above.
    - Validation: integration test passes against LocalStack.
    - Done when: response includes per-section
      `{value | denied | unsupported | deferred}` discriminator.
    - Commit: `feat(inspector): add bucket inspector backend`

44. [x] Object inspector backend
    - Goal: `object_inspect` returns head + tags + acl-summary +
      restore status + version-id (read-only) + checksums; classifies
      capability per AC-5.
    - Scope: `src-tauri/src/s3/inspector.rs` (extend),
      `src-tauri/src/commands/inspector_cmd.rs` (extend); integration
      test.
    - Likely files: above.
    - Validation: integration test.
    - Done when: response shape matches the frontend's expected schema.
    - Commit: `feat(inspector): add object inspector backend`

45. [x] Frontend: read-only inspector UI with disabled-state copy
    - Goal: bucket + object inspector panels with muted disabled
      controls (`Requires <iam>`, `Deferred from v1`, `Not available
      for <storage class>`). Discoverability narrowed per round-1
      finding #25 — the inspector is reachable from selection details
      and a keyboard shortcut in this commit; the context-menu entry
      lands with task 42 and the toolbar Inspect button lands with
      task 40 (both deliberate cross-references).
    - Scope: `src/views/inspector/*`,
      `src/views/inspector/BucketInspector.tsx`,
      `src/views/inspector/ObjectInspector.tsx`. Gates rendering by
      `useValidatedProfile()` (round-1 finding #9 frontend layer).
      Tests cover each disabled-state copy text + the two
      discoverability paths owned by this commit (selection details +
      keyboard shortcut); axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: AC-5 disabled-state criteria pass and the two
      in-scope discoverability paths work.
    - Commit: `feat(inspector): add read only ui with disabled state copy`

46. [x] Diff preview / confirmation framework + storage-class change
    - Goal: backend `diff_preview_create` /
      `diff_preview_cancel` and `object_set_storage_class` requiring
      `confirmedDiffId`; frontend modal with explicit cancel that
      voids the diff. Wires v1 trigger (storage class) and is reusable
      for future high-impact edits.
    - Scope: `src-tauri/src/diff/*` (or inline in `commands/`),
      `src-tauri/src/s3/object.rs` (extend), `src/views/diff/*`;
      tests cover create, confirm, cancel, expire, double-confirm
      rejection (derived test case from review residual #1);
      assertion-level test that `objects:updated` is emitted on
      successful storage-class change (round-1 finding #14); explicit
      test that storage-class change is **not** subject to optimistic
      updates (Decision D2 boundary).
    - Likely files: above.
    - Validation: `cargo test --lib` + `pnpm test --run`.
    - Done when: a storage-class change cannot proceed without an
      unexpired `DiffId` and cancel from preview voids it.
    - Commit: `feat(diff): add preview confirmation framework storage class`

### Phase H — Preview + media server + editing (commits 47-53)

47. [x] Loopback media server with signed session-token URLs
    - Goal: `axum` server bound to `127.0.0.1:0`; `media_register` /
      `media_revoke`; range requests; expiry; rejects stale tokens per
      AC-6.
    - Scope: `src-tauri/src/media_server/{mod.rs,tokens.rs}`,
      `src-tauri/src/commands/media_cmd.rs`; integration test
      asserts range requests work and expired token returns 403.
    - Likely files: above.
    - Validation: integration test.
    - Done when: a video URL plays via `<video src="http://127.0.0.1:
      <port>/m/<token>">`.
    - Commit: `feat(media): add loopback server with signed tokens`

48. [x] Frontend: image preview + preview pane shell
    - Goal: preview pane router + image renderer for JPEG/PNG/GIF/
      WEBP/SVG/BMP; preview-size-limit warning at 50 MB default.
    - Scope: `src/views/preview/{PreviewPane.tsx,ImagePreview.tsx}`;
      tests cover MIME routing and size-limit warning; axe-core
      assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: selecting an image renders within 2 seconds against
      mocked invoke.
    - Commit: `feat(preview): add image preview and pane shell`

49. [x] Frontend: text preview (Shiki, lazy per language)
    - Goal: text/code preview with Shiki, languages loaded lazily by
      file extension; matches AC-6.
    - Scope: `src/views/preview/TextPreview.tsx`,
      `src/lib/shiki.ts`; tests assert correct grammar loaded for
      `.ts`, `.py`, and `.json`; axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: switching files swaps grammar without bundle bloat.
    - Commit: `feat(preview): add text code preview with shiki lazy load`

50. [x] Frontend: Monaco editor with ETag conflict handling
    - Goal: Monaco editor (lazy-loaded) for text files; Save uses
      `If-Match` precondition; conflict surfaces refresh/retry per
      AC-7.
    - Scope: `src/views/preview/EditorPreview.tsx`,
      `src/api/objects.ts` (extend); tests cover happy save and
      conflict path; axe-core assertion (Decision D5).
    - Likely files: above + lazy chunk in `vite.config.ts`.
    - Validation: `pnpm test --run`.
    - Done when: Monaco only loads on first edit; conflict path
      matches AC-7.
    - Commit: `feat(preview): add monaco editor with etag conflict`

51. [x] Frontend: media (video/audio) preview via media server
    - Goal: video and audio previews use `media_register` URLs; expired
      tokens trigger graceful refetch.
    - Scope: `src/views/preview/MediaPreview.tsx`,
      `src/api/media.ts`; tests cover register + revoke flow;
      axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: AC-6 video preview behaviour holds end-to-end.
    - Commit: `feat(preview): add media preview via signed urls`

52. [x] Frontend: PDF, Markdown, hex, archive previews
    - Goal: PDF.js, remark/rehype, hex viewer, ZIP/TAR/GZ list-only
      preview using HEAD + range requests.
    - Scope: `src/views/preview/{PdfPreview,MarkdownPreview,HexPreview,
      ArchivePreview}.tsx`; tests per renderer with fixtures;
      axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: each renderer passes its mocked-data test.
    - Commit: `feat(preview): add pdf markdown hex and archive previews`

53. [x] Frontend: tabular preview (CSV/JSON/NDJSON/Parquet) in worker
    - Goal: TanStack Table-based preview parsing in a Web Worker;
      Parquet via `parquet-wasm` lazy-loaded; first N rows shown.
    - Scope: `src/views/preview/TablePreview.tsx`,
      `src/workers/{csv,json,parquet}.worker.ts`; tests for first-N
      truncation and worker isolation; axe-core assertion (Decision
      D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: a 10 MB CSV preview meets AC-6.
    - Commit: `feat(preview): add tabular preview in web workers`

### Phase I — Search, bookmarks, recents, settings (commits 54-57)

54. [x] Search: current-location filter + bucket-wide prefix search
    - Goal: `search_local_filter` (cache-only) and `search_prefix`
      (paginated, cancellable, streams `search:page` events via the
      typed events helper); assertion-level test confirms event
      emission with correct `requestId` scope (round-1 finding #14).
    - Scope: `src-tauri/src/search/{mod.rs,cancel.rs}`,
      `src/views/search/*`, `src/api/search.ts`; tests cover both modes
      and cancellation; axe-core assertion (Decision D5).
    - Likely files: above + `src-tauri/src/commands/search_cmd.rs`.
    - Validation: `cargo test --lib` + `pnpm test --run`.
    - Done when: AC-10 search criteria pass against mocked + LocalStack
      backends.
    - Commit: `feat(search): add local filter and bucket prefix search`

55. [x] Bookmarks + recent locations with validation gate
    - Goal: persist bookmarks; auto-track recents per AC-10; do not
      surface entries from unvalidated profiles (uses
      `useValidatedProfile()` per round-1 finding #9 frontend layer).
    - Scope: `src-tauri/src/profiles/mod.rs` (extend with bookmark
      store) or new `src-tauri/src/bookmarks.rs`; `src/views/sidebar/
      {Bookmarks,Recents}.tsx`; tests for validation-gated rendering;
      axe-core assertion (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run`.
    - Done when: AC-10 bookmark and recents criteria pass.
    - Commit: `feat(sidebar): add bookmarks and recent locations`

56. [x] Settings screen wired end-to-end (per-panel test coverage required)
    - Goal: settings screen for download dir, transfer concurrency,
      cache TTL/size, preview limit, shortcut bindings (with conflict
      resolver from task 16), default view mode, notifications,
      fallback threshold, transfer confirmations, S3-compatible
      endpoints, auto-update, diagnostics, startup behavior, proxy.
      Per Decision D3 this commit ships all 14 panels but is gated by
      explicit per-panel test coverage in the Done-when.
    - Scope: `src/views/settings/*`, `src/store/settings.ts`,
      `src/api/settings.ts` (extend); tests for shortcut conflict
      detection, threshold validation, defaults reset, **and one named
      test per panel** (`general.test.tsx`, `transfers.test.tsx`,
      `preview.test.tsx`, `shortcuts.test.tsx`, `notifications.test.
      tsx`, `endpoints.test.tsx`, `updater.test.tsx`,
      `diagnostics.test.tsx`, `startup.test.tsx`, `proxy.test.tsx`,
      `cache.test.tsx`, `fallback.test.tsx`, `confirmations.test.tsx`,
      `defaultView.test.tsx`); axe-core assertion (Decision D5).
      **Cross-layer shortcut snapshot** (round-2 finding #1):
      `shortcuts.test.tsx` additionally asserts that loading default
      settings produces a shortcut map equal to the
      `src/commands/__fixtures__/baseline-shortcuts.proposal.json`
      fixture from task 16, ensuring the backend-persisted defaults
      and the frontend-shipped baseline never drift apart. The test
      **must import the fixture from that exact path** (e.g.
      `import baseline from "@/commands/__fixtures__/baseline-shortcuts.proposal.json"`)
      — copying the fixture inline is rejected, so a future move of
      the fixture surfaces as a compile/test failure rather than a
      silent drift (closes round-3 finding #3).
    - Likely files: above.
    - Validation: `pnpm test --run`; CI must report each panel test
      individually (no skipped panels).
    - Done when: AC-11 settings criteria pass; each of the 14 panel
      tests passes including the cross-layer shortcut snapshot (which
      imports the fixture from task 16's exact path); a roundtrip
      writes to `settings.json`.
    - Commit: `feat(settings): wire settings screen end to end`

57. [x] Theme + system menus + keyboard shortcut conflict UI
    - Goal: light/dark theme with system-default detection; native
      menus (File, Edit, View, Go, Help); shortcut conflict resolver
      surfaced when settings are saved.
    - Scope: `src/views/shell/Theme.tsx`,
      `src-tauri/src/menus.rs`, `src/views/settings/ShortcutsTab.tsx`;
      tests cover theme switching and conflict UI; axe-core assertion
      (Decision D5).
    - Likely files: above.
    - Validation: `pnpm test --run` + manual menu visual check.
    - Done when: macOS shows native menu bar; theme follows OS.
    - Commit: `feat(shell): add theme system menus and shortcut conflicts`

### Phase J — Auto-update, diagnostics, packaging (commits 58-66)

58. [x] Tauri updater integration with signed artifacts + key generation runbook
    - Goal: `updater_check` / `updater_install`; updater config in
      `tauri.conf.json` with public key; user-facing prompt UI;
      signing key generation + secret storage runbook (per round-1
      finding #20).
    - Scope:
      - `src-tauri/src/updater/mod.rs`,
        `src-tauri/src/commands/updater_cmd.rs`,
        `src/views/shell/UpdaterPrompt.tsx`.
      - `tauri.conf.json` (`updater.pubkey` populated by the generated
        public key).
      - `docs/release.md` runbook describing: `tauri signer generate`
        invocation; where the public key is committed (config); where
        the private key + password live (GitHub Actions secrets
        `TAURI_UPDATER_PRIVATE_KEY` and
        `TAURI_UPDATER_KEY_PASSWORD`); rotation procedure; recovery if
        the key is lost.
      - Tests for status mirroring; documentation lint passes.
    - Likely files: above.
    - Validation: `cargo test --lib` + manual signed-artifact rehearsal
      against the runbook.
    - Done when: AC-12 update prompts behave per defaults and the
      runbook is the single source of truth for the signing flow.
    - Commit: `feat(updater): add tauri updater with signed artifacts`

59. [x] Diagnostics: credential and path redaction with fixtures (split a)
    - Goal: focused redaction module with fuzz/regression coverage,
      independently testable before bundle export ships (per round-1
      finding #15 split a).
    - Scope:
      - `src-tauri/src/diagnostics/redact.rs` covering: AWS access key
        IDs (`AKIA...`/`ASIA...`/`AROA...`), secret access keys
        (40-char base64), session tokens, presigned URLs (full
        querystring scrub), 12-digit account IDs (configurable
        replacement policy), local filesystem paths under
        `$HOME`, bearer tokens, and the `Internal::trace_id` (kept,
        not redacted, since it's the link to log lines).
      - Test fixtures in `src-tauri/tests/fixtures/diagnostics/`
        covering each pattern with both positive and false-positive
        inputs; small `proptest` fuzzer for AWS key id format.
    - Likely files: above.
    - Validation: `cargo test --lib` and the fixture-based tests pass.
    - Done when: every pattern named in round-1 finding #15 has both
      positive and negative coverage and the redactor is reusable
      from any caller.
    - Commit: `feat(diagnostics): add credential and path redaction`

60. [x] Diagnostics: bundle collection and export (split b)
    - Goal: `diagnostics_collect` / `diagnostics_export` use the
      redactor from task 59 to produce a never-auto-uploaded bundle
      (per round-1 finding #15 split b).
    - Scope:
      - `src-tauri/src/diagnostics/{mod.rs,bundle.rs}` (zip
        composition, file inclusion list, redaction application).
      - `src-tauri/src/commands/diagnostics_cmd.rs`.
      - `src/views/settings/DiagnosticsTab.tsx` (UI for include-recent
        toggles, redaction-level select, "Export" → uses
        `tauri-plugin-dialog` save flow installed in task 5).
      - Integration test composes a real bundle from a temp log dir
        and asserts the redactor was applied to every included file.
    - Likely files: above.
    - Validation: `cargo test --lib` + `pnpm test --run`.
    - Done when: AC-12 diagnostics criteria pass and the bundle never
      contains an unredacted credential pattern from task 59's
      fixtures.
    - Commit: `feat(diagnostics): add bundle collection and export`

61. [x] Accessibility deep pass + command palette polish + screen-reader
    - Goal: deeper a11y polish on top of the per-task baseline (per
      Decision D5): command palette filter announces results; ARIA
      live regions for transfer state changes; screen-reader pass on
      macOS VoiceOver and Windows Narrator; skip-link refinements;
      keyboard-only walkthrough captures the AC-3/AC-4 flows.
    - Scope: `src/views/**` (refinements), `src/commands/registry.ts`
      (live-region announcements); per-page axe-core assertions
      already exist from earlier tasks — this commit adds the
      cross-flow keyboard-walkthrough tests.
    - Likely files: above.
    - Validation: `pnpm test --run`; manual screen-reader pass on
      macOS VoiceOver and Windows Narrator (recorded in
      `docs/a11y.md`).
    - Done when: keyboard walkthrough completes the AC-3/AC-4 flows
      without a mouse and SR users hear meaningful state changes.
    - Commit: `chore(a11y): deep pass on palette transfers and live regions`

62. [x] App icon, window chrome, splash, branding
    - Goal: final app icon set per platform, window chrome titles,
      first-run welcome.
    - Scope: `src-tauri/icons/*`, `src-tauri/tauri.conf.json`,
      `src/views/shell/FirstRun.tsx`.
    - Likely files: above.
    - Validation: `pnpm tauri build` produces a binary with the new
      icon visible in the platform's launcher.
    - Done when: icon + first-run shown on a clean install.
    - Commit: `chore(brand): add app icon window chrome and first run`

63. [x] macOS packaging + signing + notarization workflow
    - Goal: GitHub Actions release workflow for macOS universal `.dmg`
      with codesign + notarization using stored secrets; updater
      artifact signed with the key from task 58 runbook.
    - Scope: `.github/workflows/release.yml` (mac job), Apple
      certificate handling docs added to `docs/release.md` from
      task 58.
    - Likely files: above.
    - Validation: workflow run on a tag produces a signed, notarized
      `.dmg` and a Tauri updater feed entry.
    - Done when: `gh workflow run release.yml -r v0.1.0-test` succeeds
      on a throwaway tag.
    - Commit: `ci(release): add macos sign and notarize workflow`

64. [x] Windows packaging + signing workflow
    - Goal: NSIS installer + Authenticode signing in the same release
      workflow.
    - Scope: `.github/workflows/release.yml` (windows job).
    - Likely files: above.
    - Validation: workflow produces a signed `.exe` installer artifact.
    - Done when: throwaway tag produces a signed Windows artifact.
    - Commit: `ci(release): add windows nsis sign workflow`

65. [x] Linux packaging workflow (AppImage + deb)
    - Goal: AppImage + deb produced and attached to the release.
    - Scope: `.github/workflows/release.yml` (linux job).
    - Likely files: above.
    - Validation: throwaway tag produces both artifacts; `appimage`
      runs on Ubuntu LTS.
    - Done when: artifacts attach to the GitHub release.
    - Commit: `ci(release): add linux appimage and deb workflow`

66. [x] Performance harness + lab benchmark documentation
    - Goal: cargo bench for transfer throughput; Vitest perf marker
      for 10k-row scroll asserting AC-8 thresholds; documented lab
      conditions and how to reproduce.
    - Scope: `src-tauri/benches/transfers.rs`,
      `src/views/modes/__perf__/details.perf.test.ts`,
      `docs/perf.md`.
    - Likely files: above.
    - Validation: `cargo bench --bench transfers` and
      `pnpm test --run --filter perf` both produce numbers within AC-8
      budget on the documented baseline.
    - Done when: AC-8 figures reproducible from a clean checkout.
    - Commit: `chore(perf): add benches and lab benchmark docs`

### Phase K — Docs and release prep (commits 67-68)

67. [x] Architecture and ops docs
    - Goal: `docs/architecture.md` summarizing the design (incl. the
      `## Decisions` section); `docs/dev.md` for local setup incl.
      LocalStack and MinIO; `docs/security.md` explaining credential
      boundary and media-server token model; `docs/release.md`
      already exists from task 58 — extend with full tagging flow.
    - Scope: `docs/*`.
    - Likely files: above.
    - Validation: links resolve; `pnpm lint:md` (markdownlint via
      biome plugin or standalone) passes.
    - Done when: a new contributor can spin the app from clone in <10
      minutes following `docs/dev.md`.
    - Commit: `docs(arch): add architecture dev security and release docs`

68. [x] CHANGELOG entry for `0.1.0` and release-readiness checklist
    - Goal: `CHANGELOG.md` `[0.1.0]` block enumerating shipped v1
      features mapped to ACs; `docs/release-checklist.md` covering
      sign/notarize/updater feed/post-release smoke.
    - Scope: `CHANGELOG.md`, `docs/release-checklist.md`.
    - Likely files: above.
    - Validation: `pnpm lint` and markdown lint pass.
    - Done when: tagging `v0.1.0` is a mechanical follow-up.
    - Commit: `docs(release): add 0.1.0 changelog and release checklist`
