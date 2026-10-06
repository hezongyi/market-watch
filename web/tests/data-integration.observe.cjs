// Real Chromium SSE observation on the Ubuntu isolated acceptance instance.
// Output contains timings and states, never cookies, prices or account IDs.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const root = path.resolve(__dirname, "../..");
  const base = "http://127.0.0.1:16589";
  const minutes = Number(process.env.MW_OBSERVE_MINUTES || 2880);
  const phase = process.env.MW_OBSERVE_PHASE || "sustained";
  if (!["sustained", "tool-validation"].includes(phase)) throw Error("Invalid observation phase");
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 4320)
    throw Error("Observation must be 1–4320 minutes");
  const directory = path.join(root, "artifacts/data-integration");
  const output = path.join(directory, `browser-${phase}.jsonl`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const credential = JSON.parse(fs.readFileSync(path.join(directory, "login.json")));
  const login = await context.request.post(base + "/api/login", { data: credential });
  if (!login.ok()) throw Error("Isolated observation login failed");
  const page = await context.newPage();
  const start = Date.now();
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  const append = (row) => fs.appendFileSync(output, JSON.stringify(row) + "\n", { mode: 0o600 });
  append({ event: "started", at: start, phase, planned_minutes: minutes, host: "Ubuntu local Chromium",
    url: base + "/market-data", receiver_browser_same_host_clock: true,
    clock_scope: "same host; source clock offset remains unverified" });
  try {
    await page.goto(base + "/market-data");
    await page.evaluate((start) => {
      const empty = () => ({ snapshots: 0, heartbeats: 0, errors: 0, opened: 0, symbols: {} });
      window.marketObservation = empty();
      window.marketObservationEmpty = empty;
      const last = {};
      let stream;
      let received = Date.now();
      const snapshot = (event) => {
        received = Date.now();
        const at = Date.now();
        const stats = window.marketObservation;
        stats.snapshots += 1;
        for (const row of JSON.parse(event.data)) {
          const symbol = row.logical_symbol;
          const item = stats.symbols[symbol] ||= {
            quality_counts: {}, unique_quotes: 0, negative_delays: 0,
            missing_quote_snapshots: 0,
            receive_to_browser_ms: {}, source_to_browser_ms: {}, epoch_changes: 0,
          };
          item.quality_counts[row.quality] = (item.quality_counts[row.quality] || 0) + 1;
          const quote = row.quote;
          if (!quote || !Number.isFinite(quote.received_at) || !Number.isFinite(quote.source_time)) {
            item.missing_quote_snapshots += 1;
            continue;
          }
          if (quote.received_at < start) continue;
          const key = `${quote.connection_epoch}:${quote.sequence}:${quote.source_time}`;
          if (last[symbol]?.key === key) continue;
          if (last[symbol] && last[symbol].epoch !== quote.connection_epoch) item.epoch_changes += 1;
          last[symbol] = { key, epoch: quote.connection_epoch };
          item.unique_quotes += 1;
          for (const [field, delay] of [
            ["receive_to_browser_ms", at - quote.received_at],
            ["source_to_browser_ms", at - quote.source_time],
          ]) {
            if (delay < 0) item.negative_delays += 1;
            const bucket = Math.floor(delay / 10) * 10;
            item[field][bucket] = (item[field][bucket] || 0) + 1;
          }
        }
      };
      const connect = () => {
        stream?.close();
        received = Date.now();
        stream = new EventSource("/api/market-data/live/events");
        stream.onopen = () => { window.marketObservation.opened += 1; };
        stream.onerror = () => { window.marketObservation.errors += 1; };
        stream.addEventListener("heartbeat", () => {
          received = Date.now();
          window.marketObservation.heartbeats += 1;
        });
        stream.addEventListener("snapshot", snapshot);
        window.marketObservationStream = stream;
      };
      connect();
      window.marketObservationWatchdog = setInterval(() => {
        if (Date.now() - received > 15000 && navigator.onLine) connect();
      }, 1000);
    }, start);
    while (!stopped && Date.now() - start < minutes * 60000) {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      const block = await page.evaluate(() => {
        const current = window.marketObservation;
        window.marketObservation = window.marketObservationEmpty();
        return current;
      });
      append({ event: "block", at: Date.now(), phase, ...block });
    }
    append({ event: "finished", at: Date.now(), interrupted: stopped });
  } catch (error) {
    // Avoid serializing Playwright network details or login credentials.
    append({ event: "failed", at: Date.now(), error_type: error.name });
    throw Error("Browser observation failed; see sanitized observation record");
  } finally {
    await browser.close();
  }
})();
