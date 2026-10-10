import { build } from "esbuild";
await build({
  entryPoints: ["src/market-data/native-entry.tsx"], bundle: true,
  outfile: "dist/data-center-native.js", format: "iife", platform: "browser",
  target: "es2022", minify: true, define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
});
