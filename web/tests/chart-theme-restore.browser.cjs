// Real widget lifecycle; isolate layout/preference writes in an in-memory
// server fixture so regression tests cannot overwrite user workspaces.
const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { base, art } = fixture;
const clone = value => JSON.parse(JSON.stringify(value));
const report = { environment: 'Ubuntu isolated Docker; native widget with in-memory workspace/preference storage',
  project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const frames = fixture.frames(page);
  const wait = async () => {
    await expect.poll(() => !!frames.host(), { timeout: 30000 }).toBeTruthy();
    await frames.host().waitForFunction(() => typeof ready !== 'undefined' && ready && !loading, null, { timeout: 60000 });
    await expect(frames.native().getByRole('button', { name: '数据中心', exact: true })).toBeVisible();
  };
  const snapshot = () => frames.host().evaluate(() => new Promise(resolve => widget.save(resolve)));
  const saveLayout = async () => {
    // Native theme/style changes may settle after ready. Save only after the
    // actual edit revision and navigation guards remain quiet across samples.
    let previous, stable = 0;
    await expect.poll(async () => {
      const state = await frames.host().evaluate(() => ({ revision: editRevision,
        busy: nativeSaving || rangeGuard?.busy() || edgeGuard?.busy() || MWNativeNavigation.busy() || !widget.activeChart().dataReady() }));
      stable = !state.busy && previous === state.revision ? stable + 1 : 0;
      previous = state.revision;
      return stable;
    }, { timeout: 30000, intervals: [200] }).toBeGreaterThanOrEqual(3);
    await frames.host().evaluate(() => new Promise((resolve, reject) => widget.saveChartToServer(resolve, reject)));
  };
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name, data); };
  const checkTheme = async (theme, background, label) => {
    expect(await frames.host().evaluate(() => widget.getTheme())).toBe(theme.toLowerCase());
    await expect(frames.native().locator('html')).toHaveClass(theme === 'Dark' ? /theme-dark/ : /^(?!.*theme-dark)/);
    const state = await snapshot();
    for (const chart of state.charts) {
      expect(chart.chartProperties.paneProperties.background.toLowerCase(), label).toBe(background.toLowerCase());
      expect(chart.chartProperties.scalesProperties.textColor.toLowerCase()).toBe(theme === 'Dark' ? '#b8b8b8' : '#0f0f0f');
    }
    await expect(page.locator('.advanced-workspace')).toHaveAttribute('data-theme', theme.toLowerCase());
    await frames.native().getByRole('button', { name: '数据中心', exact: true }).click();
    await expect(frames.native().locator(".dc-window")).toBeVisible();
    await expect(frames.native().locator('.dc-window')).toHaveAttribute('data-theme', theme.toLowerCase());
    await frames.native().getByRole('button', { name: '关闭数据中心' }).click();
    return state;
  };
  let layout, rows, nativeSaves = 0, writes = [];
  try {
    if(process.env.LOCAL) await fixture.localNativeAssets(page);
    // Only read existing layout/preferences. No migration is needed to seed.
    await page.route('**/api/advanced-charts/preferences/migrate', route => route.fulfill({ json: { migrated: 0 } }));
    const seedReadOnly = route => {
      if (route.request().method() === 'GET') return route.fallback();
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { ...body, id: 'seed-read-only', revision: (body?.revision || 0) + 1 } });
    };
    await page.route('**/api/advanced-charts/**', seedReadOnly);
    await page.goto(base + '/advanced-charts'); await fixture.login(page); await wait();
    const seed = await snapshot();
    rows = await (await page.request.get(base + '/api/advanced-charts/preferences')).json();
    await page.unroute('**/api/advanced-charts/**', seedReadOnly);
    const fakeId = '00000000-0000-4000-a000-000000000099';
    layout = { id: fakeId, name: '主题恢复隔离验证', revision: 1,
      document: { engine: 'tv31', schemaVersion: 1, symbol: seed.charts[0].panes.flatMap(p => p.sources).find(s => s.type === 'MainSeries').state.symbol,
        interval: '60', state: seed } };
    const meta = () => ({ ...layout, symbol: layout.document.symbol, resolution: layout.document.interval,
      content: JSON.stringify(layout.document.state) });
    const preference = (name, value) => {
      let row = rows.find(row => row.kind === 'setting' && row.name === name);
      if (!row) { row = { id: name, kind: 'setting', name, tool: '', revision: 0 }; rows.push(row); }
      row.content = { value }; row.revision++;
      return row;
    };
    await context.route('**/api/advanced-charts/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const endpoint = url.pathname.replace('/api/advanced-charts', '');
      if (endpoint === '/preferences/migrate') return route.fulfill({ json: { migrated: 0 } });
      if (endpoint === '/preferences' && req.method() === 'GET') return route.fulfill({ json: rows });
      if (endpoint === '/preferences/save') {
        const body = req.postDataJSON(); writes.push(clone(body));
        let row = rows.find(r => r.kind === body.kind && r.name === body.name && (r.tool || '') === (body.tool || ''));
        if (!row) { row = { id: String(rows.length).padStart(64, '0'), revision: 0 }; rows.push(row); }
        Object.assign(row, body, { revision: row.revision + 1 });
        return route.fulfill({ json: row });
      }
      if (endpoint === '/workspaces' || endpoint === '/native-charts') return route.fulfill({ json: [meta()] });
      if (endpoint === `/native-charts/${fakeId}`) return route.fulfill({ json: meta() });
      if (endpoint === '/native-charts/save') {
        const body = req.postDataJSON(); nativeSaves++;
        layout = { ...layout, revision: layout.revision + 1, document: { ...layout.document,
          state: JSON.parse(body.content), symbol: body.symbol, interval: body.resolution } };
        return route.fulfill({ json: meta() });
      }
      if (req.method() !== 'GET') throw Error('Unexpected write: ' + endpoint);
      return route.continue();
    });
    const setLegacy = (theme, background) => {
      delete layout.document.state._mwTheme;
      layout.document.theme = theme;
      for (const chart of layout.document.state.charts) {
        chart.chartProperties.paneProperties.backgroundType = 'solid';
        chart.chartProperties.paneProperties.background = background;
        chart.chartProperties.paneProperties.backgroundGradientStartColor = background;
        chart.chartProperties.paneProperties.backgroundGradientEndColor = background;
        chart.chartProperties.scalesProperties.textColor = theme === 'Light' ? '#0F0F0F' : '#B8B8B8';
      }
    };
    const reload = async () => { await page.reload(); await wait(); };
    preference('mw.autoSave', false);
    preference('mw.theme', 'Dark'); preference('current_theme.name', 'light');
    setLegacy('Light', '#ffffff');
    await reload();
    const corrected = await checkTheme('Dark', '#0F0F0F', 'dark remembered theme must override legacy white canvas');
    record('legacy white layout + remembered Dark restores canvas, axes, toolbar, host and data center together');

    // Toggle via the actual hamburger menu, then refresh without saving layout.
    for (const theme of ['Light', 'Dark']) {
      await frames.native().getByRole('button', { name: /图表菜单/ }).click();
      const toggle = frames.native().getByRole('switch', { name: '暗色主题', exact: true });
      await toggle.click();
      await expect.poll(() => rows.find(row => row.name === 'mw.theme').content.value).toBe(theme);
      await page.keyboard.press('Escape');
      const saves = nativeSaves;
      await reload();
      await checkTheme(theme, theme === 'Dark' ? '#0F0F0F' : '#ffffff', 'menu choice survives refresh without a layout save');
      expect(nativeSaves).toBe(saves);
      record(`${theme}: menu choice persists with layout autosave off`);
    }

    // Save a custom background in the selected theme; restoring must leave it.
    await frames.host().evaluate(() => widget.applyOverrides({
      'paneProperties.backgroundType': 'solid', 'paneProperties.background': '#182736',
      'mainSeriesProperties.candleStyle.upColor': '#22aa88', 'scalesProperties.fontSize': 14,
    }));
    await saveLayout();
    expect(layout.document.state._mwTheme).toBe('Dark');
    await reload();
    const custom = await checkTheme('Dark', '#182736', 'same-theme saved customization survives refresh');
    expect(custom.charts[0].chartProperties.scalesProperties.fontSize).toBe(14);
    expect(custom.charts[0].panes.flatMap(p => p.sources).find(s => s.type === 'MainSeries').state.candleStyle.upColor).toBe('#22aa88');
    record('same-theme custom canvas, candle color and axis font survive native save/reload');

    // Legacy custom backgrounds have no marker and must remain editable.
    delete layout.document.state._mwTheme;
    await reload();
    await checkTheme('Dark', '#182736', 'legacy custom canvas is preserved');
    record('unmarked custom canvas is preserved during legacy repair');

    await saveLayout();
    setLegacy('Light', '#ffffff');
    layout.document.state._mwTheme = 'Light';
    await frames.host().evaluate(meta => widget.loadChartFromServer(meta), { id: fakeId, name: layout.name });
    await wait();
    await checkTheme('Dark', '#0F0F0F', 'native in-place layout load follows current remembered theme');
    record('in-place native layout load restores current theme with no iframe recreation');

    // Multi-chart old layouts must restore every pane, including a nonactive one.
    layout.document.state = clone(corrected);
    layout.document.state.charts = [clone(corrected.charts[0]), clone(corrected.charts[0])];
    layout.document.state.layout = '2h';
    preference('mw.theme', 'Light'); preference('current_theme.name', 'dark');
    setLegacy('Dark', '#0F0F0F'); await reload();
    expect(await frames.host().evaluate(() => widget.chartsCount())).toBe(2);
    await checkTheme('Light', '#ffffff', 'all panes follow remembered theme');
    record('legacy dark two-chart layout restores Light across both panes');
    await page.screenshot({ path: path.join(art, 'theme-restore-light.png') });
    layout.document.state._mwTheme = 'Dark';
    await reload();
    await checkTheme('Light', '#ffffff', 'marked layout theme cannot override current account choice');
    record('marked older layout restores the newer remembered theme across both panes');

    rows = rows.filter(row => row.name !== 'mw.theme');
    preference('current_theme.name', 'dark');
    setLegacy('Light', '#ffffff'); await reload();
    await checkTheme('Dark', '#0F0F0F', 'native saved theme is a fallback for old accounts');
    record('old native theme preference remains usable when mw.theme is absent');
    expect(writes.some(row => row.name === 'mw.theme' && row.content.value === 'Dark')).toBeTruthy();
    expect(report.errors).toEqual([]); report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'theme-restore-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, 'theme-restore-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
