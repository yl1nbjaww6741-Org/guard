import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cloudflare Pages target - static build, no server-side rendering.
// Deploy: `npm run build && wrangler pages deploy dist --project-name contentguard-central`
// (see web/README.md).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});
