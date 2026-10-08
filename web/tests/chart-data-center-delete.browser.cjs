const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; read-only existing dataset and intercepted destructive commands',
  project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const commands = [], unexpected = [];
  let id, detail, state, mock = false, release = () => {}, held = null;
  const record = name => { report.checks.push({ name }); console.log('PASS', name); };
  const reset = overrides => {
    state = { paused: false, archived: false, configured: true, refs: [], targets: 1,
      revision: 'initial', conflict: false, archiveFails: false, ...overrides };
    commands.length = 0;
  };
  const references = () => ({
    items: state.refs, can_reclaim: state.paused && state.archived && !state.refs.length,
    requires_archive: !(state.paused && state.archived), retains: '来源身份与发布清单保留',
    impact: {
      dataset: { ...detail, identity: detail.identity },
      review_revision: state.revision, space_meaning: '数据库空间可供后续写入复用',
      versions: state.targets ? [{ version_id: 'f'.repeat(64), start: 0, end: 120000,
        status: 'published', disposition: state.refs.length ? 'protected' : 'delete_payload',
        observed_minutes: 2, unknown_minutes: 0,
        periods: [{ timeframe: 'M1', status: 'published', rows: 2 }] }] : [],
      payload_totals: { target_versions: state.targets, inline_m1_payload_bytes: 100,
        period_payload_bytes: 50, indicator_payload_bytes: 0, unique_source_payload_bytes: 100,
        retained_shared_source_blobs: 1, retained_shared_source_payload_bytes: 100 },
    },
  });
  // Block dataset mutations before opening any deletion UI. Never
  // forward a destructive test request to an existing acceptance dataset.
  await page.route('**/api/market-data/**', async route => {
    const request = route.request(), url = new URL(request.url()).pathname;
    // These chart read APIs use POST for symbol/quote batches.
    if (url === '/api/market-data/resolve' || url === '/api/market-data/quotes')
      return route.continue();
    if (request.method() === 'GET') {
      if (mock && url === `/api/market-data/datasets/${id}/references`)
        return route.fulfill({ json: references() });
      if (mock && url === `/api/market-data/center/datasets/${id}`)
        return route.fulfill({ json: { ...detail, maintenance: { ...detail.maintenance,
          configured: state.configured, paused: state.paused, archived: state.archived } } });
      return route.continue();
    }
    if (mock && url === `/api/market-data/datasets/${id}/maintenance/control`) {
      const { action } = request.postDataJSON(); commands.push({ action });
      if (action === 'pause') { if (held) await held; state.paused = true; }
      else if (action === 'archive') {
        if (state.archiveFails) return route.fulfill({ status: 503, json: { detail: '验收注入：归档暂不可用' } });
        state.archived = true;
      } else unexpected.push(url + ':' + action);
      state.revision = `${state.paused}:${state.archived}`;
      return route.fulfill({ json: { configured: true, paused: state.paused, archived: state.archived } });
    }
    if (mock && url === `/api/market-data/datasets/${id}/reclaim`) {
      const body = request.postDataJSON(); commands.push({ action: 'reclaim', ...body });
      if (held) await held;
      if (state.conflict) {
        state.refs = [{ kind: 'workspace', id: 'new-workspace', detail: '验收注入：新保存的图表工作区' }];
        state.revision = 'changed-reference';
        return route.fulfill({ status: 409, json: { detail: { code: 'RECLAMATION_CHANGED',
          message: '回收影响或引用已变化，所列数据未删除；请重新查看影响并核对。' } } });
      }
      state.targets = 0; state.revision = 'reclaimed';
      return route.fulfill({ json: { versions: 1 } });
    }
    unexpected.push(request.method() + ' ' + url);
    return route.fulfill({ status: 400, json: { detail: '验收禁止转发数据写入' } });
  });
  const enter = async () => {
    await center().locator(`#dataset-${id}`).getByRole('link', { name: '删除历史数据', exact: true }).click();
    await expect(center().getByRole('heading', { name: '删除历史数据', exact: true })).toBeVisible();
    await expect(center().getByRole('heading', { name: '删除影响清单', exact: true })).toBeVisible();
  };
  const back = async () => {
    await center().getByRole('link', { name: '返回数据中心列表', exact: true }).click();
    await expect(center().locator(`#dataset-${id}`)).toBeVisible();
  };
  try {
    await page.goto(base + '/market-data?tab=managed&page=1');
    await fixture.login(page);
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeTruthy();
    await expect(center().getByRole('heading', { name: '自建行情', exact: true })).toBeVisible();
    const first = center().locator('tbody tr').first();
    await expect(first).toBeVisible();
    const link = first.getByRole('link', { name: '删除历史数据', exact: true });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    id = href.match(/datasets\/([a-f0-9]{64})/)[1];
    const params = new URL(href, base).searchParams;
    expect(params.get('return_to')).toBe(`/market-data?tab=managed&page=1#dataset-${id}`);
    const response = await page.request.get(base + '/api/market-data/center/datasets/' + id);
    expect(response.ok()).toBeTruthy(); detail = await response.json();
    await enter();
    expect(commands).toEqual([]); expect(unexpected).toEqual([]);
    await center().getByRole('button', { name: '取消删除', exact: true }).click();
    await expect(center().locator(`#dataset-${id}`)).toBeFocused();
    record('real list exposes deletion; opening/cancelling only reads and restores originating row/page');

    // Keep real navigation/API client/UI; simulate only the selected dataset's
    // server state for destructive, conflict and partial-failure scenarios.
    mock = true; reset(); await enter();
    await expect(center().getByRole('button', { name: '删除所列数据', exact: true })).toBeDisabled();
    held = new Promise(resolve => { release = resolve; });
    await center().getByRole('button', { name: '暂停维护并归档', exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0].action).toBe('pause');
    release(); held = null;
    await expect(center().getByRole('button', { name: '删除所列数据', exact: true })).toBeEnabled();
    expect(commands.map(c => c.action)).toEqual(['pause', 'archive']); expect(state.targets).toBe(1);
    record('archive prerequisite pauses first, prevents repeated commands and never deletes prices');

    held = new Promise(resolve => { release = resolve; });
    await center().getByRole('button', { name: '删除所列数据', exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => commands.length).toBe(3);
    expect(commands[2].expected_review_revision).toBe('true:true');
    expect(commands[2].request_id).toMatch(/^[a-f0-9-]{36}$/);
    release(); held = null;
    await expect(center().getByRole('status').filter({ hasText: '已回收 1' })).toBeVisible();
    expect(commands.filter(c => c.action === 'reclaim')).toHaveLength(1);
    await center().getByRole('button', { name: '返回列表', exact: true }).click();
    record('explicit confirmation submits latest reviewed token once and displays completion');

    reset({ paused: true, archived: true, refs: [{ kind: 'replay', id: 'replay', detail: '固定版本回测' }] });
    await enter();
    await expect(center().getByRole('table', { name: '阻止历史回收的引用与任务' })).toContainText('固定版本回测');
    await expect(center().getByRole('link', { name: '查看历史演练', exact: true })).toBeVisible();
    await expect(center().getByRole('button', { name: '删除所列数据', exact: true })).toBeDisabled();
    expect(commands).toEqual([]); await back(); record('durable references remain visible and block deletion');

    reset({ paused: true, archived: true, targets: 0 }); await enter();
    await expect(center().getByRole('status').filter({ hasText: '没有可删除的历史价格' })).toBeVisible();
    await expect(center().getByRole('button', { name: '删除所列数据', exact: true })).toBeDisabled();
    expect(commands).toEqual([]); await back(); record('empty or already reclaimed history cannot submit deletion');

    reset({ paused: true, archived: true, conflict: true }); await enter();
    await center().getByRole('button', { name: '删除所列数据', exact: true }).click();
    await expect(center().getByRole('alert').filter({ hasText: '回收影响或引用已变化' })).toBeVisible();
    await expect(center().getByRole('table', { name: '阻止历史回收的引用与任务' })).toContainText('新保存的图表工作区');
    await expect(center().getByRole('heading', { name: '删除影响清单' })).toHaveCount(0);
    await center().getByRole('button', { name: '查看回收影响', exact: true }).click();
    await expect(center().getByRole('button', { name: '删除所列数据', exact: true })).toBeDisabled();
    expect(state.targets).toBe(1); await back(); record('review conflict resets confirmation and preserves prices');

    reset({ archiveFails: true }); await enter();
    await center().getByRole('button', { name: '暂停维护并归档', exact: true }).click();
    await expect(center().getByRole('alert').filter({ hasText: '归档暂不可用' })).toBeVisible();
    expect(state.paused).toBe(true); expect(state.archived).toBe(false); expect(state.targets).toBe(1);
    state.archiveFails = false;
    await center().getByRole('button', { name: '暂停维护并归档', exact: true }).click();
    await expect(center().getByRole('button', { name: '删除所列数据', exact: true })).toBeEnabled();
    expect(commands.map(c => c.action)).toEqual(['pause', 'archive', 'pause', 'archive']);
    await back(); record('partial archive failure is visible; idempotent retry never reclaims prices');

    reset({ configured: false }); await enter();
    const maintenance = center().getByRole('link', { name: '查看维护设置', exact: true });
    await expect(maintenance).toBeVisible();
    expect(new URL(await maintenance.getAttribute('href'), base).searchParams.get('return_to')).toContain(`#dataset-${id}`);
    await center().getByRole('link', { name: '查看组合与引用', exact: true }).click();
    await expect(center().getByRole('heading', { name: '引用与历史回收', exact: true })).toBeVisible();
    await center().getByRole('button', { name: '删除历史数据', exact: true }).click();
    await expect(center().getByRole('heading', { name: '删除历史数据', exact: true })).toBeVisible();
    await expect(center().getByRole('heading', { name: '删除影响清单', exact: true })).toBeVisible();
    expect(commands).toEqual([]); record('detail entry and maintenance guidance preserve return context');
    await page.screenshot({ path: path.join(art, 'delete-workflow.png') });
    expect(unexpected).toEqual([]); expect(report.errors).toEqual([]); report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'delete-failed.png') }).catch(() => {});
    throw error;
  } finally {
    release();
    fs.writeFileSync(path.join(art, 'delete-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
