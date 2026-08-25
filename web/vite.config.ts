import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the SAME Worker as the existing dashboard
// (panel.lukep009.download/central/) via Workers static assets - see
// worker/wrangler.toml's [assets] binding - not a separate Cloudflare
// Pages project. Deliberate choice over web/README.md's original plan:
// a separate origin needs real CORS + SameSite cookie changes on the
// Worker to authenticate at all (a connector change), same-origin needs
// none. outDir nests under "central" (not flat into dist/) so
// wrangler's assets directory (../web/dist, the parent) serves this
// app's files at exactly /central/* alongside the existing dashboard's
// own routes, with nothing to collide.
export default defineConfig({
  base: "/central/",
  plugins: [react()],
  build: {
    outDir: "dist/central",
  },
});
