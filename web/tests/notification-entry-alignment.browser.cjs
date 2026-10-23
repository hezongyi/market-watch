// Temporary contexts only; badge toggles below are DOM presentation fixtures.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.MW_ALIGNMENT_URL || 'https://localhost:18481';
const target = process.env.MW_ALIGNMENT_WORKSPACE || 'D1_EURUSD';
const credentials = JSON.parse(fs.readFileSync(process.env.MW_ALIGNMENT_CREDENTIALS ||
  '/home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/credentials.json'));
const output = process.env.MW_ALIGNMENT_OUTPUT || path.resolve(__dirname, '../artifacts/notification-alignment');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const report = { base, samples: [], errors: [], badgeSource: 'DOM presentation fixture', passed: false };
  page.on('pageerror', e => report.errors.push(e.message));
  await context.route('**/api/advanced-charts/**', async route => {
    const r = route.request(), pathname = new URL(r.url()).pathname;
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method()) || pathname.endsWith('/preferences/migrate')) return route.continue();
    if (pathname.endsWith('/preferences/save')) {
      const body = r.postDataJSON();
      return route.fulfill({ json: { ...body, id: 'inspection-only', revision: body.revision + 1, updated_at: Date.now() } });
    }
    return route.fulfill({ status: 409, json: { detail: 'Read-only inspection' } });
  });
  const native = () => page.frames().find(f => f.url().startsWith('blob:'));
  const host = () => page.frames().find(f => /\/\?/.test(f.url()) && !f.url().startsWith('blob:'));
  const measure = () => native().evaluate(() => {
    const entry = document.querySelector('.nc-system-entry');
    const watch = document.querySelector('button[data-name="base"][aria-pressed]');
    const geometry = n => {
      const r = n?.getBoundingClientRect();
      return r && { x: r.x, width: r.width, height: r.height, center: r.x + r.width / 2 };
    };
    const a = geometry(entry), b = geometry(watch);
    return { entry: a, watchlist: b, delta: b?.width ? Math.abs(a.center - b.center) : null,
      slotWidth: entry?.parentElement.getBoundingClientRect().width };
  });
  try {
    await page.goto(base + '/advanced-charts/' + target);
    await page.getByLabel('管理员密码').fill(credentials.login_password || credentials.password);
    await page.locator('button.auth-submit').click();
    await expect.poll(() => !!native() && !!host(), { timeout: 60000 }).toBe(true);
    await expect(native().locator('.nc-system-entry')).toBeVisible({ timeout: 60000 });
    const entry = native().locator('.nc-system-entry');
    for (const theme of ['Light', 'Dark']) {
      await host().evaluate(theme => widget.changeTheme(theme), theme);
      await expect.poll(() => native().evaluate(() => document.documentElement.classList.contains('theme-dark'))).toBe(theme === 'Dark');
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect.poll(async () => {
          const m = await measure();
          return m.delta === null ? m.slotWidth === 38 : m.delta <= 1;
        }, { timeout: 15000 }).toBe(true);
        for (const badge of [false, true]) {
          await entry.locator('.nc-entry-count').evaluate((n, show) => { n.hidden = !show; n.textContent = '9'; }, badge);
          const sample = await measure();
          expect(sample.entry.width).toBe(38);
          if (sample.delta !== null) expect(sample.delta).toBeLessThanOrEqual(1);
          report.samples.push({ theme, width, badge, ...sample });
        }
        if (width > 480) {
          const watch = native().locator('button[data-name="base"][aria-pressed]');
          const before = await watch.getAttribute('aria-pressed');
          await watch.focus();
          await watch.press('Enter');
          await expect(watch).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
          await expect.poll(async () => (await measure()).delta).toBeLessThanOrEqual(1);
          report.samples.push({ theme, width, sidebarToggled: true, ...await measure() });
          await watch.press('Enter');
        }
        await entry.hover();
        await expect(entry).toHaveAttribute('data-tooltip', /系统消息/);
        await entry.focus();
        await expect(entry).toBeFocused();
        await entry.press('Enter');
        await expect(entry).toHaveAttribute('aria-expanded', 'true');
        await expect(native().getByRole('button', { name: '关闭系统消息', exact: true })).toBeVisible();
        await entry.press('Enter');
        await expect(entry).toHaveAttribute('aria-expanded', 'false');
        await entry.click();
        await expect(entry).toHaveAttribute('aria-expanded', 'true');
        await entry.click();
        await expect(entry).toHaveAttribute('aria-expanded', 'false');
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.join(output, theme.toLowerCase() + '.png') });
    }
    expect(report.errors).toEqual([]);
    report.passed = true;
    console.log('PASS notification/watchlist centers, desktop/mobile, themes, sidebar, badge, mouse and keyboard');
  } catch (e) { report.failure = e.message; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (!report.passed) console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})();
