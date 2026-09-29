// Rebuild pinned upstream sources plus the published calendar guard without network access.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { build } from "esbuild";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "market-watch-vendor-"));
const repos = JSON.parse(
  fs.readFileSync(path.join(web, "vendor/line-tools-sources.json")),
);
try {
  execFileSync("tar", [
    "-xzf",
    path.join(web, "vendor/line-tools-source.tar.gz"),
    "-C",
    temp,
  ]);
  fs.symlinkSync(
    path.join(web, "node_modules"),
    path.join(temp, "node_modules"),
    "dir",
  );
  const sources = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) sources.push(p);
    }
  }
  for (const r of repos)
    walk(
      path.join(
        temp,
        r.repo.replace("lightweight-charts-line-tools-", ""),
        "src",
      ),
    );
  const out = path.join(temp, "compiled");
  const program = ts.createProgram(sources, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    declaration: false,
    noEmitOnError: false,
    rootDir: temp,
    outDir: out,
    baseUrl: temp,
    paths: { "lightweight-charts-line-tools-core": ["core/src/index.ts"] },
  });
  // Upstream has historical type errors against v5. Full program emit is needed
  // to distinguish type-only reexports; transpileModule/esbuild alone cannot do so.
  const result = program.emit();
  if (result.emitSkipped) throw new Error("Upstream TypeScript emit failed");
  // Market Watch calendar guard (MPL-2.0 modification): never infer time
  // outside the explicit server-supplied grid from the last few candles.
  const geometryPath = path.join(out, "core/src/utils/geometry.js");
  let geometry = fs.readFileSync(geometryPath, "utf8");
  const probe = "if (!firstBar || !lastBar)\n        return null;";
  const occurrenceCount = geometry.split(probe).length - 1;
  if (occurrenceCount !== 2) throw new Error("Upstream geometry changed; review calendar guard");
  let occurrence = 0;
  geometry = geometry.replaceAll(probe, () => {
    occurrence++;
    return probe + (occurrence === 1
      ? "\n    const upper = chart.timeScale().coordinateToLogical(chart.timeScale().timeToCoordinate(lastBar.time));\n    if (logicalIndex < 0 || logicalIndex > upper) return null;"
      : "\n    if (targetTimeNum < Number(firstBar.time) || targetTimeNum > Number(lastBar.time)) return null;");
  });
  fs.writeFileSync(geometryPath, geometry);
  const exports = [
    ["core", "createLineToolsPlugin"],
    ["lines", "registerLinesPlugin"],
    ["rectangle", "LineToolRectangle"],
    ["fib-retracement", "registerFibRetracementPlugin"],
    ["text", "registerTextPlugin"],
    ["parallel-channel", "registerParallelChannelPlugin"],
    ["long-short-position", "registerLongShortPositionPlugin"],
  ];
  const entry = path.join(out, "entry.js");
  fs.writeFileSync(
    entry,
    exports
      .map(
        ([dir, symbol]) => `export {${symbol}} from './${dir}/src/index.js';`,
      )
      .join("\n") + "\nexport { interpolateTimeFromLogicalIndex, interpolateLogicalIndexFromTime } from './core/src/utils/geometry.js';",
  );
  const output = path.join(web, "src/charts/vendor/line-tools.js");
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    minify: true,
    external: ["lightweight-charts"],
    alias: {
      "lightweight-charts-line-tools-core": path.join(out, "core/src/index.js"),
    },
    outfile: output,
    logLevel: "warning",
  });
  console.log(
    "line-tools.js sha256:",
    createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
