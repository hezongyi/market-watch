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
