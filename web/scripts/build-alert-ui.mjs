import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] || "../advanced-host");
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/advanced/nativeAlertUI.tsx"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: resolve(output, "alert-ui.js"),
});
