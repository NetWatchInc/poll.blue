import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import tailwindcss from "@tailwindcss/vite";

// Static site served by the Deno backend (behind nginx) in production.
// In dev, proxy backend routes to the running Deno server (deno task dev, :8000)
// so the same-origin API/OAuth flow works without CORS.
// Use 127.0.0.1 (not "localhost"): Node resolves localhost to ::1 first, but the
// Deno server binds IPv4 — targeting the IP avoids ECONNREFUSED/AggregateError.
const BACKEND = "http://127.0.0.1:8000";

export default defineConfig({
  integrations: [preact()],
  output: "static",
  // Bind dev to 127.0.0.1: atproto's loopback OAuth requires the IP (not the
  // "localhost" hostname), and the session store is per-origin. Open the app at
  // http://127.0.0.1:4321.
  server: { host: "127.0.0.1", port: 4321 },
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        "/api": BACKEND,
        "/xrpc": BACKEND,
        "/.well-known": BACKEND,
        "/status": BACKEND,
      },
    },
  },
});
