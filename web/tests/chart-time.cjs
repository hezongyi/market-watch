const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const fs = require("node:fs");
const code = buildSync({
  entryPoints: ["src/time/chartTime.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Time",
}).outputFiles[0].text;
const context = vm.createContext({ Intl, Date });
vm.runInContext(code, context);
const t = context.Time,
  stamp = Date.parse("2026-10-18T23:30:12.123Z");
assert.equal(t.dayKey(stamp, "UTC"), "2026-10-18");
assert.equal(t.dayKey(stamp, "Asia/Shanghai"), "2026-10-19");
assert.equal(t.clockTime(stamp, "Asia/Shanghai"), "07:30:12");
assert.equal(t.clockTime(stamp, "America/New_York"), "19:30:12");
for (const zone of [
  "UTC",
  "Asia/Shanghai",
  "America/New_York",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
]) {
  const input = t.dateTimeInput(stamp, zone);
  assert(
    t.wallTimeCandidates(input, zone).includes(stamp),
    `${zone}: millisecond round trip`,
  );
  assert.equal(
    t.dayKey(Date.parse("2026-01-01T00:00:00Z"), "UTC"),
    "2026-01-01",
  );
}
assert.equal(t.clockTime(0, "UTC"), "00:00:00");
assert.equal(
  t.formatAlertMessage(
    "发生时间 2026-10-18T23:30:12.123000+00:00 / 检测延迟 0.4s",
    stamp,
    "Asia/Shanghai",
  ),
  "发生时间 2026-10-19 07:30:12 UTC+8 / 检测延迟 0.4s",
);
assert.equal(t.formatTimestamp(0, "UTC"), "1970-01-01 00:00:00 UTC+0");
assert.equal(
  t.wallTimeCandidates("2026-03-08T02:30", "America/New_York").length,
  0,
);
const fold = Array.from(
  t.wallTimeCandidates("2026-11-01T01:30", "America/New_York"),
);
assert.deepEqual(fold, [
  Date.parse("2026-11-01T05:30:00Z"),
  Date.parse("2026-11-01T06:30:00Z"),
]);
assert.match(t.formatTimestamp(fold[0], "America/New_York"), /UTC-4/);
assert.match(t.formatTimestamp(fold[1], "America/New_York"), /UTC-5/);
for (const [day, hours] of [
  ["2026-03-08", 23],
  ["2026-11-01", 25],
]) {
  const b = t.dayBounds(day, "America/New_York");
  assert.equal(b.until - b.since, hours * 3600000);
  assert.equal(t.dayKey(b.since, "America/New_York"), day);
  assert.equal(t.clockTime(b.since, "America/New_York"), "00:00:00");
}
assert.equal(t.wallTimeCandidates("2026-02-30T12:00", "UTC").length, 0);
assert.equal(t.wallTimeCandidates("2026-01-01T24:00", "UTC").length, 0);
assert.equal(t.validTimeZone("exchange"), null);
assert.equal(t.validTimeZone("not/a-zone"), null);
assert.equal(t.offsetLabel(stamp, "Asia/Kolkata"), "UTC+5:30");
assert.equal(t.offsetLabel(stamp, "Asia/Kathmandu"), "UTC+5:45");
assert.equal(t.offsetLabel(stamp, "America/St_Johns"), "UTC-2:30");
// Exercise the real bridge publisher and rebind/dispose functions against chart subscriptions.
const source = fs.readFileSync("../advanced-host/bridge.js", "utf8");
const functions = source.slice(
  source.indexOf("function publishNotificationTimezone("),
  source.indexOf("function marketQuery("),
);
function chart(zone, symbol) {
  const listeners = new Set(),
    symbols = new Set();
  return {
    zone,
    symbol: () => symbol,
    getTimezoneApi() {
      return {
        getTimezone: () => ({ id: this.zone }),
        onTimezoneChanged: () => ({
          subscribe: (_, f) => listeners.add(f),
          unsubscribe: (_, f) => listeners.delete(f),
        }),
      };
    },
    onSymbolChanged: () => ({
      subscribe: (_, f) => symbols.add(f),
      unsubscribe: (_, f) => symbols.delete(f),
    }),
    listeners,
    symbols,
  };
}
const a = chart("UTC", "a"),
  b = chart("America/New_York", "b");
let active = a,
  cb;
const history = [];
const bridge = vm.createContext({
  ready: false,
  loading: true,
  send: () => {},
  alertUISession: "test-session",
  alertUIWorkspace: "test-workspace",
  widget: {
    chartsCount: () => 2,
    chart: (i) => [a, b][i],
    activeChart: () => active,
    subscribe: (_, f) => {
      cb = f;
    },
    unsubscribe: () => {
      cb = null;
    },
  },
  MWChartTime: { set: (...args) => history.push(args) },
  quoteSubscriptions: new Map(),
  quoteSnapshotRows: new Map(),
  presentationFor: () => ({ timezone: "Asia/Shanghai" }),
});
vm.runInContext(
  functions +
    "\nthis.bind=bindTimezoneEvents;this.active=bindActiveChartEvent;this.refresh=refreshNotificationTimezone;this.unbind=unbindActiveChartEvent",
  bridge,
);
bridge.refresh();
assert.deepEqual(history.at(-1), ["UTC", "UTC（图表初始化前）"]);
bridge.ready = true;
bridge.loading = false;
bridge.bind();
bridge.active();
assert.equal(history.at(-1)[0], "UTC");
active = b;
cb();
assert.equal(history.at(-1)[0], "America/New_York");
b.zone = "exchange";
for (const f of b.listeners) f();
assert.deepEqual(history.at(-1), ["Asia/Shanghai", "交易所 · Asia/Shanghai"]);
bridge.bind();
assert.equal(a.listeners.size, 1);
assert.equal(a.symbols.size, 1);
bridge.unbind();
assert.equal(cb, null);
console.log(
  "chart time: UTC storage, three zones, midnight, DST gap/fold, 23/25h dates, ms round trips and active chart subscriptions passed; browser TZ=" +
    Intl.DateTimeFormat().resolvedOptions().timeZone,
);
