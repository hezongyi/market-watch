const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
const source = ts.transpileModule(
  fs.readFileSync("src/advanced/nativeHistoryLoads.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function loader(api) {
  const exports = {};
  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      Object.assign(this, { status, code });
    }
  }
  vm.runInNewContext(source, {
    exports,
    require: () => ({ api, ApiError }),
    Date,
    crypto: require("node:crypto").webcrypto,
    DOMException,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });
  return exports.loadNativeHistory;
}
(async () => {
  const progress = [],
    cap = { task_seconds: 600 },
    body = { instrument: "EURUSD", timeframe: "M5" };
  let calls = 0;
  const hot = loader(async () => {
    calls++;
    return { result: { bars: [1, 2] } };
  });
  const result = await hot(body, new AbortController().signal, cap, (p) =>
    progress.push(p),
  );
  assert.equal(result.bars.length, 2);
  assert.equal(calls, 1);
  assert.deepEqual(
    progress.map((p) => p.phase),
    ["checking", "delivering"],
    "hot cache uses real loading phases too",
  );
  assert.equal(
    progress.at(-1).received,
    2,
    "notice stays available until native application finishes",
  );
  const paths = [],
    coldProgress = [];
  const replies = [
    { load: { id: "task", state: "waiting", pages: 0 } },
    { state: "filling", pages: 1 },
    { state: "ready", pages: 3 },
    { result: { bars: [1, 2, 3] } },
    {},
  ];
  const cold = loader(async (path) => {
    paths.push(path);
    return replies.shift();
  });
  await cold(body, new AbortController().signal, cap, (p) =>
    coldProgress.push(p),
  );
  assert.deepEqual(
    coldProgress.map((p) => p.phase),
    ["checking", "waiting", "filling", "delivering", "delivering"],
  );
  assert.equal(coldProgress.at(-1).pages, 3);
  assert.equal(coldProgress.at(-1).estimatedPages, 3);
  assert.equal(coldProgress.at(-1).received, 3);
  assert.ok(paths.at(-1).endsWith("/cancel"));
  const estimated = [];
  const estimates = loader(async (path) => path.endsWith("/cancel") ? {} :
    {load:{id:"estimate",state:"waiting",pages:4}});
  const estimatedController = new AbortController();
  await assert.rejects(estimates({countBack:12000,history_page_bars:1000},
    estimatedController.signal,cap,p => {
      estimated.push(p); if(p.phase === "filling") estimatedController.abort();
    }), {name:"AbortError"});
  assert.equal(estimated.at(-1).estimatedPages,12,
    "estimate uses this provider's page capacity rather than a fixed denominator");
  const exceededController = new AbortController();
  let adjusted;
  await assert.rejects(estimates({countBack:12000,history_page_bars:4000},
    exceededController.signal,cap,p => {
      if(p.phase === "filling") { adjusted=p.estimatedPages; exceededController.abort(); }
    }), {name:"AbortError"});
  assert.equal(adjusted,5,"unfinished reads expand an estimate exceeded by real committed pages");
  const cancelPaths = [],
    cancelProgress = [],
    controller = new AbortController();
  const cancel = loader(async (path) => {
    cancelPaths.push(path);
    return { load: { id: "cancel", state: "waiting", pages: 0 } };
  });
  await assert.rejects(
    cancel(body, controller.signal, cap, (p) => {
      cancelProgress.push(p);
      if (p.phase === "waiting") controller.abort();
    }),
    { name: "AbortError" },
  );
  assert.equal(
    cancelProgress.some((p) => p.phase === "delivering"),
    false,
    "cancel cannot claim delivery",
  );
  assert.ok(cancelPaths.at(-1).endsWith("/cancel"));
  const failed = loader(async (path) =>
    path.endsWith("/cancel")
      ? {}
      : {
          load: {
            id: "bad",
            state: "failed",
            error: { code: "HISTORY_PROVIDER_FAILED", message: "failed" },
          },
        },
  );
  await assert.rejects(
    failed(body, new AbortController().signal, cap, () => {}),
    (e) => e.code === "HISTORY_PROVIDER_FAILED",
  );
  console.log(
    "History loading: hot/cold truthful phases, real pages, cancellation and failure passed",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
