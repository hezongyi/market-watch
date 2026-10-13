const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { transformSync } = require("esbuild");

const source = fs.readFileSync(path.join(__dirname, "../src/market-data/LiveProviderStatus.tsx"), "utf8");
const session = source.slice(source.indexOf("function Session("), source.indexOf("function overview("));
assert(session.includes("function Session("));
const code = transformSync(session, { loader: "tsx", format: "cjs", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }).code;
const Session = new Function("React", `${code}; return Session;`)(React);
for (const [market_session, calendar_verified, expected] of [
  ["scheduled_open", true, "已核实交易时段"],
  ["scheduled_open", false, "时段尚未核实"],
  ["unknown", false, "时段尚未核实"],
  ["closed", true, "闭市"],
]) {
  const html = renderToStaticMarkup(React.createElement(Session, { row: { market_session, calendar_verified, next_session_at: null } }));
  assert(html.includes(expected), `${market_session}/${calendar_verified}: ${html}`);
}
const alertSource = fs.readFileSync(path.join(__dirname, "../src/advanced/chartAlerts.ts"), "utf8");
const labels = alertSource.slice(alertSource.indexOf("export const healthNames:"), alertSource.indexOf("export const relations:"));
const compiled = transformSync(labels, { loader: "ts", format: "cjs" }).code;
const moduleObject = { exports: {} };
new Function("module", "exports", compiled)(moduleObject, moduleObject.exports);
assert.equal(moduleObject.exports.healthNames.coverage_pending, "判定依赖待核实");
assert.notEqual(moduleObject.exports.healthNames.coverage_pending, moduleObject.exports.healthNames.stale);
console.log("PASS: verified session, closed/unknown states and separate coverage status.");
