// The shipped datafeed/RPC boundary, with deterministic supplier completions.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const messages = [],
  handlers = {};
let symbol = "MWP:YAHOO:abc",
  resolution = "1D",
  calls = 0;
const cache = {};
const chart = {
  symbol: () => symbol,
  resolution: () => resolution,
  _chartWidget: {model:()=>({model:()=>({mainSeries:()=>({seriesSource:()=>({_gateway:{_getChartApi:()=>({_studyEngine:{_resolveRequests:cache}})},stop(){},start:()=>calls++})})})})},
};
const ctx = vm.createContext({
  document: { createElement: () => ({}), head: { append: () => {} } },
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage: (m) => messages.push(m) },
  crypto: { randomUUID: () => String(messages.length) },
  addEventListener: (name, fn) => (handlers[name] ??= []).push(fn),
  setTimeout,
  clearTimeout,
  chart,
});
for (const file of ["series.js", "composite-display-batches.js", "chart-runtime.js"])
  vm.runInContext(require("./fixtures/direct-runtime.cjs").read("../advanced-host/" + file, "utf8"), ctx);
vm.runInContext(
  `widget={chartsCount:()=>1,chart:()=>chart};ready=true;workspaceEpoch=1;globalThis.resolved=[];globalThis.errors=[];`,
  ctx,
);
const run = (code) => vm.runInContext(code, ctx),
  last = () => messages.filter((m) => m.type === "market").at(-1);
const reply = async (data) => {
  const sent = last();
  assert.ok(sent);
  for (const fn of handlers.message)
    await fn({
      source: ctx.parent,
      origin: "http://localhost",
      data: { channel: "mw-chart-v1", type: "result", id: sent.id, ...data },
    });
};
const state = () =>
  messages.filter((m) => m.type === "chart-resolve-states").at(-1);
const start = () =>
  run(
    `globalThis.flight=feed.resolveSymbol(chart.symbol(),i=>resolved.push(i),e=>errors.push(e))`,
  );
const meta = {
  source: "yahoo",
  name: "Apple",
  symbol: "AAPL",
  precision: 2,
  frames: ["M1", "H1", "D1"],
  calendar: "ny17",
  basis: "adjusted",
};
(async () => {
  try {
    start();
    assert.equal(state().states[0].state, "loading");
    await reply({
      error: "行情来源暂不可用，请重试",
      errorDetails: { status: 503, code: "request_failed", retryable: true },
    });
    await ctx.flight;
    assert.equal(state().states[0].code, "request_failed");
    assert.equal(ctx.resolved.length, 0);
    const failure = state().states[0];
    const rejected = Promise.reject(new Error("supplier unavailable"));
    rejected.catch(() => {});
    cache[symbol] = rejected;
    cache[symbol + "_#_USD"] = Promise.resolve(meta);
    cache["MWP:YAHOO:other"] = rejected;
    for (const fn of handlers.message)
      await fn({
        source: ctx.parent,
        origin: "http://localhost",
        data: {
          channel: "mw-chart-v1",
          type: "retry-chart-resolve",
          epoch: 1,
          ...failure,
        },
      });
    assert.equal(calls, 1, "explicit retry targets the failed chart");
    assert.equal(Object.hasOwn(cache, symbol), false, "failed target is evicted");
    assert.ok(cache[symbol + "_#_USD"], "successful metadata remains cached");
    assert.equal(cache["MWP:YAHOO:other"], rejected, "other symbols remain untouched");
    start();
    await reply({ result: meta });
    await ctx.flight;
    assert.equal(ctx.resolved.length, 1);
    assert.equal(
      state().states.length,
      0,
      "recovery clears only its chart notice",
    );
    start();
    symbol = "MWP:YAHOO:new";
    await reply({ result: meta });
    await ctx.flight;
    assert.equal(
      ctx.resolved.length,
      1,
      "old metadata cannot complete a new chart target",
    );
    assert.equal(run(`alertSourceMetadata.has('MWP:YAHOO:new')`), false);
    start();
    resolution = "60";
    await reply({ result: meta });
    await ctx.flight;
    assert.equal(
      ctx.resolved.length,
      1,
      "period change fences the old response",
    );
    start();
    await reply({
      error: "行情来源限流",
      errorDetails: {
        status: 503,
        code: "rate_limited",
        retryable: true,
        retryAfter: 60,
      },
    });
    await ctx.flight;
    assert.ok(state().states[0].retryAt > Date.now() + 59000);
    const limited = state().states[0];
    for (const fn of handlers.message)
      await fn({
        source: ctx.parent,
        origin: "http://localhost",
        data: {
          channel: "mw-chart-v1",
          type: "retry-chart-resolve",
          epoch: 1,
          ...limited,
        },
      });
    assert.equal(calls, 1, "explicit retry cannot bypass source cooldown");
    start();
    run("workspaceEpoch++");
    await reply({ result: meta });
    await ctx.flight;
    assert.equal(ctx.resolved.length, 1);
    // Two native chart consumers may resolve the same identity concurrently.
    const first = run(
      `feed.resolveSymbol(chart.symbol(),i=>resolved.push(i),e=>errors.push(e))`,
    );
    const firstMessage = last();
    const second = run(
      `feed.resolveSymbol(chart.symbol(),i=>resolved.push(i),e=>errors.push(e))`,
    );
    const secondMessage = last();
    for (const sent of [firstMessage, secondMessage])
      for (const fn of handlers.message)
        await fn({
          source: ctx.parent,
          origin: "http://localhost",
          data: {
            channel: "mw-chart-v1",
            type: "result",
            id: sent.id,
            result: meta,
          },
        });
    await Promise.all([first, second]);
    assert.equal(
      ctx.resolved.length,
      3,
      "parallel native consumers retain both valid callbacks",
    );
    start();
    await reply({error:"来源暂不可用",errorDetails:{status:503,code:"request_failed",retryable:true}});
    await ctx.flight;
    const staleFailure = state().states[0];
    let rejectStale;
    cache[symbol] = new Promise((_, reject) => { rejectStale = reject; });
    const retries = handlers.message.map(fn=>fn({source:ctx.parent,origin:"http://localhost",data:{channel:"mw-chart-v1",type:"retry-chart-resolve",epoch:run("workspaceEpoch"),...staleFailure}}));
    symbol = "MWP:YAHOO:changed-during-retry";
    rejectStale(new Error("late rejection"));
    await Promise.all(retries);
    assert.equal(calls, 1, "target change while awaiting cache cannot restart another chart identity");
    assert.ok(cache[staleFailure.symbol], "stale retry cannot mutate the cache");
    start();
    run("resolveDisposed=true");
    await reply({ result: meta });
    await ctx.flight;
    assert.equal(ctx.resolved.length, 3, "disposal fences late metadata");
    console.log(
      "Resolve failures, recovery, per-chart lifetime and cooldown PASS",
    );
  } finally {
    for (const entry of run("[...pending.values()]")) {
      clearTimeout(entry.timer);
      clearTimeout(entry.cancellationTimer);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
