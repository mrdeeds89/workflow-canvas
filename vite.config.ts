import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The canvas UI lives in web/ and builds to dist/web, which the Node service
// serves alongside the API. No dev-server proxy: build, then run the service.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
});
