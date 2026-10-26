// Isolated browser fault injection; no server data is changed.
const assert = require('node:assert');
const fs = require('node:fs');
const native = state.page.frames().find(f => f.url().startsWith('blob:https://chart-test.kookvv.com:8443/'));
const dialog = native.getByRole('dialog', {name: '商品代码搜索', exact: true});
const pattern = '**/api/market-data/series/page?*';
const fixture = route => route.fulfill({status: 500, contentType: 'application/json',
  body: JSON.stringify({detail: 'isolated acceptance: temporary symbol search failure'})});
const errors = [];
const onError = error => errors.push(String(error));
const report = {passed: false, synthetic_browser_fault: 'HTTP 500 only on this test page', checks: []};
state.page.on('pageerror', onError);
try {
  if (await dialog.isVisible()) await dialog.getByRole('button', {name: '关闭商品代码搜索'}).click();
  await state.page.route(pattern, fixture);
  await native.getByRole('button', {name: '商品代码搜索', exact: true}).click();
  await dialog.getByRole('button', {name: '重试搜索', exact: true}).waitFor({state: 'visible', timeout: 10000});
  await dialog.getByRole('progressbar').waitFor({state: 'hidden', timeout: 3000});
  assert.match(await dialog.getByRole('alert').innerText(), /商品搜索失败/);
  report.checks.push('HTTP 500 ends loading and exposes an explicit retry');
  report.failureUI = await dialog.ariaSnapshot();
  await state.page.unroute(pattern, fixture);
  const response = state.page.waitForResponse(r => new URL(r.url()).pathname === '/api/market-data/series/page' && r.status() === 200);
  await dialog.getByRole('button', {name: '重试搜索', exact: true}).click();
  await response;
  await dialog.getByRole('progressbar').waitFor({state: 'hidden', timeout: 15000});
  await dialog.locator('[data-symbol-name]').first().waitFor({state: 'visible', timeout: 10000});
  assert.equal(await dialog.getByRole('button', {name: '重试搜索', exact: true}).count(), 0);
  assert.deepEqual(errors, []);
  report.checks.push('Retry uses the actual endpoint and restores selectable native rows');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await state.page.unroute(pattern, fixture);
  state.page.off('pageerror', onError);
  report.errors = errors;
  report.dialog = await dialog.ariaSnapshot();
  report.logs = await getLatestLogs({page: state.page, sinceLastCall: true});
  fs.writeFileSync(state.searchCheck.reportDir + '/search-error-regression.json', JSON.stringify(report, null, 2));
  console.log({passed: report.passed, checks: report.checks});
}
