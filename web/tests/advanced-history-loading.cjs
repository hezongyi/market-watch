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
function loader(api, clock = Date) {
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
    Date: clock,
    crypto: require("node:crypto").webcrypto,
    DOMException,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });
  return Object.assign(exports.loadNativeHistory, {diagnostics:exports.historyLoadDiagnostics});
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
  assert.equal(result.history_pages,0,"hot-cache delivery must not count an upstream cache page");
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
  const coldResult = await cold(body, new AbortController().signal, cap, (p) =>
    coldProgress.push(p),
  );
  assert.deepEqual(
    coldProgress.map((p) => p.phase),
    ["checking", "waiting", "filling", "delivering", "delivering"],
  );
  assert.equal(coldProgress.at(-1).pages, 3);
  assert.equal(coldResult.history_pages,3,"committed task pages survive delivery into the native batch result");
  assert.equal(coldProgress.at(-1).estimatedPages, 3);
  assert.equal(coldProgress.at(-1).received, 3);
  assert.ok(paths.at(-1).endsWith("/cancel"));

  const resultPaths = [], resultProgress = [];
  const resultReplies = [
    { load: { id: "combined", state: "waiting", pages: 0 } },
    { load: { id: "combined", state: "filling", pages: 1 } },
    { load: { id: "combined", state: "ready", pages: 3 }, result: { bars: [1, 2, 3] } },
  ];
  const combined = loader(async path => {
    resultPaths.push(path);
    if (path.endsWith("/cancel")) return {};
    assert.ok(path === "/charts/history-loads" || path.endsWith("/result"),
      "capable servers deliver readiness and data in the same result poll");
    return resultReplies.shift();
  });
  const combinedResult = await combined(body, new AbortController().signal,
    {...cap, result_polling: true}, p => resultProgress.push(p));
  assert.equal(combinedResult.bars.length, 3);
  assert.equal(combinedResult.history_pages, 3,
    "the final result poll owns the actual page count, rather than the previous incomplete poll");
  assert.equal(resultProgress.at(-1).pages, 3);
  assert.equal(resultProgress.at(-1).estimatedPages, 3);
  assert.equal(resultPaths.length, 4, "no separate ready-status round trip precedes the final result");

  const resumedProgress = [];
  const resumedReplies = [
    { load: { id: "resumed", state: "waiting", pages: 0 } },
    { load: { id: "resumed", state: "filling", pages: 1 } },
    { load: { id: "resumed", state: "waiting", pages: 1 } },
    { load: { id: "resumed", state: "ready", pages: 2 }, result: { bars: [1] } },
  ];
  const resumed = loader(async path => path.endsWith("/cancel") ? {} : resumedReplies.shift());
  const resumedResult = await resumed(body, new AbortController().signal,
    {...cap, result_polling: true}, p => resumedProgress.push(p));
  assert.equal(resumedResult.history_pages, 2);
  assert.deepEqual(resumedProgress.map(p => p.phase), ["checking", "waiting", "filling", "filling", "delivering"],
    "cache invalidation can return to waiting without delivering an incomplete result");

  let failedPollCleaned = false;
  const failedPoll = loader(async path => {
    if (path.endsWith("/cancel")) { failedPollCleaned = true; return {}; }
    return {load:{id:"failed-poll",state:path.endsWith("/result") ? "failed" : "waiting",
      error:{code:"HISTORY_PROVIDER_FAILED",message:"failed"}}};
  });
  await assert.rejects(failedPoll(body, new AbortController().signal,
    {...cap, result_polling:true}, () => {}), error => error.code === "HISTORY_PROVIDER_FAILED");
  assert.equal(failedPollCleaned, true, "an error returned by a result poll still releases its handle");
  const pollingAbort = new AbortController();
  let abortedPollCleaned = false;
  const abortPoll = loader(async path => {
    if (path.endsWith("/cancel")) { abortedPollCleaned = true; return {}; }
    if (path.endsWith("/result")) { pollingAbort.abort(); throw new DOMException("cancelled", "AbortError"); }
    return {load:{id:"aborted-poll",state:"waiting"}};
  });
  await assert.rejects(abortPoll(body, pollingAbort.signal,
    {...cap, result_polling:true}, () => {}), {name:"AbortError"});
  assert.equal(abortedPollCleaned, true, "aborting an in-flight result poll cannot leak a handle");
  let finishCleanup, cleanupStarted;
  const cleanupPending = new Promise(resolve => { finishCleanup = resolve; });
  const cleanupEntered = new Promise(resolve => { cleanupStarted = resolve; });
  const immediate = loader(async path => {
    if (path.endsWith("/cancel")) {
      cleanupStarted();
      await cleanupPending;
      return {};
    }
    return path.endsWith("/result")
      ? {result:{bars:["available"]}}
      : {load:{id:"cleanup-pending",state:"ready",pages:1}};
  });
  let delivered = false;
  const immediateResult = immediate(body, new AbortController().signal, cap, () => {})
    .then(value => { delivered = true; return value; });
  await cleanupEntered;
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(delivered, true,
      "available price data must be delivered while successful handle cleanup is pending");
  } finally {
    finishCleanup();
    await immediateResult;
  }

  const deferredCleanups = [];
  let submitted = 0;
  const bounded = loader(async path => {
    if (path.endsWith("/cancel")) {
      await new Promise(resolve => deferredCleanups.push(resolve));
      return {};
    }
    if (path.endsWith("/result")) return {result:{bars:[1]}};
    return {load:{id:`bounded-${++submitted}`,state:"ready",pages:1}};
  });
  for (let index = 0; index < 4; index++)
    await bounded(body, new AbortController().signal, cap, () => {});
  const queuedAbort = new AbortController();
  const queued = bounded(body, queuedAbort.signal, cap, () => {});
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(submitted, 4,
      "returning successful prices cannot admit unlimited handles before cleanup finishes");
    queuedAbort.abort();
    await assert.rejects(queued, {name:"AbortError"});
    assert.equal(submitted, 4, "a cancelled admission must never submit a server task");
  } finally {
    queuedAbort.abort();
    for (const finish of deferredCleanups) finish();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bounded.diagnostics().admitted, 0, "all lifecycle slots return after cleanup");
  assert.equal(bounded.diagnostics().cleaning, 0);
  assert.equal(bounded.diagnostics().queued, 0);

  let now = Date.now(), expirySubmissions = 0;
  const expiryCleanups = [];
  const expiresWhileQueued = loader(async path => {
    if(path.endsWith('/cancel')) return new Promise(resolve=>expiryCleanups.push(resolve));
    if(path.endsWith('/result')) return {result:{bars:[1]}};
    return {load:{id:`expiry-${++expirySubmissions}`,state:'ready',pages:1}};
  }, {now:()=>now});
  for(let index=0;index<4;index++)
    await expiresWhileQueued(body,new AbortController().signal,cap,()=>{});
  const expiredQueued = assert.rejects(expiresWhileQueued(body,new AbortController().signal,
    {task_seconds:1},()=>{}),error=>error.code==='HISTORY_TIMEOUT');
  // Advance the clock without running the timer, as happens when completion
  // microtasks run after a busy event loop. Admission must check the deadline.
  now += 2000;
  expiryCleanups[0]();
  await expiredQueued;
  assert.equal(expirySubmissions,4,'a passed deadline cannot be admitted before its timeout callback runs');
  for(const finish of expiryCleanups) finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(expiresWhileQueued.diagnostics().admitted,0);
  const cleanupFailure = loader(async path => {
    if (path.endsWith("/cancel")) throw new TypeError("cleanup transport unavailable");
    return path.endsWith("/result") ? {result:{bars:[1]}} :
      {load:{id:"cleanup-failure",state:"ready",pages:1}};
  });
  assert.equal((await cleanupFailure(body, new AbortController().signal, cap, () => {})).bars.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupFailure.diagnostics().cleanupFailures, 1,
    "cleanup transport failures stay observable without hiding delivered prices");
  assert.equal(cleanupFailure.diagnostics().admitted, 0);
  await assert.rejects(cleanupFailure(body, new AbortController().signal, {task_seconds:0}, () => {}),
    error => error.code === "HISTORY_TIMEOUT");
  assert.equal(cleanupFailure.diagnostics().admitted, 0, "expired admissions cannot leak capacity");
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
