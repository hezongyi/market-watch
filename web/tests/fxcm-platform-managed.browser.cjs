// Real upstream + task-owned application only. Never use the long-lived acceptance instance.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const base = new URL(process.env.MW_FXCM_BASE_URL).origin;
const credentialFile = process.env.MW_FXCM_CREDENTIAL_FILE;
const out = path.resolve(process.env.MW_FXCM_ARTIFACT_DIR);
if (!credentialFile || !process.env.MW_FXCM_ARTIFACT_DIR) throw Error('Set the three MW_FXCM_* acceptance parameters');
if (fs.statSync(credentialFile).mode & 0o077) throw Error('App credential file must be owner-only');
const password = JSON.parse(fs.readFileSync(credentialFile, 'utf8')).password;
assert.equal(typeof password, 'string');
fs.mkdirSync(out, { recursive: true });
const report = { kind: 'real_task_owned_application', passed: false, started_at: new Date().toISOString(), platform: [], managed: {} };
const save = () => fs.writeFileSync(path.join(out, 'browser-result.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checkpoint = stage => {
  report.stage = stage;
  (report.checkpoints ||= []).push({ stage, at: new Date().toISOString() });
  if (['dual-chart-shared', 'managed-created', 'managed-first-published', 'managed-incremental-published', 'managed-chart'].includes(stage)) {
    const code = `import json
from sqlalchemy import text
from alerts.storage import transaction
with transaction() as db:
 print(json.dumps(dict(db.execute(text("select tup_inserted,tup_updated,tup_deleted from pg_stat_database where datname=current_database()" )).mappings().one())))`;
    const names = execFileSync('docker', ['ps', '--filter', 'label=com.docker.compose.project=mw-fxcm-history-20261024', '--format', '{{.Names}}']).toString().trim().split('\n');
    (report.resources ||= []).push({ stage, at: new Date().toISOString(),
      db_writes: JSON.parse(execFileSync('docker', ['exec', 'mw-fxcm-history-20261024-api-1', 'python', '-c', code], { timeout: 30000 }).toString()),
      containers: execFileSync('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...names], { timeout: 30000 }).toString().trim().split('\n').map(line => JSON.parse(line)) });
  }
  save(); console.log(JSON.stringify({ stage }));
};
function sharedSubscriptions() {
  const code = `import json
from sqlalchemy import select
from alerts.storage import transaction,MarketStreamTask,MarketStreamSubscription,now_ms
with transaction() as db:
 rows=db.execute(select(MarketStreamTask,MarketStreamSubscription).join(MarketStreamSubscription,MarketStreamTask.id==MarketStreamSubscription.task_id).where(MarketStreamSubscription.active.is_(True),MarketStreamSubscription.expires>now_ms())).all()
 print(json.dumps([dict(dataset_id=t.identity.get('dataset_id'),task_id=t.id,listener=s.listener,source=t.identity.get('metadata',{}).get('source'),timeframe=t.query.get('timeframe')) for t,s in rows if t.identity.get('kind')=='bars']))`;
  return JSON.parse(execFileSync('docker', ['exec', 'mw-fxcm-history-20261024-api-1', 'python', '-c', code], { timeout: 30000 }).toString());
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
  let csrf;
  async function api(endpoint, body) {
    const response = await context.request.fetch(base + '/api/' + endpoint, {
      method: body === undefined ? 'GET' : 'POST', data: body,
      headers: csrf ? { 'X-CSRF-Token': csrf } : {}, timeout: 75000,
    });
    // Do not dump upstream payloads, login data, or browser storage on failure.
    assert(response.ok(), endpoint.split('?')[0] + ': HTTP ' + response.status());
    return response.json();
  }
  async function published(id) {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const version = await api('market-data/versions/' + id);
      if (version.status === 'published') return version;
      assert(!['failed', 'cancelled'].includes(version.status), 'History task failed');
      await sleep(1500);
    }
    throw Error('History publish timeout');
  }
  try {
    csrf = (await api('login', { password })).csrf;
    const refresh = await api('market-data/history-catalog/refresh', { source: 'fxcm' });
    assert(refresh.count > 0);
    report.directory_count = refresh.count;
    checkpoint('catalog-refreshed');
    const catalog = [];
    for (const [query, symbol, precision] of [['EURUSD', 'EUR/USD', 5], ['XAUUSD', 'XAU/USD', 2]]) {
      const page = await api('market-data/center/platform?source=fxcm&query=' + query);
      const instrument = page.items.find(row => row.provider_symbol === symbol);
      assert(instrument, 'Real directory symbol missing');
      assert.equal(instrument.precision, precision);
      assert.deepEqual(instrument.capabilities.native_periods, ['M1', 'H1', 'D1']);
      catalog.push(instrument);
      for (const timeframe of ['M1', 'H1', 'D1']) {
        const body = { instrument: instrument.id, series_kind: 'provider', timeframe, limit: 20 };
        const candles = await api('charts/data', body);
        assert(candles.bars.length > 0);
        assert.equal(candles.source, 'fxcm');
        assert.equal(candles.volume_kind, 'tick_count');
        assert.equal(candles.volume_unit, 'price_changes');
        const starts = candles.bars.map(bar => bar.start);
        assert.equal(new Set(starts).size, starts.length);
        assert(starts.every((value, index) => index === 0 || value > starts[index - 1]));
        assert(candles.bars.every(bar => bar.source_confirmed == null));
        const older = await api('charts/data', { ...body, before: starts[0] });
        assert(older.bars.every(bar => bar.start < starts[0]), 'Native pagination overlaps');
        report.platform.push({ symbol, timeframe, count: starts.length, older_count: older.bars.length });
        checkpoint(symbol + '-' + timeframe);
      }
    }

    // Open actual native widget and prove that the selected FXCM series renders.
    const instrument = catalog[0], ticker = 'MWP:' + instrument.id;
    const workspace = await api('advanced-charts/workspaces', { name: 'FXCM isolated acceptance', symbol: ticker });
    await api('advanced-charts/workspaces/' + workspace.id + '/save', {
      name: workspace.name, revision: workspace.revision,
      document: { engine: 'tv31', schemaVersion: 1, symbol: ticker, series_kind: 'provider', interval: '60' },
    });
    const page = await context.newPage();
    const hostFrame = () => page.frames().find(candidate => {
      try {
        const url = new URL(candidate.url());
        return candidate.parentFrame() === page.mainFrame() && url.searchParams.get('parent') === base;
      } catch { return false; }
    });
    const nativeFrame = () => page.frames().find(candidate => candidate.url().startsWith('blob:') &&
      candidate.parentFrame() === hostFrame());
    async function openCenter(location) {
      if (await nativeFrame().locator('.dc-window').count()) {
        await nativeFrame().getByRole('button', { name: '关闭数据中心', exact: true }).click();
        await nativeFrame().locator('.dc-window').waitFor({ state: 'hidden' });
      }
      await hostFrame().evaluate(location => dataCenter.open(location), location);
      await nativeFrame().locator('.dc-window').waitFor({ timeout: 60000 });
      return nativeFrame().locator('.dc-window');
    }
    await page.goto(base + '/advanced-charts/' + workspace.id, { timeout: 30000 });
    await expect.poll(() => !!hostFrame(), { timeout: 60000 }).toBeTruthy();
    const frame = hostFrame();
    await frame.waitForFunction(expected => typeof ready !== 'undefined' && ready && !loading && widget &&
      MWSeries.same(widget.activeChart().symbol(), expected) && widget.activeChart().dataReady(), ticker, { timeout: 75000 });
    await page.screenshot({ path: path.join(out, 'fxcm-platform-chart.png') });
    report.chart_rendered = true;
    await frame.evaluate(() => { widget.symbolSync().setValue(false); widget.intervalSync().setValue(false); widget.setLayout('2h'); });
    await frame.waitForFunction(() => widget.chartsCount() === 2);
    await frame.evaluate(async expected => {
      await widget.chart(1).setSymbol(expected, { doNotActivateChart: true });
      await widget.chart(1).setResolution('60', { doNotActivateChart: true });
    }, ticker);
    await frame.waitForFunction(expected => [0, 1].every(i => MWSeries.same(widget.chart(i).symbol(), expected) && widget.chart(i).dataReady()), ticker, { timeout: 90000 });
    // TradingView may share one datafeed binding for identical series in two panes.
    // Prove both panes rendered, then inspect the binding(s) that actually exist.
    const panes = await frame.evaluate(() => [0, 1].map(i => ({
      symbol: widget.chart(i).symbol(), resolution: widget.chart(i).resolution(),
      ready: widget.chart(i).dataReady(),
    })));
    assert(panes.every(pane => pane.ready && pane.resolution === '60'));
    const bindings = await frame.evaluate(() => [...subscriptions.values()]
      .filter(sub => decode(sub.symbol).symbol.startsWith('FXCM:') && sub.res === '60')
      .map(sub => sub.marketListener));
    assert(bindings.length > 0);
    await expect.poll(() => sharedSubscriptions().filter(row => bindings.includes(row.listener)).length, { timeout: 30000 }).toBe(bindings.length);
    const subscriptions = sharedSubscriptions().filter(row => row.source === 'fxcm' && row.timeframe === 'H1');
    assert.equal(new Set(subscriptions.map(row => row.dataset_id)).size, 1, 'Both charts must share one cache dataset');
    assert(subscriptions.every(row => row.dataset_id));
    assert.equal(new Set(subscriptions.map(row => row.task_id)).size, 1, 'Both charts must share one stream task');
    report.dual_chart = { rendered: true, panes, datafeed_bindings: bindings.length, subscriptions, shared_dataset: true };
    await page.screenshot({ path: path.join(out, 'fxcm-dual-chart.png') });
    checkpoint('dual-chart-shared');
    let center = await openCenter('/market-data/datasets/new?source=fxcm');
    const refreshed = page.waitForResponse(response => response.url() === base + '/api/market-data/history-catalog/refresh' &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.source === 'fxcm', { timeout: 75000 });
    await center.getByRole('button', { name: '显式刷新 FXCM 品种目录', exact: true }).click();
    assert((await refreshed).ok(), 'Embedded explicit FXCM directory refresh failed');
    await center.getByRole('button', { name: '显式刷新 FXCM 品种目录', exact: true }).waitFor({ timeout: 75000 });
    report.embedded_directory_refresh = true;
    center = await openCenter('/market-data?tab=platform&source=fxcm&query=EURUSD');
    await center.getByRole('heading', { name: '平台行情', exact: true }).waitFor({ timeout: 30000 });
    await center.getByRole('searchbox', { name: '搜索品种', exact: true }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(out, 'fxcm-platform-directory.png') });
    report.directory_ui_rendered = true;
    await page.goto(base + '/');
    checkpoint('embedded-directory');

    // Use a recent completed weekday; never infer inception or request an unbounded import.
    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    while ([0, 6].includes(endDate.getUTCDay())) endDate.setUTCDate(endDate.getUTCDate() - 1);
    const end = endDate.getTime() + 18 * 3600000;
    const start = end - 2 * 3600000;
    const dataset = await api('market-data/datasets', { source: 'fxcm', logical_symbol: 'EURUSD',
      provider_symbol: instrument.provider_symbol, asset_class: 'forex', precision: instrument.precision,
      aggregation_calendar: 'ny17', catalog_id: instrument.id });
    report.managed.dataset = dataset;
    checkpoint('managed-created');
    await api('market-data/datasets/' + dataset.id + '/maintenance', { target_start: start,
      timeframes: ['M1', 'H4'], frequency: 'once', overlap_minutes: 30 });
    const runBody = { request_id: 'fxcm-acceptance-first-' + Date.now(), end };
    const first = await api('market-data/datasets/' + dataset.id + '/tasks', runBody);
    const duplicate = await api('market-data/datasets/' + dataset.id + '/tasks', runBody);
    assert.equal(first.id, duplicate.id);
    const parent = await published(first.id);
    checkpoint('managed-first-published');
    const parentBars = await api('market-data/versions/' + parent.id + '/bars?timeframe=M1');
    const h4 = await api('market-data/versions/' + parent.id + '/bars?timeframe=H4');
    assert(parentBars.bars.length > 0 && h4.bars.length > 0);
    const next = await api('market-data/datasets/' + dataset.id + '/tasks', {
      request_id: 'fxcm-acceptance-next-' + Date.now(), end: end + 3600000 });
    const child = await published(next.id);
    checkpoint('managed-incremental-published');
    assert.equal(child.parent_version_id, parent.id);
    assert.deepEqual((await api('market-data/versions/' + parent.id)).manifest, parent.manifest);
    assert.deepEqual(await api('market-data/versions/' + parent.id + '/bars?timeframe=M1'), parentBars);
    await api('market-data/datasets/' + dataset.id + '/maintenance/control', { action: 'pause' });
    assert.equal((await api('market-data/datasets/' + dataset.id + '/maintenance')).paused, true);
    await api('market-data/datasets/' + dataset.id + '/maintenance/control', { action: 'resume' });
    assert.equal((await api('market-data/datasets/' + dataset.id + '/maintenance')).paused, false);
    report.managed = { dataset, parent: parent.id, child: child.id, parent_unchanged: true,
      duplicate_request_id_reused: true, m1_count: parentBars.bars.length, h4_count: h4.bars.length,
      plan_pause_resume: true, frequency: 'once' };
    const managedWorkspace = await api('advanced-charts/workspaces', { name: 'FXCM managed acceptance', symbol: ticker });
    await api('advanced-charts/workspaces/' + managedWorkspace.id + '/save', {
      name: managedWorkspace.name, revision: managedWorkspace.revision,
      document: { engine: 'tv31', schemaVersion: 1, symbol: 'MWH:' + child.id, series_kind: 'history', interval: '1' },
    });
    await page.goto(base + '/advanced-charts/' + managedWorkspace.id);
    await expect.poll(() => !!hostFrame(), { timeout: 60000 }).toBeTruthy();
    await hostFrame().waitForFunction(() => typeof ready !== 'undefined' && ready && !loading && widget && widget.activeChart().dataReady(), null, { timeout: 75000 });
    const study = await hostFrame().evaluate(() => widget.activeChart().createStudy('Moving Average', false, false, { length: 5 }));
    assert(study, 'Managed chart indicator missing');
    report.managed.chart_rendered = true;
    report.managed.indicator_created = true;
    await page.screenshot({ path: path.join(out, 'fxcm-managed-chart.png') });
    await page.close();
    checkpoint('managed-chart');
    report.passed = true;
  } catch (error) {
    report.error = String(error.message).split('\n')[0];
    process.exitCode = 1;
  } finally {
    report.finished_at = new Date().toISOString();
    save();
    await context.close();
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, platform_pages: report.platform.length,
      chart_rendered: !!report.chart_rendered, managed_passed: !!report.managed.parent_unchanged }));
  }
})();
