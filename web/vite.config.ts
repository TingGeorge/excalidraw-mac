import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Everything is bundled into dist/ and served by the Mac app from its own
// excalidraw:// URL scheme, so the app never needs the network.
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    target: "safari16",
    chunkSizeWarningLimit: 8000,
    assetsInlineLimit: 0,
  },
});
