// Built login entry with explicit API doubles. No device/production acceptance.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, expect } = require('@playwright/test');
const dist = path.resolve('dist'), out = process.env.MOBILE_LOGIN_OUTPUT || '/tmp/mw-login-round1';
fs.mkdirSync(out, { recursive: true });
let logged = false, mode = 'wrong', holdSession = true, releaseSession, pendingLogin;
const requests = [], errors = [], streams = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for await (const _ of req) { /* consume without recording credentials */ }
  const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: req.method });
  if (url.pathname === '/api/session') {
    if (holdSession) await new Promise(resolve => releaseSession = resolve);
    return logged ? json({ csrf: 'test', subject: 'admin' }) : json({}, 401);
  }
  if (url.pathname === '/api/login') {
    if (mode === 'hold') { pendingLogin = () => { logged = true; json({ csrf: 'test', subject: 'admin' }); }; return; }
    if (mode === 'network') { res.destroy(); return; }
    if (mode === 'wrong') return json({ detail: 'invalid password' }, 401);
    if (mode === 'server') return json({ detail: '服务暂时不可用，请稍后重试' }, 503);
    if (mode === 'throttle') return json({ detail: '请求过于频繁，请稍后重试' }, 429);
    logged = true; return json({ csrf: 'test', subject: 'admin' });
  }
  if (url.pathname === '/api/logout') { logged = false; return json({ ok: true }); }
  if (url.pathname === '/api/advanced-charts/preferences') return json([]);
  if (url.pathname === '/api/market-data/series/page') return json({ items: [], next_offset: null });
  if (url.pathname === '/api/health') return json({ version: 'fixture', chart_alerts: {} });
  if (url.pathname === '/api/notification-center/snapshot') return json({ events: [], cursor: 'test' });
  if (url.pathname === '/api/notification-center/events') return json({ events: [], before: null });
  if (url.pathname === '/api/charts/stream/events') {
    streams.add(res); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: heartbeat\ndata: {}\n\n'); res.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/charts/stream/')) return json({ ok: true });
  if (url.pathname.startsWith('/api/')) return json({ detail: 'Unexpected fixture API ' + url.pathname }, 404);
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && url.pathname.startsWith('/m/')) file = path.join(dist, 'm/index.html');
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' }), page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const proof = { checks: [], layouts: [], screenshots: [], errors };
  const input = () => page.getByLabel('密码', { exact: true });
  const login = () => page.getByRole('button', { name: '登录', exact: true });
  const back = () => page.evaluate(() => dispatchEvent(new Event('mw-mobile-back', { cancelable: true })));
  const settle = async () => { await page.waitForTimeout(350); await page.evaluate(async () => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))); };
  const audit = async () => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
    const old = await page.locator('.mobile-login button:visible, .mobile-login input:visible').evaluateAll(els => els.filter(el => !el.dataset.slot && !el.dataset.variant).map(el => el.outerHTML));
    assert.deepEqual(old, [], 'visible login controls use shadcn');
  };
  const shot = async name => { await settle(); await audit(); await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true }); proof.screenshots.push(name + '.png'); };
  const signIn = async () => { mode = 'success'; await input().fill('fixture-only'); await login().click(); await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible(); };
  const signOut = async () => { await page.getByRole('link', { name: '更多', exact: true }).click(); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(login()).toBeEnabled(); if (await page.getByRole('button', { name: '关闭通知', exact: true }).count()) await page.getByRole('button', { name: '关闭通知', exact: true }).click(); };
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/m/');
    await expect(page.getByRole('button', { name: '正在核验连接…', exact: true })).toBeDisabled();
    assert.equal(await input().evaluate(el => document.activeElement === el), false, 'no initial keyboard autofocus');
    await shot('checking-dark-412'); holdSession = false; releaseSession(); await expect(login()).toBeEnabled();
    const posts = () => requests.filter(r => r.path === '/api/login').length;
    const emptyBefore = posts(); await login().click(); assert.equal(posts(), emptyBefore); assert.equal(await input().evaluate(el => el.validity.valueMissing), true);
    await input().fill('fixture-only'); await page.getByRole('button', { name: '显示密码', exact: true }).click(); await expect(input()).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: '隐藏密码', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click(); await expect(input()).toHaveAttribute('type', 'password');
    await login().click(); await expect(page.locator('#login-password-error')).toHaveText('密码不正确，请重新输入。');
    await expect(input()).toHaveValue('fixture-only'); await expect(input()).toHaveAttribute('aria-invalid', 'true');
    assert.equal(await page.locator('.mobile-toast').count(), 0); await shot('password-error-dark-412');
    await input().fill('retry-only'); await expect(page.locator('#login-password-error')).toHaveCount(0);
    for (const failure of ['network', 'server', 'throttle']) {
      mode = failure; await login().click(); await expect(page.locator('.login-feedback')).toBeVisible(); await expect(login()).toBeEnabled(); await expect(input()).toHaveValue('retry-only'); await shot('error-' + failure);
    }
    await page.getByRole('button', { name: '重新连接', exact: true }).click(); await expect(login()).toBeEnabled(); await expect(input()).toHaveValue('retry-only'); await expect(page.locator('.login-feedback')).toHaveCount(0);
    proof.checks.push('initial session probe; required validation; reveal/hide; inline password/network/503/429 errors; retry retains input; shadcn runtime audit');
    await back(); await expect(page.getByRole('alertdialog', { name: '放弃密码输入？' })).toBeVisible(); await shot('discard-confirm-dark');
    await back(); await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(input()).toHaveValue('retry-only');
    await back(); await page.getByRole('button', { name: '放弃输入', exact: true }).click(); await expect(input()).toHaveValue('');
    await input().fill('switch-only'); await page.getByRole('button', { name: '换服务器', exact: true }).click(); await expect(page.getByRole('alertdialog', { name: '更换服务器？' })).toBeVisible();
    await page.getByRole('button', { name: '继续输入', exact: true }).click(); await expect(input()).toHaveValue('switch-only');
    await page.getByRole('button', { name: '换服务器', exact: true }).click(); await page.getByRole('button', { name: '更换服务器', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更换服务器', exact: true })).toBeVisible(); await expect(input()).toHaveValue(''); await shot('browser-server-help'); await back(); await expect(page.getByRole('dialog')).toHaveCount(0);
    mode = 'hold'; await input().fill('pending-only'); await login().click(); await expect.poll(() => Boolean(pendingLogin)).toBe(true);
    await expect(input()).toBeDisabled(); await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeDisabled();
    const one = posts(); await page.locator('.login-form').evaluate(el => { el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); assert.equal(posts(), one);
    await back(); await expect(page.getByRole('alertdialog')).toHaveCount(0); await shot('submitting-dark-412');
    await page.evaluate(() => dispatchEvent(new Event('online'))); await expect(page.locator('.login-submit')).toBeEnabled(); pendingLogin(); pendingLogin = undefined; await page.waitForTimeout(100); await expect(input()).toBeVisible();
    logged = false; await input().fill('pending-switch'); await login().click(); await expect.poll(() => Boolean(pendingLogin)).toBe(true);
    await page.getByRole('button', { name: '换服务器', exact: true }).click(); await expect(page.getByRole('dialog', { name: '更换服务器', exact: true })).toBeVisible();
    await expect(page.locator('.login-submit')).toBeEnabled(); pendingLogin(); pendingLogin = undefined; await page.waitForTimeout(100); await expect(input()).toBeVisible(); await back();
    proof.checks.push('shared discard and switch confirmations; back cancels top layer; browser server help Drawer; busy/duplicate fencing; online/server switch abort pending login; late success ignored');
    logged = false;
    for (const theme of ['dark', 'light']) {
      await signIn(); await page.getByRole('link', { name: '更多', exact: true }).click();
      if (await page.locator('.mobile-app').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /显示主题/ }).click();
      await signOut(); await expect(page.locator('.mobile-app')).toHaveAttribute('data-theme', theme);
      for (const width of [375, 412]) for (const font of [14, 21]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 915 }); await page.evaluate(f => document.documentElement.style.fontSize = f + 'px', font);
        await shot(`login-${theme}-${width}-${font}`);
        const metrics = await page.locator('.login-password, .login-submit, .login-actions button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, overflow: el.scrollWidth > el.clientWidth, scroll: el.scrollWidth, client: el.clientWidth, children: [...el.children].map(c => ({tag:c.tagName,x:c.getBoundingClientRect().x,width:c.getBoundingClientRect().width,scroll:c.scrollWidth})) }; }));
        assert(metrics.every(r => r.height >= 44 && !r.overflow), JSON.stringify({theme,width,font,metrics})); proof.layouts.push({ theme, width, font, metrics });
      }
      await page.setViewportSize({ width: 375, height: 430 }); await input().fill('keyboard-layout'); await input().focus(); await shot('focused-small-' + theme);
      await login().scrollIntoViewIfNeeded(); assert(await login().evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
      await input().fill(''); await input().blur(); await page.evaluate(() => document.documentElement.style.fontSize = '14px'); await page.setViewportSize({ width: 412, height: 915 });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.login-content').evaluate(el => getComputedStyle(el).animationName), 'none');
    await signIn(); await page.evaluate(() => dispatchEvent(new Event('mw-session-expired'))); await expect(login()).toBeEnabled(); await expect(input()).toHaveValue('');
    proof.checks.push('success/logout/expiry; actual app theme flow; 375/412 two themes 150% text; small viewport focused-input submit reachable; reduced motion (browser only)');
    // Separate native bridge fixture: only a mock host action, no real server change.
    logged = false; const native = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 375, height: 812 } });
    await native.addInitScript(() => { window.nativeActions = []; window.MWMobileHost = { postMessage(raw) { window.nativeActions.push(JSON.parse(raw).action); } }; });
    const np = await native.newPage(); np.on('pageerror', e => errors.push(e.message)); await np.goto('http://127.0.0.1:' + server.address().port + '/m/'); await expect(np.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    await np.getByRole('button', { name: '换服务器', exact: true }).click(); await expect.poll(() => np.evaluate(() => window.nativeActions.includes('configure'))).toBe(true);
    assert.equal(await np.getByRole('dialog').count(), 0); await native.close(); proof.checks.push('native bridge receives configure; browser-only help is not opened');
    const writes = requests.filter(r => r.method !== 'GET' && !['/api/login', '/api/logout'].includes(r.path) && !r.path.startsWith('/api/charts/stream/'));
    assert.deepEqual(writes, []); assert.deepEqual(errors, []); proof.forbiddenWrites = writes;
    fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify({ checks: proof.checks, errors, out }, null, 2));
  } catch (e) { console.error('LOGIN FAILURE', await page.locator('body').innerText()); throw e; }
  finally { for (const s of streams) s.end(); await context.close(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
