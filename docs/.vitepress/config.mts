import { defineConfig } from "vitepress";

// ---------------------------------------------------------------------------
// VitePress config for the brows3r documentation site.
//
// The site is published to GitHub Pages by .github/workflows/docs.yml on every
// push to `main`. Local preview: `pnpm docs:dev`.
//
// Two of the three top-level "API reference" links point at static folders
// (`/api/ts/`, `/api/rust/`) populated at build time by the docs workflow:
//   - TypeDoc generates the JS/TS API docs from JSDoc/TSDoc comments.
//   - rustdoc generates the Tauri-side Rust API docs.
// During local `docs:dev` these subtrees may not exist yet — that's fine,
// VitePress will just 404 those links.
// ---------------------------------------------------------------------------

export default defineConfig({
  title: "brows3r",
  description:
    "A native S3 file browser for engineers — multi-profile, keyboard-first, with rich preview.",
  cleanUrls: true,

  // GitHub Pages serves from /<repo>/, so the production base must match the
  // repo slug. Local dev uses "/".
  base: process.env.DOCS_BASE ?? "/",

  head: [
    ["link", { rel: "icon", href: "/brows3r-icon.png", type: "image/png" }],
    [
      "meta",
      {
        name: "og:image",
        content: "/brows3r-banner.png",
      },
    ],
  ],

  // ----- Theme ------------------------------------------------------------
  themeConfig: {
    logo: "/brows3r-icon.png",

    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/architecture" },
      { text: "Contributing", link: "/contributing/" },
      {
        text: "API",
        items: [
          { text: "TypeScript / JS", link: "/api/ts/" },
          { text: "Rust (Tauri)", link: "/api/rust/brows3r_lib/" },
        ],
      },
      { text: "Releases", link: "https://github.com/banduk/brows3r/releases" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Get started",
          items: [
            { text: "What is brows3r?", link: "/guide/getting-started" },
            { text: "Install", link: "/guide/install" },
            { text: "First profile", link: "/guide/first-profile" },
            { text: "Keyboard shortcuts", link: "/guide/keyboard" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "View modes", link: "/guide/view-modes" },
            { text: "Preview", link: "/guide/preview" },
            { text: "Bulk operations", link: "/guide/operations" },
            { text: "Bookmarks & recents", link: "/guide/bookmarks" },
            { text: "Inspector", link: "/guide/inspector" },
            { text: "Multipart cleanup", link: "/guide/multipart" },
          ],
        },
      ],

      "/concepts/": [
        {
          text: "Architecture",
          items: [
            { text: "Overview", link: "/concepts/architecture" },
            { text: "Credential boundary", link: "/concepts/credentials" },
            { text: "Cache & SWR", link: "/concepts/cache" },
            { text: "Media loopback server", link: "/concepts/media-server" },
            { text: "Capability cache", link: "/concepts/capabilities" },
            { text: "Performance budgets", link: "/concepts/performance" },
            { text: "Accessibility", link: "/concepts/accessibility" },
          ],
        },
      ],

      "/contributing/": [
        {
          text: "Contributing",
          items: [
            { text: "How to contribute", link: "/contributing/" },
            { text: "Dev environment", link: "/contributing/dev" },
            { text: "Writing documentation", link: "/contributing/documentation" },
            { text: "Release process", link: "/contributing/release" },
            { text: "Security", link: "/contributing/security" },
            { text: "Release checklist", link: "/contributing/checklist" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/banduk/brows3r" },
    ],

    footer: {
      message:
        'Released under the <a href="https://github.com/banduk/brows3r/blob/main/LICENSE">MIT License</a>.',
      copyright: "Copyright © 2026 brows3r contributors",
    },

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/banduk/brows3r/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    outline: {
      level: [2, 3],
    },
  },

  // ----- Build ------------------------------------------------------------
  outDir: "../dist-docs",
  // Don't fail the build when a markdown link points at an API folder that
  // only exists in CI (typedoc/rustdoc output).
  ignoreDeadLinks: [
    /^\/api\/ts\//,
    /^\/api\/rust\//,
    /^\.\.\/\.crafter\//,
  ],
});
