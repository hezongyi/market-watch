// S1: actual licensed engine, synthetic feed, all network requests intercepted.
// This stage proves public API behavior only; it is not Docker/business acceptance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {chromium} = require('@playwright/test');
const {hash, canonical, requirePreviewConfig} = require('./mobile-workspace-fixture.cjs');
const root = path.resolve(__dirname, '../..');
const stage = process.argv.find(arg => arg.startsWith('--stage='))?.split('=')[1];
assert.ok(!stage || ['projection', 'inspect', 'recovery', 'desktop'].includes(stage), 'Unsupported acceptance stage');
const product = !stage || ['recovery', 'desktop'].includes(stage);
const config = product ? requirePreviewConfig() : null;
const library = process.env.MW_MOBILE_LIBRARY_DIR;
if (!product) {
  assert.ok(library && path.isAbsolute(library), 'Explicit MW_MOBILE_LIBRARY_DIR is required');
  assert.ok(fs.existsSync(path.join(library, 'charting_library.js')), 'Licensed library entry is missing');
}
const output = product ? path.join(config.artifacts, stage ? `mobile-workspace.${stage}.json` : 'mobile-workspace.browser.json') : process.env.MW_MOBILE_OUTPUT;
if (!product) assert.ok(output && path.isAbsolute(output), 'Explicit absolute MW_MOBILE_OUTPUT is required');
const origin = 'https://mw-mobile-projection.invalid';
const report = {stage: stage || 'product', environment: product ? `configured product instance: ${config.task}` : 'Ubuntu routed licensed-engine fixture; synthetic data; no API/DB/provider',
  cases: [], errors: [], externalRequestsBlocked: 0, requests: {workspaceWrites: [], preferenceWrites: [], dataCenterReads: [], apiGets: [], blockedForbiddenCalls: []}};
