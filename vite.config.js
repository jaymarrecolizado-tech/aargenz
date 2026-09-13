import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// Copies the gitignored root config.js (API keys / local-model settings) into
// dist/ during build so the production bundle served by server.js can still
// load it via the plain <script src="./config.js"> tag in index.html.
const copyConfig = () => ({
  name: "copy-config-js",
  closeBundle() {
    const src = path.resolve(__dirname, "config.js");
    const dest = path.resolve(__dirname, "dist/config.js");
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
});

export default defineConfig({
  plugins: [react(), copyConfig()],
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to the Node proxy (server.js) during development.
      "/api": "http://localhost:3000"
    }
  },
  build: {
    outDir: "dist"
  },
  test: {
    environment: "node",
    // server/ is included so server-side logic (the review state machine, for
    // one) can be unit-tested directly instead of only through the API.
    include: ["src/**/*.test.{js,jsx}", "server/**/*.test.js"]
  }
});
