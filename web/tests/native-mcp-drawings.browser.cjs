// Real local Compose UI -> native public shape APIs -> persisted workspace -> HTTP MCP.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP_ORIGIN || 'https://localhost:18543';
const CHART = process.env.CHART_ORIGIN || 'https://localhost:18544';
const PRIVATE = process.env.MW_MCP_PRIVATE_DIR || '/tmp/mw-native-mcp-acceptance';
const OUT = process.env.MW_MCP_DRAWING_OUTPUT || '/tmp/native-mcp-browser-runtime.json';
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}) });
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1600, height: 950}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const token = fs.readFileSync(path.join(PRIVATE, 'agent-read.token'), 'utf8').trim();
  const login = await context.request.post(APP + '/api/login', {data: JSON.parse(fs.readFileSync(path.join(PRIVATE, 'login.json'), 'utf8'))});
  assert.ok(login.ok(), 'browser login');
  const {csrf} = await login.json();
  async function api(route, body) {
    const response = body ? await context.request.post(APP + '/api/' + route,
      {headers: {'X-CSRF-Token': csrf}, data: body}) : await context.request.get(APP + '/api/' + route);
    assert.ok(response.ok(), `${route}: HTTP ${response.status()}`);
    return response.json();
  }
  async function rpc(method, params) {
    const response = await context.request.post(APP + '/mcp', {
      headers: {Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'},
      data: {jsonrpc: '2.0', id: 1, method, params},
    });
    assert.ok(response.ok(), `MCP HTTP ${response.status()}`);
    const body = await response.json();
    assert.ok(!body.error, JSON.stringify(body.error));
    return body.result;
  }
  async function drawings(workspaceId) {
    const result = await rpc('tools/call', {name: 'charts_get_drawings', arguments: {workspace_id: workspaceId}});
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  }
  async function save(frame) {
    const responsePromise = page.waitForResponse(response =>
      response.url() === APP + '/api/advanced-charts/native-charts/save' &&
      response.request().method() === 'POST', {timeout: 60000});
    // Use the actual save shortcut so the bridge also clears dirty/unload state.
    await page.keyboard.press('Control+s');
    const response = await responsePromise;
    assert.ok(response.ok(), `native save: HTTP ${response.status()}`);
    const row = await response.json();
    assert.equal(row.id, workspace.id, 'native save targets this isolated workspace');
    await frame.waitForFunction(() => !nativeSaving && !dirty, null, {timeout: 60000});
    return api('advanced-charts/native-charts/' + row.id);
  }
  let workspace;
  try {
    const initialized = await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'browser-drawings-acceptance', version: '1'}});
    assert.equal(initialized.serverInfo.name, 'Market Watch');
    workspace = await api('advanced-charts/workspaces', {name: 'MCP real native drawing ' + Date.now()});
    workspace = await api('advanced-charts/workspaces/' + workspace.id + '/save', {name: workspace.name, revision: workspace.revision,
      document: {engine: 'tv31', schemaVersion: 1, symbol: 'EURUSD', series_kind: 'managed', interval: '60'}});
    await page.goto(APP + '/advanced-charts');
    await page.locator('iframe[data-workspace-id="' + workspace.id + '"]').waitFor({timeout: 60000});
    let frame = page.frames().find(f => f.url().startsWith(CHART + '/'));
    assert.ok(frame, 'isolated native chart origin');
    async function ready(f) {
      await f.waitForFunction(() => typeof ready !== 'undefined' && ready && !loading && !nativeSaving && widget.activeChart().dataReady(), null, {timeout: 60000});
    }
    await ready(frame);
    assert.equal(await frame.evaluate(() => widget.chart(0).symbol()), 'EURUSD');
    await frame.evaluate(async () => {
      if (autoSave.enabled) await autoSave.select(false);
      await widget.chart(0).setResolution('60', {doNotActivateChart: true});
    });
    await ready(frame);
    const ids = await frame.evaluate(async () => {
      const chart = widget.chart(0), range = chart.getVisibleRange();
      const anchors = [{time: range.to - 8 * 3600, price: 1.1001}, {time: range.to - 4 * 3600, price: 1.1004}];
      return [await chart.createShape(anchors[0], {shape: 'horizontal_line'}),
              await chart.createMultipointShape(anchors, {shape: 'trend_line'}),
              await chart.createMultipointShape(anchors, {shape: 'rectangle'})];
    });
    const saved = await save(frame);
    const first = await drawings(workspace.id);
    assert.equal(first.revision, saved.revision);
    assert.equal(Math.floor(first.saved_at / 1000), saved.timestamp);
    assert.equal(first.charts[0].instrument, 'EURUSD');
    assert.equal(first.charts[0].series_kind, 'managed');
    assert.equal(first.charts[0].timeframe, 'H1');
    const projected = saved.document.state._mwDrawingProjection.charts[0].drawings;
    for (const id of ids) {
      const raw = projected.find(s => s.id === id), actual = first.charts[0].drawings.find(s => s.object_id === id);
      assert.ok(actual?.supported, `supported saved drawing ${id}`);
      assert.equal(actual.object_type, raw.name);
      assert.deepEqual(actual.anchors, raw.points.map(p => ({time: p.time == null ? null : p.time * 1000, price: String(p.price)})));
    }
    const unsavedId = await frame.evaluate(() => widget.chart(0).createShape({price: 1.1010, time: widget.chart(0).getVisibleRange().to}, {shape: 'horizontal_line'}));
    assert.deepEqual(await drawings(workspace.id), first, 'unsaved browser changes are invisible to MCP');
    const secondSaved = await save(frame), second = await drawings(workspace.id);
    assert.equal(second.revision, secondSaved.revision);
    assert.ok(second.revision > first.revision, 'successful native save advances revision');
    assert.ok(second.charts[0].drawings.some(s => s.object_id === unsavedId && s.supported));
    await page.reload();
    await page.locator('iframe[data-workspace-id="' + workspace.id + '"]').waitFor({timeout: 60000});
    frame = page.frames().find(f => f.url().startsWith(CHART + '/'));
    assert.ok(frame);
    await ready(frame);
    const restoredIds = await frame.evaluate(() => widget.chart(0).getAllShapes().map(s => s.id));
    assert.ok([...ids, unsavedId].every(id => restoredIds.includes(id)), 'native objects restored from PostgreSQL save');
    assert.deepEqual(await drawings(workspace.id), second, 'refresh cannot change saved projection');
    assert.deepEqual(errors, []);
    const report = {passed: true, app: APP, chart_origin: CHART, synthetic_market_data: true,
      workspace_id: workspace.id, checks: ['real chart public coordinates', 'PostgreSQL saved revision', 'HTTP MCP projection parity',
      'unsaved edits invisible', 'subsequent save visible', 'page refresh persists drawing identities'], first, second};
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
    console.log('Native drawing HTTP MCP acceptance passed:', OUT);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
