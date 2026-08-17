import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const CORE_ORIGIN = "http://127.0.0.1:43117";

/**
 * Core rejects mutating requests whose `Origin` is not its own, so in dev the proxy
 * rewrites `Origin` to the core origin. Without this every POST/PATCH/DELETE from
 * `vite dev` would be refused, while the production build (served by core itself)
 * is unaffected.
 */
const forwardToCore = {
  target: CORE_ORIGIN,
  changeOrigin: true,
  configure: (proxy: {
    on: (event: "proxyReq", handler: (req: { setHeader: (n: string, v: string) => void }) => void) => void;
  }) => {
    proxy.on("proxyReq", (proxyReq) => {
      proxyReq.setHeader("origin", CORE_ORIGIN);
    });
  },
};

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    // Loopback only, like core itself — the dev server must never be reachable from the LAN.
    host: "127.0.0.1",
    port: 43118,
    strictPort: false,
    proxy: {
      "/api": forwardToCore,
      "/session": forwardToCore,
    },
  },
});
