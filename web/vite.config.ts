import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  publicDir: process.env.MW_DEV_NATIVE_ASSETS || "vendor",
  build: {
    manifest: true,
    rollupOptions: {input: {desktop: "index.html", mobile: "m/index.html"}},
  },
  server: {
    proxy: {
      "/api": process.env.MARKET_WATCH_API_URL || "http://127.0.0.1:8000",
      "/readyz": process.env.MARKET_WATCH_API_URL || "http://127.0.0.1:8000",
      "/mcp": {
        target: process.env.MARKET_WATCH_API_URL || "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
});
