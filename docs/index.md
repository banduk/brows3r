---
layout: home

hero:
  name: "brows3r"
  text: "A native S3 file browser for engineers"
  tagline: Multi-profile · keyboard-first · rich preview · local-first.
  image:
    src: /brows3r-icon.png
    alt: brows3r icon
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/banduk/brows3r

features:
  - icon: 🪪
    title: Multi-profile, never leaks
    details: AWS credentials, S3-compatible endpoints (MinIO, R2, Wasabi, B2). Credentials live in the OS keychain; the WebView never sees them. Profiles validate lazily, auto-retry on auth errors, with opt-in periodic refresh.
  - icon: ⌨️
    title: Keyboard-first
    details: Cmd+K palette, Cmd+F search, Cmd+I inspector, Cmd+L breadcrumb-edit, Cmd+Shift+A/N Activity & Notifications Centers, back/forward history. Seven view modes, all navigable from the keyboard.
  - icon: 🖼️
    title: Rich preview
    details: Images, video, audio, PDF, Markdown, HTML, archives, CSV/JSON/Parquet tables. Plus a Monaco editor for in-place text edits.
  - icon: 📥
    title: Activity & Notifications Centers
    details: Full-pane download manager with filter tabs, fuzzy search, batch grouping, and "Open folder" actions. A sister Notifications Center collects errors, warnings, and info — no toast spam.
  - icon: 🌐
    title: Six languages
    details: UI shipped in English, Português, Español, Français, Deutsch, and 简体中文. Auto-detects the OS locale; switch any time from Settings → General.
  - icon: 🔐
    title: Auditable boundary
    details: Per-request signed loopback URLs for media. No bytes cross the IPC boundary. Inspector, multipart cleanup scanner, and capability cache included.
---

<style>
.VPHero .image-bg {
  background: radial-gradient(circle, rgba(36, 200, 219, 0.25) 0%, rgba(36, 200, 219, 0) 70%);
}
</style>

## At a glance

```sh
# 1. Clone, install, run.
git clone https://github.com/banduk/brows3r
cd brows3r
pnpm install
pnpm tauri dev
```

brows3r is a Tauri 2.x desktop app (macOS / Linux / Windows). The frontend is
React 19 + Vite + TypeScript with shadcn/ui and Tailwind v4. The backend is
Rust, using the official AWS SDK for S3. Everything that touches credentials
or S3 bytes runs server-side; the WebView only sees opaque listings, signed
loopback URLs, and progress events.

See [Get started](/guide/getting-started) for the full tour.

## Architecture in one diagram

```
┌──────────────── Tauri process ────────────────┐
│  WebView (React 19 + Vite + TS)               │
│   - Zustand UI state                          │
│   - TanStack Query (short-lived render cache) │
│   - Monaco · Shiki · PDF.js (all lazy)        │
│        │  invoke / listen                     │
│        ▼                                      │
│  Rust core                                    │
│   - profile_manager   - cache (SWR)           │
│   - s3_client_pool    - transfer_queue        │
│   - capability_cache  - resource_locks        │
│   - keychain          - settings              │
│   - media_server (loopback, signed tokens)    │
│        │                                      │
│        ▼                                      │
│  aws-sdk-s3 (per-profile, per-region clients) │
└────────────────────────────────────────────────┘
                       │
                       ▼
         AWS S3 / MinIO / R2 / Wasabi / …
```

Three load-bearing constraints drive every decision:

1. **AWS credentials never cross the IPC boundary** — the WebView only sees
   opaque request IDs and signed loopback URLs.
2. **Rust is the authoritative cache** — TanStack Query is a short-lived
   render adapter, never the source of truth.
3. **Capability gaps feel intentional** — unsupported S3 operations are
   classified once, cached, and surfaced as disabled controls. No red banners.

Read more in [Concepts → Architecture](/concepts/architecture).
