// Run after real UI login in your own Playwriter session:
// playwriter -s ID --timeout 60000 -f web/tests/native-toolbar-startup.playwriter.cjs
// state.page is the logged-in workspace. Optional state.toolbarTestOutput directory.
// Protects workspace/preferences/alerts; market reads still use the real backend.
const assert = require('assert').strict;
const fs = require('node:fs');
const page = state.page;
const target = new URL(page.url());
assert(/\/advanced-charts\/[^/]+$/.test(target.pathname), 'Start in a saved workspace');
const workspaceId = target.pathname.split('/').at(-1);
const workspacePath = '/api/advanced-charts/workspaces/' + encodeURIComponent(workspaceId);
const readWorkspace = () => page.evaluate(async path => {
  const response = await fetch(path);
  if (!response.ok) throw Error('Workspace read failed: ' + response.status);
  return response.json();
}, workspacePath);
const before = await readWorkspace();
const report = {cases: [], consoleErrors: [], pageErrors: [], protectedWrites: []};
const onConsole = message => {
  if (message.type() === 'error') report.consoleErrors.push(message.text());
};
const onError = error => report.pageErrors.push(error.message);
page.on('console', onConsole);
page.on('pageerror', onError);
const protect = async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || path.endsWith('/preferences/migrate'))
    return route.continue();
  report.protectedWrites.push({path, method: request.method()});
  const body = request.postDataJSON();
  if (path.endsWith('/preferences/save')) return route.fulfill({json: {
    ...body, id: 'inspection-only', revision: body.revision + 1, updated_at: Date.now(),
  }});
  if (path.endsWith('/workspaces/' + workspaceId + '/save')) return route.fulfill({json: {
    ...before, ...body, revision: body.revision + 1,
  }});
  if (path.endsWith('/native-charts/save')) return route.fulfill({json: {
    id: workspaceId, revision: body.revision + 1,
  }});
  return route.fulfill({status: 409, json: {detail: 'Inspection protects saved state'}});
};
await page.route('**/api/advanced-charts/**', protect);
const protectAlerts = async route => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
  throw Error('Unexpected alert mutation during toolbar regression');
};
await page.route('**/api/chart-alerts/**', protectAlerts);
const expectedCharts = state.toolbarExpectedCharts || 5;
async function verify(name, url) {
  if (url) await page.goto(url, {waitUntil: 'domcontentloaded'});
  else await page.reload({waitUntil: 'domcontentloaded'});
  const native = page.locator('iframe').contentFrame();
  await native.getByRole('button', {name: '商品代码搜索', exact: true}).waitFor({timeout: 20000});
  await native.getByRole('region', {name: '图表 #' + expectedCharts, exact: true}).waitFor({timeout: 15000});
  // Allow React's caught mount exceptions to be delivered to console.error.
  await new Promise(resolve => setTimeout(resolve, 1000));
  const count = await native.getByRole('region', {name: /^图表 #\d+$/}).count();
  assert.equal(count, expectedCharts);
  assert.equal(report.consoleErrors.filter(text => /Value is null/.test(text)).length, 0,
    name + ': caught React console errors are failures too');
  assert.deepEqual(report.pageErrors, []);
  report.cases.push({name, chartCount: count});
  console.log(name + ': PASS');
  console.log(await getLatestLogs({page, sinceLastCall: true}));
}
try {
  await verify('generic entry auto-restore 1', target.origin + '/advanced-charts');
  await verify('generic entry auto-restore 2', target.origin + '/advanced-charts');
  await verify('saved workspace direct link', target.href);
  await verify('saved workspace reload');
  const native = page.locator('iframe').contentFrame();
  // Switch same-symbol charts, where a symbol-change event alone cannot rebind.
  for (const index of [2, 5, 1]) {
    await native.getByRole('region', {name: '图表 #' + index, exact: true})
      .click({position: {x: 100, y: 80}, timeout: 5000});
  }
  assert.equal(report.consoleErrors.filter(text => /Value is null/.test(text)).length, 0);
  await page.goto(target.origin + '/settings/notifications', {waitUntil: 'domcontentloaded'});
  await page.locator('iframe').waitFor({state: 'detached', timeout: 15000});
  await verify('leave chart and re-enter', target.href);
  assert.deepEqual(await readWorkspace(), before, 'Saved workspace remains unchanged');
  report.workspaceUnchanged = true;
  report.passed = true;
} finally {
  page.off('console', onConsole);
  page.off('pageerror', onError);
  await page.unroute('**/api/advanced-charts/**', protect);
  await page.unroute('**/api/chart-alerts/**', protectAlerts);
  if (state.toolbarTestOutput) {
    fs.mkdirSync(state.toolbarTestOutput, {recursive: true});
    fs.writeFileSync(state.toolbarTestOutput + '/startup.json', JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({passed:report.passed || false, cases:report.cases,
    consoleErrorCount:report.consoleErrors.length, pageErrorCount:report.pageErrors.length,
    workspaceUnchanged:report.workspaceUnchanged}));
}
