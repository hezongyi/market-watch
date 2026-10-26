// Resume the real published-version chart check without repeating upstream imports.
const { chromium } = require('@playwright/test');
const fs = require('node:fs'), assert = require('node:assert/strict');
const out = process.env.MW_FXCM_ARTIFACT_DIR, base = new URL(process.env.MW_FXCM_BASE_URL).origin;
const credentialFile = process.env.MW_FXCM_CREDENTIAL_FILE;
assert(out && credentialFile);
assert(!(fs.statSync(credentialFile).mode & 0o077));
const previous = JSON.parse(fs.readFileSync(out + '/browser-result.json'));
assert(previous.dual_chart?.shared_dataset && previous.embedded_directory_refresh && previous.directory_ui_rendered);
assert(previous.managed.parent_unchanged && previous.managed.duplicate_request_id_reused && previous.managed.plan_pause_resume);
const report = { passed: false, started_at: new Date().toISOString(), version: previous.managed.child };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
  let csrf;
  const api = async (route, body) => {
    const r = await context.request.fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST', data: body,
      headers: csrf ? { 'X-CSRF-Token': csrf } : {}, timeout: 75000 });
    assert(r.ok(), route + ': HTTP ' + r.status()); return r.json();
  };
  try {
    csrf = (await api('login', { password: JSON.parse(fs.readFileSync(credentialFile)).password })).csrf;
    const ticker = 'MWH:' + report.version;
    const w = await api('advanced-charts/workspaces', { name: 'FXCM published history acceptance' });
    await api('advanced-charts/workspaces/' + w.id + '/save', { name: w.name, revision: w.revision,
      document: { engine: 'tv31', schemaVersion: 1, symbol: ticker, series_kind: 'history', interval: '1' } });
    const page = await context.newPage();
    await page.goto(base + '/advanced-charts/' + w.id);
    await page.waitForFunction(() => document.querySelector('iframe'));
    const deadline = Date.now() + 60000;
    let frame;
    while (!frame && Date.now() < deadline) {
      frame = page.frames().find(f => { try { return new URL(f.url()).searchParams.get('parent') === base; } catch { return false; } });
      if (!frame) await new Promise(r => setTimeout(r, 250));
    }
    assert(frame, 'Native host missing');
    await frame.waitForFunction(expected => typeof ready !== 'undefined' && ready && !loading && widget &&
      MWSeries.same(widget.activeChart().symbol(), expected) && widget.activeChart().dataReady(), ticker, { timeout: 75000 });
    const study = await frame.evaluate(() => widget.activeChart().createStudy('Moving Average', false, false, { length: 5 }));
    assert(study, 'Published history indicator missing');
    await frame.waitForFunction(id => widget.activeChart().getAllStudies().some(s => s.id === id), study);
    await page.screenshot({ path: out + '/fxcm-managed-chart.png' });
    report.passed = true; report.workspace = w.id; report.indicator_created = true;
    previous.managed.chart_rendered = true; previous.managed.indicator_created = true;
    previous.managed.chart_ticker = ticker;
    previous.continuation = { reason: 'Harness used legacy managed instrument; actual product opens immutable MWH version',
      entry: 'web/tests/fxcm-managed-chart.browser.cjs', started_at: report.started_at };
    previous.passed = true; previous.stage = 'managed-chart'; delete previous.error;
    previous.finished_at = new Date().toISOString();
    fs.writeFileSync(out + '/browser-result.json', JSON.stringify(previous, null, 2));
  } catch (e) { report.error = String(e.message).split('\n')[0]; process.exitCode = 1; }
  finally { report.finished_at = new Date().toISOString(); fs.writeFileSync(out + '/managed-chart-result.json', JSON.stringify(report, null, 2));
    await context.close(); await browser.close(); console.log(JSON.stringify(report)); }
})();
