import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // The first test in each `describe` block pays the cold-start cost of
    // jsdom plus the entire dependency graph (Monaco, Radix, TanStack…).
    // On the Windows GitHub Actions runner this regularly tips past Vitest's
    // 5-second default — we observed 6.6s on a single `ObjectInspector`
    // test that completes in <80ms after warm-up. Bump to 15s so cold-start
    // never trips the timeout; warm tests still finish in tens of ms.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        // Split heavy or async-loadable deps into their own chunks so the
        // initial bundle stays small. Each chunk is loaded only when the
        // matching feature renders (React.lazy + dynamic import).
        //
        // OCP: adding a new heavy dep = one new branch.
        manualChunks(id) {
          if (id.includes("monaco-editor") || id.includes("@monaco-editor")) {
            return "monaco";
          }
          // Shiki: only the core, NOT the per-language grammars (those must
          // stay in their own chunks for lazy-per-language loading per task 49).
          if (id.includes("shiki/dist/core") || id.includes("shiki/core")) {
            return "shiki-core";
          }
          if (id.includes("react-pdf") || id.includes("pdfjs-dist")) {
            return "pdf";
          }
          if (id.includes("parquet-wasm") || id.includes("apache-arrow")) {
            return "parquet";
          }
          if (id.includes("@radix-ui")) {
            return "radix";
          }
          if (
            id.includes("react-markdown") ||
            id.includes("remark") ||
            id.includes("rehype")
          ) {
            return "markdown";
          }
          if (
            id.includes("@tanstack/react-query") ||
            id.includes("@tanstack/react-table") ||
            id.includes("@tanstack/react-virtual")
          ) {
            return "tanstack";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/")
          ) {
            return "react";
          }
        },
      },
    },
  },

  // Workers must use ES module format so they are compatible with the
  // code-splitting (manualChunks) build above.
  worker: {
    format: "es",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
