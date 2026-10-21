// Opt-in live/native regression. Uses a fresh context and protects saved user state.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const target = process.env.MW_CHART_TEST_URL;
const loginFile = process.env.MW_CHART_LOGIN_FILE;
if (!target || !loginFile) throw Error('Set MW_CHART_TEST_URL and MW_CHART_LOGIN_FILE');
const password = JSON.parse(fs.readFileSync(loginFile, 'utf8')).password;
const base = new URL(target).origin;
const workspaceId = new URL(target).pathname.split('/').at(-1);
const output = process.env.MW_CHART_TEST_OUTPUT || '/tmp/mw-multi-chart-restore';
const expectedCharts = Number(process.env.MW_CHART_EXPECTED_COUNT || 5);
const candidateOrigin = process.env.MW_CHART_CANDIDATE_ORIGIN;
const configuredChartOrigin = process.env.MW_CHART_TEST_ORIGIN;
if (candidateOrigin && !configuredChartOrigin) throw Error('Set MW_CHART_TEST_ORIGIN for candidate routing');
fs.mkdirSync(output, { recursive:true });

(async () => {
  const browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({ ignoreHTTPSErrors:true, viewport:{width:1440,height:1000} });
  const page = await context.newPage();
  const report = { target, at:new Date().toISOString(), candidateOrigin, errors:[], samples:[], protectedWrites:[] };
  page.on('pageerror', error => report.errors.push({message:error.message, stack:error.stack}));
  if (candidateOrigin) {
    await context.route(configuredChartOrigin+'/**', async route => {
      const url = new URL(route.request().url());
      const response = await context.request.get(candidateOrigin + url.pathname + url.search);
      await route.fulfill({response});
    });
  }
  await context.route('**/api/advanced-charts/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (['GET','HEAD','OPTIONS'].includes(request.method()) || pathname.endsWith('/preferences/migrate'))
      return route.continue();
    report.protectedWrites.push({path:pathname, method:request.method()});
    if (pathname.endsWith('/preferences/save')) {
      const body = request.postDataJSON();
      // Acknowledge only inside this disposable context; no synthetic failure
      // is reported to the user's notification center and no preference is saved.
      return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({
        ...body, id:'inspection-only', revision:body.revision+1, updated_at:Date.now(),
      })});
    }
    // Workspace/alert mutations are never part of this restore check.
    return route.fulfill({status:409, contentType:'application/json', body:'{"detail":"Inspection protects saved state"}'});
  });
  await context.route('**/api/chart-alerts/**', async route => {
    if (['GET','HEAD','OPTIONS'].includes(route.request().method())) return route.continue();
    throw Error('Unexpected chart alert mutation during restore');
  });
  const workspacePath = base + '/api/advanced-charts/workspaces/' + encodeURIComponent(workspaceId);
  try {
    await page.goto(target, {waitUntil:'domcontentloaded'});
    await page.getByLabel('管理员密码').fill(password);
    const login = page.waitForResponse(response => response.url() === base+'/api/login');
    await page.locator('button.auth-submit').click();
    assert.equal((await login).status(), 200);
    const beforeResponse = await context.request.get(workspacePath);
    assert.equal(beforeResponse.status(), 200);
    const before = await beforeResponse.json();
    const frameElement = page.locator('iframe[title="专业图表工作区"]');
    await frameElement.waitFor({timeout:15000});
    const chartOrigin = new URL(await frameElement.getAttribute('src')).origin;
    if (candidateOrigin) assert.equal(chartOrigin, configuredChartOrigin);
    // Reload also exercises the candidate from its first document request.
    for (let pass=0; pass<2; pass++) {
      await page.reload({waitUntil:'domcontentloaded'});
      await frameElement.waitFor({timeout:15000});
      const host = await (await frameElement.elementHandle()).contentFrame();
      assert.ok(host, 'chart host frame exists');
      await host.waitForFunction(count => typeof ready !== 'undefined' && ready && !loading &&
        typeof widget !== 'undefined' && widget.chartsCount() === count &&
        Array.from({length:count}, (_,index) => widget.chart(index).dataReady()).every(Boolean),
      expectedCharts, {timeout:45000});
      const charts = await host.evaluate(() => Array.from({length:widget.chartsCount()}, (_,index) => ({
        index, symbol:widget.chart(index).symbol(), resolution:widget.chart(index).resolution(),
        dataReady:widget.chart(index).dataReady(),
      })));
      const native = host.childFrames()[0];
      assert.ok(native, 'native chart document exists');
      assert.ok(await native.locator('canvas').count() >= expectedCharts, 'native chart canvases exist');
      report.samples.push({pass, charts});
      await page.screenshot({path:path.join(output,'restore-'+pass+'.png'),fullPage:true});
    }
    const after = await (await context.request.get(workspacePath)).json();
    assert.deepEqual(after, before, 'restore leaves the saved workspace unchanged');
    report.workspaceUnchanged = true;
    report.revision = after.revision;
    assert.equal(report.errors.length, 0, 'native startup has no uncaught page exception');
    report.passed = true;
  } catch(error) {
    report.failure = {message:error.message,stack:error.stack};
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode=1; });