(async () => {
  let browser;
  try {
    browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox']});
    const context = await browser.newContext({viewport: product && stage !== 'desktop' ? {width: 390, height: 844} : {width: 1200, height: 900},
      hasTouch: product && stage !== 'desktop', isMobile: product && stage !== 'desktop', ignoreHTTPSErrors: product});
    if (product) await context.grantPermissions(['local-network-access'], {origin: config.base.origin});
    const page = await context.newPage();
    if (product) await page.route(/\/api\/advanced-charts\/(?:workspaces|native-charts|preferences)(?:\/|$)/, route => {
      if (stage === 'desktop' && new URL(route.request().url()).pathname === '/api/advanced-charts/preferences/migrate')
        return route.fulfill({json:{migrated:0}});
      return route.request().method() === 'GET' ? route.continue() : route.abort('blockedbyclient');
    });
    if (product) await page.route(/\/api\/(?:market-data\/(?:live\/demand|history-catalog\/refresh|center\/datasets)|chart-alerts(?:\/00000000-0000-4000-8000-000000000000\/lifecycle)?)$/, route => {
      if (route.request().method() === 'GET') return route.continue();
      report.requests.blockedForbiddenCalls.push(new URL(route.request().url()).pathname);
      return route.abort('blockedbyclient');
    });
    if (stage === 'recovery') await page.addInitScript(appOrigin => {
      if (location.origin !== appOrigin) return;
      const prefix = 'mw-preference-draft:v1:admin:mobile-test:';
      for (const [kind, name] of [['setting','mw.watchlists.v1'], ['chart','desktop-template']]) {
        const key = JSON.stringify([kind,name,'']);
        localStorage.setItem(prefix + encodeURIComponent(key), JSON.stringify({key,kind,name,tool:'',
          version:'mobile-recovery-fixture',operation:'save',value:{lists:[]},failed:true,at:1}));
      }
    }, config.base.origin);
    page.on('pageerror', error => report.errors.push(error.message));
    if (product) {
      page.on('request', request => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.startsWith('/api/') && !report.requests.apiGets.includes(url.pathname)) report.requests.apiGets.push(url.pathname);
        if (/^\/api\/advanced-charts\/(?:workspaces|native-charts)(\/|$)/.test(url.pathname) && request.method() !== 'GET')
          report.requests.workspaceWrites.push({method: request.method(), path: url.pathname});
        if (/^\/api\/advanced-charts\/preferences/.test(url.pathname) && request.method() !== 'GET' &&
            !(stage === 'desktop' && url.pathname.endsWith('/migrate')))
          report.requests.preferenceWrites.push({method: request.method(), path: url.pathname});
        if (url.pathname.startsWith('/api/market-data/') && request.method() === 'GET' &&
            !report.requests.dataCenterReads.includes(url.pathname)) report.requests.dataCenterReads.push(url.pathname);
      });
      const credential = config.secret.login_password;
      await page.goto(config.base.origin + '/advanced-charts', {waitUntil: 'domcontentloaded'});
      const password = page.getByLabel('管理员密码');
      const chartFrame = page.locator('iframe[title="专业图表工作区"]');
      await Promise.race([
        password.waitFor({state: 'visible', timeout: 30000}),
        chartFrame.waitFor({state: 'visible', timeout: 30000}),
      ]);
      if (await password.isVisible().catch(() => false)) {
        await password.waitFor({state: 'visible', timeout: 15000});
        await password.fill(credential);
        const loginResponse = page.waitForResponse(response => response.url().endsWith('/api/login') && response.request().method() === 'POST');
        await page.getByRole('button', {name: '登录并进入图表'}).click();
        assert.equal((await loginResponse).status(), 200, 'product login failed');
        await page.waitForURL(url => url.pathname.startsWith('/advanced-charts'), {timeout: 15000});
      }
      await chartFrame.waitFor({timeout: 30000});
      const chartUrl = new URL(await chartFrame.getAttribute('src'), config.base.origin);
      assert.equal(chartUrl.origin, config.chart.origin, 'chart iframe origin differs from explicit configuration');
      const chartDocument = chartFrame.contentFrame();
      const renderedChart = chartDocument.locator('iframe[title="Financial Chart"]').contentFrame();
      await renderedChart.locator('canvas').first().waitFor({state: 'visible', timeout: 30000});
      const chartCanvas = await renderedChart.locator('canvas').first().evaluate(canvas => {
        const rect = canvas.getBoundingClientRect();
        return {width: rect.width, height: rect.height, bitmapWidth: canvas.width, bitmapHeight: canvas.height};
      });
      assert.ok(chartCanvas.width > 100 && chartCanvas.height > 100, `chart canvas has invalid size: ${JSON.stringify(chartCanvas)}`);
      const chartHostFrame = await (await chartFrame.elementHandle()).contentFrame();
      await chartHostFrame.waitForFunction(mobile => ready && !loading && (!mobile || mobileChartView?.state().selected), stage !== 'desktop',
        {timeout: 60000});
      if (stage === 'recovery') {
        const banner = page.locator('.preference-draft-banner');
        assert.match(await banner.innerText(), /有 1 项设置草稿未保存/);
        await banner.getByRole('button', {name:'处理设置草稿'}).click();
        const dialog = page.getByRole('dialog', {name:'处理设置草稿'});
        await dialog.waitFor({state:'visible'});
        const options = await dialog.locator('option').allTextContents();
        assert.equal(options.length,1);assert.match(options[0],/mw.watchlists.v1/);
        await dialog.getByRole('button',{name:'采用服务器设置'}).waitFor({state:'visible'});
        const stored = await page.evaluate(() => Object.keys(localStorage).filter(k=>k.startsWith('mw-preference-draft:v1:admin:mobile-test:')));
        assert.equal(stored.length,2,'opening recovery removed an unrelated draft');
        await dialog.getByRole('button',{name:'稍后处理'}).click();
        assert.deepEqual(report.requests.workspaceWrites,[]);assert.deepEqual(report.requests.preferenceWrites,[]);
        report.cases.push({name:'mobile recovery exposes only permitted setting; desktop draft preserved',visible:1,preserved:2,
          boundary:'synthetic drafts in isolated temporary browser storage; real API reads; no save/discard executed'});
        report.passed=report.errors.length===0;return;
      }
      if (stage === 'desktop') {
        const before = await chartHostFrame.evaluate(() => ({charts:widget.chartsCount(),readonly:nativeReadonly}));
        assert.equal(before.readonly,false);
        await page.setViewportSize({width:390,height:844});
        const after = await chartHostFrame.evaluate(() => ({charts:widget.chartsCount(),readonly:nativeReadonly}));
        assert.deepEqual(after,before);assert.equal(await page.getByRole('navigation',{name:'移动端导航'}).count(),0);
        assert.deepEqual(report.requests.workspaceWrites,[]);
        report.cases.push({name:'desktop resize preserves session and chart count',before,after,
          boundary:'real instance reads; startup preference migration response simulated; persistent writes blocked'});
        report.passed=report.errors.length===0;return;
      }
      const nav = page.getByRole('navigation', {name: '移动端导航'});
      const viewportCases = [];
      for (const viewport of [{width: 375, height: 667}, {width: 390, height: 844}, {width: 915, height: 412}]) {
        await page.setViewportSize(viewport);
        await nav.waitFor({state: 'visible'});
        const tabs = [];
        for (const tab of ['图表', '自选', '告警', '更多']) {
          await nav.getByRole('button', {name: new RegExp(tab)}).click();
          const dimensions = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth}));
          assert.ok(dimensions.scroll <= dimensions.client, `${viewport.width}x${viewport.height} ${tab} horizontal overflow: ${JSON.stringify(dimensions)}`);
          tabs.push({tab, dimensions});
        }
        viewportCases.push({viewport, tabs});
      }
      await nav.getByRole('button', {name: /图表/}).click();
      const before = await page.evaluate(async () => (await fetch('/api/advanced-charts/workspaces')).json());
      const beforePreferences = await page.evaluate(async () => (await fetch('/api/advanced-charts/preferences')).json());
      const docState = rows => ({count: rows.length, revisions: rows.map(row => row.revision), hash: createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex')});
      const beforeState = docState(before);
      await nav.getByRole('button', {name: /更多/}).click();
      for (const item of ['系统消息', '设置与账户', '历史加载详情', '历史数据容量', '数据状态'])
        await page.getByText(item, {exact: true}).waitFor({state: 'visible'});
      await page.getByRole('button', {name: '历史加载详情'}).click();
      await page.getByRole('dialog', {name: '历史加载详情'}).waitFor({state: 'visible'});
      await page.getByRole('button', {name: '关闭历史加载详情'}).click();
      await page.evaluate(chartOrigin => {
        window.__mobileCenterSession = null;
        const receive = event => {if (event.origin === chartOrigin && event.data?.type === 'data-center-state' && event.data.open) {
          window.__mobileCenterSession = event.data.session;window.removeEventListener('message',receive);
        }};
        window.addEventListener('message',receive);
      }, config.chart.origin);
      const dataStatusRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/market-data/live/status' &&
        response.request().method() === 'GET' && response.ok());
      await page.getByRole('button', {name: '数据状态'}).click();
      await dataStatusRead;
      await renderedChart.getByRole('heading', {name: '来源状态', exact: true}).waitFor({state: 'visible'});
      await renderedChart.getByRole('button', {name: '刷新状态', exact: true}).click();
      const rejected = await chartHostFrame.evaluate(async session => {
        const probes = [
          ['data-center-api',{session,path:'/market-data/live/demand',body:{}}],
          ['data-center-api',{session,path:'/market-data/history-catalog/refresh',body:{}}],
          ['data-center-api',{session,path:'/market-data/center/datasets',body:{}}],
          ['preferences',{op:'save',args:{kind:'setting',name:'mw.theme',tool:'',revision:0,content:{value:'light'}}}],
          ['workspace',{op:'delete',args:{id:mobileWorkspaceId}}],
          ['chart-alert-ui-rpc',{workspace_id:alertUIWorkspace,session:alertUISession,path:'/chart-alerts',body:{}}],
          ['chart-alert-ui-rpc',{workspace_id:alertUIWorkspace,session:alertUISession,path:'/chart-alerts/00000000-0000-4000-8000-000000000000/lifecycle',body:{action:'restart'}}],
        ];
        return Promise.all(probes.map(async ([type,query]) => {
          try {await request(query,type);return {type,rejected:false};}
          catch(error) {return {type,rejected:true,error:error.message};}
        }));
      }, await page.evaluate(() => window.__mobileCenterSession));
      assert.ok(rejected.every(probe => probe.rejected), 'forged management/write request passed the parent boundary');
      await renderedChart.getByRole('button', {name: '关闭数据中心', exact: true}).click();
      await page.waitForURL(url => !url.searchParams.has('data_center'));
      await nav.getByRole('button', {name: /图表/}).click();
      const resourceCounts = () => chartHostFrame.evaluate(() => ({charts: widget.chartsCount(),
        subscriptions: subscriptions.size, quotes: quoteSubscriptions.size, indicators: indicatorBindings.size}));
      const resourceBefore = await resourceCounts();
      const resourceSamples = [];
      await page.setViewportSize({width: 390, height: 844});
      for (let turn = 0; turn < 20; turn++) {
        const generation = await chartHostFrame.evaluate(() => mobileChartView.state().generation);
        await page.locator('.mobile-chart-picker button').first().click();
        await chartHostFrame.waitForFunction(previous => {
          const state = mobileChartView.state();
          return state.generation > previous && state.selected && !state.exploring && !loading;
        }, generation, {timeout: 60000});
        for (const tab of ['自选', '告警', '图表']) await nav.getByRole('button', {name: new RegExp(tab)}).click();
        resourceSamples.push(await resourceCounts());
      }
      const resourceAfter = await resourceCounts();
      assert.equal(resourceAfter.charts, 1, 'repeated selection leaked chart slots');
      for (const key of ['subscriptions', 'quotes', 'indicators'])
        assert.ok(resourceAfter[key] <= resourceBefore[key], `${key} grew after 20 selections`);
      await page.locator('.mobile-shell-actions').getByRole('button', {name:'系统消息',exact:true}).click();
      await renderedChart.getByRole('region',{name:'系统消息',exact:true}).waitFor({state:'visible'});
      await renderedChart.getByRole('button',{name:'关闭系统消息',exact:true}).click();
      await page.waitForURL(url => url.searchParams.get('panel') !== 'notifications');
      const after = await page.evaluate(async () => (await fetch('/api/advanced-charts/workspaces')).json());
      const afterPreferences = await page.evaluate(async () => (await fetch('/api/advanced-charts/preferences')).json());
      const afterState = docState(after);
      assert.deepEqual(afterState, beforeState, 'mobile browsing changed workspace document or revision');
      assert.deepEqual(afterPreferences, beforePreferences, 'mobile browsing changed shared preferences');
      assert.deepEqual(report.requests.workspaceWrites, [], 'mobile browsing sent a workspace write');
      assert.deepEqual(report.requests.preferenceWrites, [], 'mobile browsing sent a preference write');
      assert.deepEqual(report.requests.blockedForbiddenCalls, [], 'forged request reached the HTTP transport');
      assert.ok(report.requests.dataCenterReads.length > 0, 'data status did not issue its read-only data requests');
      report.cases.push({name: 'real product mobile shell and readonly boundary', chartOrigin: chartUrl.origin,
        chartCanvas, viewportCases, workspace: beforeState, dataCenterReads: report.requests.dataCenterReads,
        repeatNavigation: {turns: 20, before: resourceBefore, after: resourceAfter, samples: resourceSamples},
        rejectedParentRequests:rejected});
      report.passed = report.errors.length === 0;
      return;
    }
    let html = fs.readFileSync(path.join(__dirname, 'fixtures/native-history.html'), 'utf8');
    html = html.replace('enabled_features:[', "enabled_features:['support_multicharts', 'header_layouttoggle',");
    html = html.replace('<script>\n// Standalone', '<script src="/mobile-chart-document.js"></script><script src="/mobile-chart-view.js"></script><script>\n// Standalone');
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {report.externalRequestsBlocked++; return route.fulfill({status: 204, body: ''});}
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: html});
      const base = url.pathname.startsWith('/charting_library/') ? library : path.join(root, 'advanced-host');
      const relative = url.pathname.startsWith('/charting_library/') ? url.pathname.slice('/charting_library/'.length) : url.pathname.slice(1);
      const file = path.resolve(base, decodeURIComponent(relative));
      assert.ok(file.startsWith(path.resolve(base) + path.sep), 'Path escaped local fixture');
      if (!fs.existsSync(file)) return route.fulfill({status: 404});
      const mime = {'.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml'};
      return route.fulfill({contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    await page.goto(origin + '/?initialCount=1000');
    await page.waitForFunction(() => ready && widget.activeChart().dataReady());
    await page.evaluate(async () => {
      widget.setLayout('4'); widget.symbolSync().setValue(false); widget.intervalSync().setValue(false);
    });
    await page.waitForFunction(() => widget.chartsCount() === 4);
    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        widget.setActiveChart(i);
        const chart = widget.chart(i);
        await chart.setSymbol('MWP:' + (i < 2 ? 'TEST' : 'TEST-' + i), {doNotActivateChart: true});
        await chart.setResolution(i % 2 ? '5' : '1D', {doNotActivateChart: true});
        await chart.createStudy('Moving Average', false, false, {length: 10 + i});
        await chart.createShape({time: END / 1000 - 86400, price: 100 + i}, {shape: 'horizontal_line'});
      }
    });
    await page.waitForFunction(() => Array.from({length:4}, (_, i) => widget.chart(i)).every(chart => chart.dataReady()));
    if (stage === 'inspect') {
      report.publicCapture = await page.evaluate(() => {
        const chart = widget.chart(1), scale = chart.getTimeScale();
        return {
          symbol: chart.symbol(), resolution: chart.resolution(), type: chart.chartType(),
          visibleRange: chart.getVisibleRange(), barSpacing: scale.barSpacing(), rightOffset: scale.rightOffset(),
          styles: chart.getSeries().chartStyleProperties(chart.chartType()),
          studies: chart.getAllStudies().map(({id, name}) => {
            const api = chart.getStudyById(id);
            return {name, inputs: api.getInputValues(), styles: api.getStyleValues(), visible: api.isVisible(), pane: api.paneIndex()};
          }),
          drawings: chart.getAllShapes().map(({id, name}) => {
            const api = chart.getShapeById(id);
            return {name, points: api.getPoints(), properties: api.getProperties(), selection: api.isSelectionEnabled(), saving: api.isSavingEnabled()};
          }),
        };
      });
      assert.ok(report.publicCapture.studies.length >= 1);
      assert.ok(report.publicCapture.drawings.length >= 1);
      report.passed = true;
      return;
    }
    const before = await page.evaluate(async () => {
      globalThis.originalDocument = await new Promise(resolve => widget.save(resolve, {includeDrawings: true}));
      originalDocument._mwAlertCharts = ['original-1','original-2','original-3','original-4'];
      globalThis.mobileProjection = createMobileChartView({widget, workspace: {id: 'fixture-w1', revision: 7, name: 'W1'}, document: originalDocument});
      return {document: originalDocument, directory: mobileProjection.buildDirectory(originalDocument)};
    });
    report.beforeHash = hash(before.document);
    if (process.env.MW_MOBILE_FIXTURE_FILE) {
      assert.ok(path.isAbsolute(process.env.MW_MOBILE_FIXTURE_FILE), 'Fixture export must use an absolute private path');
      fs.writeFileSync(process.env.MW_MOBILE_FIXTURE_FILE, JSON.stringify(before), {mode: 0o600});
    }
    assert.equal(before.directory.length, 4);
    for (const index of [1, 3]) {
      const result = await page.evaluate(async index => {
        const committed = await mobileProjection.select(index);
        return {committed, state: mobileProjection.state(), count: widget.chartsCount(),
          symbol: widget.chart(0).symbol(), resolution: widget.chart(0).resolution(),
          studies: widget.chart(0).getAllStudies(), shapes: widget.chart(0).getAllShapes()};
      }, index);
      assert.equal(result.committed, true); assert.equal(result.count, 1);
      assert.equal(result.state.selected.original_index, index);
      assert.equal(result.state.selected.original_chart_id, 'original-' + (index + 1));
      assert.equal(result.symbol, before.directory[index].symbol);
      assert.equal(result.resolution, before.directory[index].resolution);
      report.cases.push({name: 'select original ' + (index + 1), ...result});
    }
    const after = await page.evaluate(() => originalDocument);
    report.afterHash = hash(after); assert.equal(report.afterHash, report.beforeHash);
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) {report.passed = false; report.failure = error.stack; process.exitCode = 1;}
  finally {
    if (browser) await browser.close();
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, output, failure: report.failure}));
  }
})();
