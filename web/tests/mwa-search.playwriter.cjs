// Playwriter deployment regression. state.page must be a signed-in mwa page.
// Set state.searchCheck = {reportDir, query} before execution.
const assert = require('node:assert');
const fs = require('node:fs');
const cfg = state.searchCheck;
assert(cfg?.reportDir);
const native = state.page.frames().find(f => f.url().startsWith('blob:https://chart-test.kookvv.com:8443/'));
assert(native, 'Native chart must have loaded');
let responses = [];
const onResponse = response => {
  if (new URL(response.url()).pathname === '/api/market-data/series/page')
    responses.push({url: response.url(), status: response.status()});
};
state.page.on('response', onResponse);
const report = {passed: false, query: cfg.query || 'EURUSD', observed_at_utc: new Date().toISOString()};
try {
  const dialog = native.getByRole('dialog', {name: '商品代码搜索', exact: true});
  if (await dialog.isVisible()) await dialog.getByRole('button', {name: '关闭商品代码搜索'}).click();
  const resultResponse = state.page.waitForResponse(response => new URL(response.url()).pathname === '/api/market-data/series/page' &&
    new URL(response.url()).searchParams.get('query') === report.query, {timeout: 15000});
  await native.getByRole('button', {name: '商品代码搜索', exact: true}).click();
  await dialog.waitFor({state: 'visible', timeout: 10000});
  const search = dialog.getByRole('searchbox', {name: '搜索', exact: true});
  if (await search.inputValue() !== report.query) await search.fill(report.query);
  await resultResponse;
  assert(responses.some(response => response.status === 200), 'Native symbol search request must return 200');
  await dialog.getByRole('progressbar').waitFor({state: 'hidden', timeout: 10000});
  assert(await dialog.getByText(report.query, {exact: true}).count() > 0, 'A matching search result must be visible');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  report.responses = responses;
  report.dialog = await native.getByRole('dialog', {name: '商品代码搜索', exact: true}).ariaSnapshot();
  report.logs = await getLatestLogs({page: state.page, sinceLastCall: true});
  fs.mkdirSync(cfg.reportDir, {recursive: true});
  fs.writeFileSync(cfg.reportDir + '/search-regression.json', JSON.stringify(report, null, 2));
  await state.page.screenshot({path: cfg.reportDir + '/search.png', scale: 'css'});
  state.page.off('response', onResponse);
  console.log({passed: report.passed, responses});
}
