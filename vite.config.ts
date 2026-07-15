import { defineConfig } from "vite";
import { version } from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // App version (single source: package.json) baked in at build time — shown
  // in the empty-state footer. Tests don't go through this config; they pass
  // `version` into mountEmptyState explicitly.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  // Two independent HTML entries: the main viewport and the Settings window
  // (§8.3). settings.html bundles ONLY src/native/settings-form.ts — never
  // the viewport/store/engine modules — so it structurally cannot leak
  // secret-handling code into the main bundle or vice versa (D9/D10).
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
      },
    },
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
