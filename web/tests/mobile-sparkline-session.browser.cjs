// Built mobile UI and explicit HTTP/SSE fixtures; no real-user writes or clock changes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, expect } = require('@playwright/test');
const dist = path.resolve('dist');
const output = process.env.MOBILE_SESSION_OUTPUT || '/tmp/mw-sparkline-session-20261114';
fs.mkdirSync(output, { recursive: true });
const day = 86400000, minute = 60000;
const ids = ['MWP:NVDA', 'MWP:EURUSD', 'MWH:11111111-1111-4111-8111-111111111111', 'MWP:DAILY', 'MWC:' + 'a'.repeat(64)];
let now = Date.parse('2026-11-13T20:59:59Z'), close = now + 1000;
let currentFX = false, emptyFX = false, unavailableFX = false, failed = false, unavailableComposite = false;
let reads = 0, prepares = 0, logged = false, calendarReady = false;
const errors = [], streams = new Set(), subscriptions = new Map();
const fxLeft = Date.parse('2026-11-12T22:00:00Z');
const prefs = { kind: 'setting', name: 'mw.watchlists.v1', tool: '', revision: 1,
  content: { value: { active: 'a', lists: [{ id: 'a', title: '验收', symbols: ids }] } } };
function item(ticker) {
  const base = { ticker, revision: null, timeframe: 'M1', status: 'partial', reason: null,
    reference_times: [], valid_until: now + 14 * day, next_check_at: now + minute,
    identity_key: ticker + ':fixture', session_open_price: '100' };
  if (ticker === ids[0]) {
    const date = new Date(now).toISOString().slice(0, 10), left = Date.parse(date + 'T14:30:00Z');
    return { ...base, stock_session: true, display_state: !calendarReady ? 'unknown' : now >= close ? 'closed' : 'current',
      session: { date, previous: false }, window_start: left, window_end: close,
      target_window_start: left, target_window_end: close,
      next_check_at: calendarReady && now < close ? close : now + minute,
      points: Array.from({ length: Math.floor((Math.min(now, close) - left) / (5 * minute)) }, (_, i) => ({
        time: left + i * 5 * minute, price: String(100 + Math.sin(i / 8) * .5 + i / 100), gap_before: false })),
      last_data_at: Math.min(now, close) - minute };
  }
  if (ticker === ids[1]) {
    const left = currentFX ? fxLeft : fxLeft - day;
    const value = { ...base, window_start: left, window_end: left + day,
      target_window_start: fxLeft, target_window_end: fxLeft + day,
      display_state: currentFX ? 'current' : 'previous', session_open_price: currentFX ? null : '1.1',
      session: { date: new Date(left).toISOString().slice(0, 10), previous: !currentFX },
      points: currentFX ? [{ time: left + minute, price: '1.12', gap_before: false }] :
        [{ time: left, price: '1.1', gap_before: false }, { time: left + minute, price: '1.11', gap_before: false },
         { time: left + 5 * minute, price: '1.105', gap_before: true },
         ...Array.from({ length: 60 }, (_, i) => ({ time: left + (120 + i * 20) * minute,
           price: String(1.105 + Math.sin(i / 7) * .003), gap_before: false }))], last_data_at: left + minute };
    if (emptyFX || unavailableFX) return { ...value, points: [], status: unavailableFX ? 'unavailable' : 'empty',
      window_start: fxLeft, window_end: fxLeft + day, reason: unavailableFX ? 'fixture reclaimed' : null };
    return value;
  }
  if (ticker === ids[2]) {
    const left = Math.floor((now - 45 * day) / day) * day;
    return { ...base, identity_key: undefined, revision: { history_version_id: ticker.slice(4) },
      window_start: left, window_end: left + day, target_window_start: Math.floor(now / day) * day,
      target_window_end: Math.floor(now / day) * day + day, display_state: 'historical',
      session: { date: new Date(left).toISOString().slice(0, 10), previous: true },
      points: Array.from({ length: 60 }, (_, i) => ({ time: left + (1 + i * 20) * minute,
        price: String(100 + Math.sin(i / 7) * .5), gap_before: false })), session_open_price: null };
  }
  if (ticker === ids[4]) return { ...base, revision: unavailableComposite ? null : { composite_revision_id: 'revision-a', input_revision: 1 },
    window_start: fxLeft - day, window_end: fxLeft, target_window_start: fxLeft, target_window_end: fxLeft + day,
    display_state: 'previous', session: { date: '2026-11-11', previous: true },
    status: unavailableComposite ? 'unavailable' : 'partial', points: unavailableComposite ? [] : [{ time: fxLeft - day, price: '100', gap_before: false }],
    reason: unavailableComposite ? 'fixture invalid revision cache' : null };
  const left = Math.floor(now / day) * day;
  return { ...base, points: [], status: 'empty', display_state: 'unsupported',
    window_start: left, window_end: close, target_window_start: left, target_window_end: close,
    reason: '此品种没有日内产物' };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {}, p = url.pathname;
  const json = (value, status = 200) => { if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (p === '/api/session') return json(logged ? { csrf: 'fixture', subject: 'admin' } : {}, logged ? 200 : 401);
  if (p === '/api/login') { logged = true; return json({ csrf: 'fixture', subject: 'admin' }); }
  if (p === '/api/advanced-charts/preferences') return json([prefs]);
  if (p === '/api/market-data/quotes') return json(body.symbols.map(n => ({ n, s: 'ok', ...(n === ids[4] ? { snapshot: { revision_id: 'revision-a' } } : {}),
    v: { short_name: n === ids[0] ? 'NVDA' : n === ids[1] ? 'EURUSD' : n === ids[2] ? 'HISTORY' : 'DAILY',
      description: n === ids[0] ? '英伟达 · 原生 · Yahoo' : '测试 · 原生 · Yahoo',
      lp: n === ids[1] ? 1.11 : 101, chp: 1, fetch_status: 'ok', prev_close_price: n === ids[1] ? 1.1 : 99, read_at: now } })));
  if (p === '/api/market-data/sparklines') { reads++;
    if (failed) return json({ detail: 'fixture offline' }, 503);
    return json({ as_of: now, items: body.items.map(row => item(row.ticker)) }); }
  if (p === '/api/market-data/sparklines/prepare') { prepares++; if (body.ticker === ids[0]) calendarReady = true;
    return json({ as_of: now, items: [item(body.ticker)], preparation: body.ticker === ids[3] ? 'unsupported' : 'ready' }); }
  if (p === '/api/charts/stream/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    streams.add(res); res.write('event: heartbeat\ndata: {}\n\n'); res.on('close', () => streams.delete(res)); return;
  }
  if (p.startsWith('/api/charts/stream/')) {
    if (p.endsWith('/subscribe')) subscriptions.set(body.listener, body);
    if (p.endsWith('/unsubscribe')) subscriptions.delete(body.listener);
    return json({ ok: true });
  }
  if (p === '/api/health') return json({});
  if (p === '/api/notification-center/events' || p === '/api/notification-center/changes') return json({ events: [], changes: [], more: false, unread: 0, epoch: 'fixture', after: null });
  if (p.startsWith('/api/')) return json({ detail: 'fixture unavailable' }, 404);
  let file = path.join(dist, decodeURIComponent(p));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'm/index.html');
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const row = i => page.locator('.mobile-watch-row').nth(i), spark = i => row(i).locator('.mobile-spark');
  const refresh = async () => { const before = reads;
    await page.getByRole('link', { name: '更多', exact: true }).click();
    await page.getByRole('link', { name: '自选', exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(before); };
  try {
    await page.clock.setFixedTime(new Date(now));
    await page.goto('http://127.0.0.1:' + server.address().port + '/m/watch');
    await page.getByLabel('密码', { exact: true }).fill('fixture');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(row(0).locator('svg path[stroke]')).toHaveCount(1);
    await expect(spark(0)).not.toHaveAttribute('data-previous-session');
    const reference = await row(0).locator('.mobile-spark-previous-close').getAttribute('y1');
    const oldFX = await spark(1).locator('svg').innerHTML();
    await expect(spark(1)).toHaveAttribute('data-previous-session', 'true');
    await expect(row(1).locator('.mobile-spark-session-open')).toHaveCount(1);
    await expect(row(2).locator('.mobile-spark-history-date')).toContainText('历史 ·');
    await expect(row(2).locator('.mobile-spark-session-open')).toHaveCount(0);
    await expect(spark(3)).toContainText('暂无日内数据');
    await expect.poll(() => calendarReady).toBe(true);
    now = close; await page.clock.setFixedTime(new Date(now));
    // The existing next-boundary timer must recolor without SSE or manual navigation.
    await expect(spark(0)).toHaveAttribute('data-previous-session', 'true', { timeout: 5000 });
    assert.equal(await row(0).locator('.mobile-spark-previous-close').getAttribute('y1'), reference);
    const stableReads = reads; await page.waitForTimeout(1200);
    assert.equal(reads, stableReads, 'closed boundary must not create a request loop');
    await page.screenshot({ path: output + '/ordinary-close.png' });
    emptyFX = true; await refresh();
    await expect(spark(1).locator('svg')).toHaveCount(1);
    assert.equal(await spark(1).locator('svg').innerHTML(), oldFX, 'empty success retains the original axis and gaps');
    emptyFX = false; currentFX = true;
    const sub = [...subscriptions.values()].find(value => value.query.instrument === 'EURUSD');
    assert(sub, 'EURUSD has a live quote listener');
    for (const stream of streams) stream.write('data: ' + JSON.stringify({ listener: sub.listener, generation: sub.generation, sequence: 1,
      type: 'quotes', quotes: [{ s: 'ok', v: { short_name: 'EURUSD', lp: 1.12, chp: 1, fetch_status: 'ok', quote_time: now, read_at: now } }] }) + '\n\n');
    await expect(spark(1)).not.toHaveAttribute('data-previous-session');
    await expect(spark(1).locator('path[stroke]')).toHaveCount(2); // First real minute plus the much later quote, with a real gap.
    await expect(row(1).locator('.mobile-spark-session-open')).toHaveCount(0);
    await page.screenshot({ path: output + '/first-current-point.png' });
    failed = true; await refresh();
    await expect(spark(1)).toHaveAttribute('data-cached', 'true');
    failed = false; unavailableFX = true; await refresh();
    await expect(spark(1)).toContainText('走势不可用');
    unavailableFX = false; unavailableComposite = true; await refresh();
    await expect(spark(4)).toContainText('走势不可用');
    for (const width of [375, 412]) for (const theme of ['light', 'dark']) for (const font of [14, 21]) {
      await page.setViewportSize({ width, height: 915 });
      await page.evaluate(({ theme, font }) => { document.querySelector('.mobile-app').dataset.theme = theme;
        document.documentElement.style.fontSize = font + 'px'; }, { theme, font });
      await page.waitForTimeout(250);
      assert(await row(2).evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'history label fits the row');
      await page.screenshot({ path: output + '/history-' + width + '-' + theme + '-' + font + '.png' });
    }
    // Same behavior for a dated early-close source session, never a hard-coded 16:00.
    now = Date.parse('2026-11-27T17:59:59Z'); close = now + 1000; calendarReady = false;
    await page.clock.setFixedTime(new Date(now)); await refresh();
    await expect(spark(0)).not.toHaveAttribute('data-previous-session');
    now = close; await page.clock.setFixedTime(new Date(now));
    await expect(spark(0)).toHaveAttribute('data-previous-session', 'true', { timeout: 5000 });
    await page.screenshot({ path: output + '/early-close.png' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, reads, prepares, output,
      checks: ['ordinary and early-close timers after prepared session evidence', 'same-day reference unchanged', 'previous axis and gaps retained',
        'real first-current quote rechecks once', 'empty success preserves curve', 'explicit unavailable clears native and revision-fenced composite curves',
        'network failure marks cache', 'old fixed history date', 'missing open is not fabricated', '375/412 themes and 150% type'] }));
  } finally {
    await context.close(); await browser.close();
    for (const stream of streams) stream.end();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
