const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const context = vm.createContext({});
vm.runInContext(
  fs.readFileSync("../advanced-host/chart-style.js", "utf8"),
  context,
);
const original = {
  charts: [
    {
      version: 3,
      chartProperties: {
        paneProperties: { background: "#123456" },
        scalesProperties: { textColor: "#fff" },
        tradingProperties: { showOrders: true },
      },
      panes: [
        {
          sources: [
            {
              type: "MainSeries",
              state: {
                symbol: "XAUUSD",
                interval: "240",
                timeframe: "3M",
                sessionId: "regular",
                currencyId: "USD",
                style: 1,
                candleStyle: { upColor: "#ff0000" },
              },
            },
            { type: "Study", state: { length: 21 } },
            { type: "LineToolHorzLine", state: { price: 4300 } },
          ],
        },
      ],
    },
  ],
};
const style = context.chartStyleTemplate(original, 0);
assert.deepEqual(JSON.parse(JSON.stringify(style)), {
  version: 3,
  chartProperties: {
    paneProperties: { background: "#123456" },
    scalesProperties: { textColor: "#fff" },
  },
  mainSourceProperties: { style: 1, candleStyle: { upColor: "#ff0000" } },
});
style.chartProperties.paneProperties.background = "#ffffff";
assert.equal(
  original.charts[0].chartProperties.paneProperties.background,
  "#123456",
);
assert.throws(() => context.chartStyleTemplate(original, 1), /尚未就绪/);
console.log(
  "style extraction: presentation whitelist, no workspace objects, detached copy passed",
);

for (const gridStyle of ["dotted", "solid"]) {
  const template = context.chartStyleTemplate(original, 0, gridStyle);
  assert.equal(template._mwGridStyle, gridStyle);
  assert.equal(template.mainSourceProperties.symbol, undefined);
}
assert.equal(context.chartStyleTemplate(original, 0, "invalid")._mwGridStyle, undefined);
(async () => {
  const draws = [], events = new Map(), writes = [];
  const widget = {
    getTheme: () => "Dark",
    applyOverrides: value => draws.push(value),
    subscribe: (event, callback) => events.set(event, callback),
  };
  const grid = context.chartGridPresentation(widget,
    [{kind:"setting", name:"mw.gridStyle", content:{value:"solid"}}],
    async value => writes.push(value), false, "dotted");
  assert.equal(grid.value, "dotted", "layout overrides global preference");
  assert.equal(draws.at(-1)["paneProperties.vertGridProperties.style"], 4);
  grid.preview("solid");
  assert.equal(draws.at(-1)["paneProperties.vertGridProperties.style"], 0);
  assert.equal(grid.value, "dotted", "preview cannot leak into layout/autosave");
  assert.equal(writes.length, 0);
  grid.preview();
  assert.equal(draws.at(-1)["paneProperties.vertGridProperties.style"], 4);
  await grid.select("solid");
  assert.deepEqual(writes, ["solid"]);
  grid.restore("dotted");
  events.get("chart_loaded")();
  assert.equal(grid.value, "dotted");
  assert.equal(draws.at(-1)["paneProperties.vertGridProperties.style"], 4);
  const readonly = context.chartGridPresentation(widget, [], async () => {throw Error("readonly write");}, true);
  readonly.preview("solid");
  await readonly.select("solid");
  assert.equal(readonly.value, "dotted");
  assert.equal(draws.at(-1)["paneProperties.vertGridProperties.style"], 4);
  console.log("grid metadata, sparse style, preview cancellation, layout precedence, readonly passed");
})().catch(error=>{console.error(error);process.exitCode=1;});
