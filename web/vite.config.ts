/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// SharedArrayBuffer (the engine's state read by the interface) needs cross-origin
// isolation. Cloudflare Pages sends the same headers from public/_headers.
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [solid()],
  server: { headers, port: 5173 },
  preview: { headers },
  worker: { format: "es" },
  build: { target: "es2022" },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
