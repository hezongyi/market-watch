import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] || "dist/notification-center-preview");
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/notifications/preview/entry.tsx"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: resolve(output, "system-messages.js"),
});
await copyFile(
  "notification-center-preview.html",
  resolve(output, "index.html"),
);
await copyFile(
  "../advanced-host/native-notification-surface.js",
  resolve(output, "native-notification-surface.js"),
);
