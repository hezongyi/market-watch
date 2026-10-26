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

const overviewSource = source.slice(source.indexOf('function observationReady('), source.indexOf('/** Stored reads only.'));
const overviewCode = transformSync(overviewSource, {loader: 'tsx', format: 'cjs'}).code;
const overview = new Function('errors', `${overviewCode}; return overview;`)({timeout: '后台记录请求超时'});
const provider = {configured: true, error: null, authentication_hold: false};
const ready = {market_session: 'unknown', quote_ready: true, candle_ready: true};
const sampled = {...ready, quote_ready: false, sample_ready: true, observation_mode: 'candle_close_sample'};
assert.equal(overview(provider, [ready]), '实时报价与完成 K 线已就绪');
assert.equal(overview(provider, [sampled]), '实时采样与完成 K 线已就绪');
assert.equal(overview(provider, [ready, sampled]), '实时采样与完成 K 线已就绪');
for (const row of [{...sampled, sample_ready: false}, {...sampled, candle_ready: false}, {...ready, quote_ready: false}])
  assert.match(overview(provider, [row]), /尚未就绪/);
assert.equal(overview({...provider, error: 'timeout'}, [sampled]), '后台记录请求超时');
assert.equal(overview({...provider, authentication_hold: true}, [sampled]), '鉴权暂停');
console.log('PASS: REST sample readiness is separate from stream quote readiness.');
