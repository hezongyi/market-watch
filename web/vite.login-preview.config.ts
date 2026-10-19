import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate build: the preview cannot replace or route to the formal login.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: { rollupOptions: { input: "login-particles.html" } },
});
