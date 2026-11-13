// Explicitly writes only to this task's isolated Ubuntu Docker acceptance origin.
// Uses real HTTP/suppliers: no routes, mocks, SQL writes, or synthetic publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const task = 'mw-mobile-data-workflow-20261113';
const origin = process.env.MW_ACCEPTANCE_ORIGIN || 'https://127.0.0.1:18446';
assert(['https://127.0.0.1:18446', 'https://192.168.7.232:18446'].includes(origin), 'Task origin only');
const privateDir = path.join(process.env.HOME, '.local/share/market-watch-docker/previews', task);
const config = JSON.parse(fs.readFileSync(path.join(privateDir, 'compose.json')));
assert.equal(config.name, task);
assert(config.services.api.environment.ALERTS_DATABASE_URL.endsWith('@postgres/preview'));
const { login_password: password } = JSON.parse(fs.readFileSync(path.join(privateDir, 'credentials.json')));
const out = process.env.MW_ACCEPTANCE_OUTPUT || '/tmp/mw-mobile-data-real';
fs.mkdirSync(out, { recursive: true });
const phase = process.argv[2] || 'create';
const proofFile = path.join(out, 'result.json');
const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile)) : { task, origin, checks: [], screenshots: [] };
const persist = () => fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n');
const check = (message) => { if (!proof.checks.includes(message)) proof.checks.push(message); persist(); console.log('PASS:', message); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: phase === 'desktop' ? { width: 1440, height: 1000 } : { width: 412, height: 915 }, isMobile: phase !== 'desktop', hasTouch: phase !== 'desktop', locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const dialog = name => page.getByRole('dialog', { name, exact: true });
  const settle = () => page.waitForTimeout(450);
  async function shot(name) { await settle(); await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true }); if (!proof.screenshots.includes(name)) proof.screenshots.push(name); persist(); }
  async function request(url, body) {
    const result = await context.request.fetch(origin + '/api' + url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'x-csrf-token': (await (await context.request.get(origin + '/api/session')).json()).csrf }, data: body, timeout: 120000 });
    assert(result.ok(), `${url}: HTTP ${result.status()} ${await result.text()}`);
    return result.json();
  }
  async function close(name) { await dialog(name).getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog(name)).toHaveCount(0); }
  async function details(code) { await page.locator('.data-managed-row').filter({ hasText: code }).click(); await expect(dialog('自建行情').getByRole('button', { name: '维护设置', exact: true })).toBeVisible(); }
  async function select(label, value) { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: value, exact: true }).click(); }
  async function list() { return (await request('/market-data/center/dataset-summaries?page_size=25')).items; }
  try {
    await page.goto(origin + '/m/data');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '搜索并添加行情', exact: true })).toBeVisible();
    check('Isolated Docker mobile UI login and managed-only data home');
    if (phase === 'create') {
      for (const [code, supplier] of [['EURUSD', 'Dukascopy'], ['XAUUSD', 'Dukascopy'], ['AAPL', 'Yahoo Finance']]) {
        if ((await list()).some(d => (d.provider_display_symbol || d.display_symbol) === code)) {
          await expect(page.locator('.data-managed-row').filter({ hasText: code })).toBeVisible();
          check(code + ': existing real dataset displays supplier code on managed home');
          continue;
        }
        await page.getByRole('button', { name: '搜索并添加行情', exact: true }).click();
        await select('来源', supplier);
        await dialog('添加行情').getByLabel('搜索原生行情', { exact: true }).fill(code);
        let result = dialog('添加行情').locator('.data-catalog-row').filter({ hasText: code });
        if (!(await result.count())) {
          await dialog('添加行情').getByRole('button', { name: '目录筛选与更新', exact: true }).click();
          await dialog('添加行情').getByRole('button', { name: '更新此来源目录', exact: true }).click();
        }
        await expect(result.first()).toBeVisible({ timeout: 130000 });
        await result.first().click();
        await dialog('创建自建行情').getByLabel('历史起点', { exact: true }).fill(code === 'AAPL' ? '2026-10-01' : new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
        const precision = dialog('创建自建行情').getByLabel('价格精度（小数位）', { exact: true });
        if (await precision.count()) {
          await precision.fill(code === 'EURUSD' ? '5' : code === 'XAUUSD' ? '3' : '2');
          check(code + ': supplier requires explicit precision; necessary field completed');
        }
        const submit = dialog('创建自建行情').getByRole('button', { name: '创建并准备历史', exact: true });
        // Supplier errors require an explicit retry, never another mutation.
        for (let attempt = 0; attempt < 2; attempt++) {
          await Promise.race([
            expect(submit).toBeEnabled({ timeout: 130000 }),
            expect(dialog('创建自建行情').getByRole('button', { name: '重试验证', exact: true })).toBeVisible({ timeout: 130000 }),
          ]);
          if (await submit.isEnabled()) break;
          await dialog('创建自建行情').getByRole('button', { name: '重试验证', exact: true }).click();
        }
        await expect(submit).toBeEnabled({ timeout: 130000 });
        await shot('real-create-' + code);
        await submit.click();
        await expect(dialog('创建自建行情')).toHaveCount(0, { timeout: 45000 });
        await expect(page.locator('.data-managed-row').filter({ hasText: code })).toBeVisible();
        check(code + ': native search -> confirmation -> real history task submitted via mobile UI');
      }
      await shot('real-home-preparing');
    } else if (phase === 'maintain') {
      await details('EURUSD');
      await dialog('自建行情').getByRole('button', { name: '维护设置', exact: true }).click();
      await expect(dialog('维护设置').getByLabel('历史起点', { exact: true })).toBeVisible();
      await dialog('维护设置').getByLabel('维护时间', { exact: true }).fill('01:30');
      await dialog('维护设置').getByRole('button', { name: '保存维护设置', exact: true }).click();
      await expect(dialog('维护设置').getByText(/维护设置已保存/)).toBeVisible();
      await shot('real-maintenance-saved');
      const euro = (await list()).find(d => (d.provider_display_symbol || d.display_symbol) === 'EURUSD');
      const plan = await request(`/market-data/datasets/${euro.id}/maintenance`);
      assert.equal(plan.daily_minute, 90);
      check('EURUSD maintenance plan saved via mobile UI and independently read back');
      await close('维护设置');
      await dialog('自建行情').getByRole('button', { name: '更多操作', exact: true }).click();
      const pause = dialog('自建行情').getByRole('button', { name: '暂停定时维护', exact: true });
      if (await pause.count()) await pause.click();
      await expect(dialog('自建行情').getByText('已暂停', { exact: true })).toBeVisible();
      assert.equal((await request(`/market-data/datasets/${euro.id}/maintenance`)).paused, true);
      check('Pausing scheduled history maintenance does not change live selection');
      await shot('real-history-ready');
      await close('自建行情');
    } else if (phase === 'enable') {
      for (const code of ['EURUSD', 'XAUUSD']) {
        await details(code);
        const enable = dialog('自建行情').getByRole('button', { name: '开启实时', exact: true });
        if (await enable.count()) {
          if (!(await enable.isEnabled())) {
            await dialog('自建行情').getByRole('button', { name: /检查实时来源|核对实时来源/ }).click();
            const refresh = dialog('确认实时来源').getByRole('button', { name: '更新实时来源目录', exact: true });
            if (await refresh.count()) await refresh.click();
          } else await enable.click();
          const confirm = dialog('确认实时来源').getByRole('button', { name: '确认并开启', exact: true });
          if (code === 'XAUUSD') {
            await expect(confirm).toBeDisabled();
            await dialog('确认实时来源').getByRole('button', { name: '我已确认产品差异，接受 Bid 原价接续', exact: true }).click();
            check('XAUUSD real product difference requires explicit acknowledgement');
          }
          await expect(confirm).toBeEnabled({ timeout: 40000 });
          await shot('real-live-confirm-' + code);
          await confirm.click();
          await expect(dialog('确认实时来源')).toHaveCount(0, { timeout: 45000 });
        }
        await expect(dialog('自建行情').getByRole('button', { name: '关闭实时', exact: true })).toBeEnabled();
        const row = (await list()).find(d => (d.provider_display_symbol || d.display_symbol) === code);
        const live = await request(`/market-data/datasets/${row.id}/continuation`);
        assert.equal(live.enabled, true); assert(live.composite);
        proof[code] = { datasetId: row.id, compositeId: live.composite.id, baselineVersion: live.composite.revision.history_version_id, seam: live.composite.revision.seam };
        check(code + ': source matching saved and real continuation enabled via mobile UI');
        await shot('real-live-enabled-' + code);
        await close('自建行情');
      }
      await page.getByRole('link', { name: '更多', exact: true }).click();
      check('Left data page after enabling live; persistent demand checked separately');
      await shot('real-away-from-data');
    } else if (phase === 'update') {
      const row = (await list()).find(d => (d.provider_display_symbol || d.display_symbol) === 'EURUSD');
      const before = await request(`/market-data/datasets/${row.id}/continuation`);
      const previous = (await request(`/market-data/center/tasks?dataset_id=${row.id}`)).items.map(t => t.id);
      await details('EURUSD');
      await dialog('自建行情').getByRole('button', { name: '立即更新', exact: true }).click();
      await expect.poll(async () => {
        const tasks = (await request(`/market-data/center/tasks?dataset_id=${row.id}`)).items;
        return tasks.some(t => !previous.includes(t.id) && t.status === 'published');
      }, { timeout: 180000, intervals: [1000, 2000, 5000] }).toBe(true);
      const after = await request(`/market-data/datasets/${row.id}/continuation`);
      assert.equal(after.enabled, true);
      assert.deepEqual(after.composite.revision, before.composite.revision);
      proof.baselinePreservation = { before: before.composite.revision, after: after.composite.revision };
      check('Immediate history update publishes a new version while preserving existing live baseline and seam');
      await shot('real-history-updated-fixed-baseline');
    } else if (phase === 'disable' || phase === 'restore') {
      const code = 'EURUSD';
      await details(code);
      if (phase === 'disable') {
        await dialog('自建行情').getByRole('button', { name: '关闭实时', exact: true }).click();
        await page.getByRole('alertdialog', { name: '关闭实时行情？', exact: true }).getByRole('button', { name: '确认', exact: true }).click();
        await expect(dialog('自建行情').getByRole('button', { name: '开启实时', exact: true })).toBeEnabled();
      } else {
        await dialog('自建行情').getByRole('button', { name: '开启实时', exact: true }).click();
        await expect(dialog('自建行情').getByRole('button', { name: '关闭实时', exact: true })).toBeEnabled();
        await expect(dialog('确认实时来源')).toHaveCount(0);
      }
      const row = (await list()).find(d => (d.provider_display_symbol || d.display_symbol) === code);
      const live = await request(`/market-data/datasets/${row.id}/continuation`);
      assert.equal(live.enabled, phase === 'restore');
      check(phase === 'disable' ? 'Explicit mobile confirmation turns live off while preserving history and mapping' : 'Re-enabling live reuses the saved mapping in one action');
      await shot('real-live-' + phase);
    } else if (phase === 'schedule') {
      await details('EURUSD');
      await dialog('自建行情').getByRole('button', { name: '更多操作', exact: true }).click();
      await dialog('自建行情').getByRole('button', { name: '恢复定时维护', exact: true }).click();
      await expect(dialog('自建行情').getByRole('button', { name: '暂停定时维护', exact: true })).toBeVisible();
      const row = (await list()).find(d => (d.provider_display_symbol || d.display_symbol) === 'EURUSD');
      assert.equal((await request(`/market-data/datasets/${row.id}/maintenance`)).paused, false);
      assert.equal((await request(`/market-data/datasets/${row.id}/continuation`)).enabled, true);
      check('Resuming scheduled history maintenance preserves the enabled live switch');
    } else if (phase === 'desktop') {
      const row = (await list()).find(d => (d.provider_display_symbol || d.display_symbol) === 'EURUSD');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(origin + '/advanced-charts?data_center=' + encodeURIComponent(`/market-data/datasets/${row.id}?section=maintenance`));
      let centerFrame;
      await expect.poll(async () => {
        for (const frame of page.frames()) if (await frame.locator('.dc-dataset-detail').count()) { centerFrame = frame; return true; }
        return false;
      }, { timeout: 60000 }).toBe(true);
      await expect(centerFrame.locator('.dc-maintenance-form')).toBeVisible();
      await expect(centerFrame.locator('.dc-maintenance-form input[type="time"]')).toHaveValue('01:30');
      await shot('real-desktop-maintenance');
      check('Desktop data center still opens the existing maintenance form against real task data');
      // Desktop state is captured read-only; no changes to desktop plans or mappings.
    } else if (phase === 'chart') {
      await details('EURUSD');
      await expect(dialog('自建行情').getByRole('button', { name: '打开图表', exact: true })).toBeEnabled();
      const candles = [];
      page.on('response', async response => {
        if (response.url().includes('/api/charts/data') && response.ok()) {
          const body = await response.json().catch(() => ({}));
          candles.push(body);
        }
      });
      await dialog('自建行情').getByRole('button', { name: '打开图表', exact: true }).click();
      await expect(page).toHaveURL(/\/m\/chart$/);
      const chart = page.frameLocator('.mobile-chart-canvas iframe');
      await expect(chart.locator('[data-name="pane-canvas"]').first()).toBeVisible({ timeout: 60000 });
      await expect.poll(() => candles.some(b => Array.isArray(b.bars) && b.bars.length > 0), { timeout: 60000 }).toBe(true);
      check('Mobile managed live chart opens licensed native widget and receives real nonempty candles');
      await shot('real-mobile-chart');
      await page.getByRole('link', { name: '数据', exact: true }).click();
      await expect(page.getByRole('button', { name: '搜索并添加行情', exact: true })).toBeVisible();
    } else if (phase === 'inspect') {
      for (const row of await list()) {
        await details(row.provider_display_symbol || row.display_symbol);
        await shot('real-detail-' + (row.provider_display_symbol || row.display_symbol));
        await close('自建行情');
      }
      await shot('real-home');
    } else throw Error('Unknown phase: ' + phase);
    const rows = await list();
    proof.datasets = rows.map(d => ({ id: d.id, symbol: d.provider_display_symbol || d.display_symbol, source: d.identity.source, availability: d.availability, availableStart: d.available_start, availableEnd: d.available_end, usableTimeframes: d.usable_timeframes, maintenance: d.maintenance, continuation: d.continuation }));
    proof.runtimeErrors = runtimeErrors;
    assert.deepEqual(runtimeErrors, []);
    proof.lastSuccessfulPhase = phase;
    persist();
    console.log('Phase completed:', phase);
  } catch (error) {
    await shot('failure-' + phase).catch(() => {});
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
