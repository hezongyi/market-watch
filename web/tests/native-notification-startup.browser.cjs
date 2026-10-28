// Real pinned chart library on an isolated Ubuntu preview; never run on production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, expect } = require('@playwright/test');

const base = process.env.MW_BASE_URL;
const credentialsFile = process.env.MW_ACCEPTANCE_CREDENTIALS_FILE;
if (!base || !credentialsFile || !/^https:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))
  throw Error('Set isolated localhost MW_BASE_URL and MW_ACCEPTANCE_CREDENTIALS_FILE');

(async () => {
  const credentials = JSON.parse(fs.readFileSync(credentialsFile));
  const cert = new crypto.X509Certificate(fs.readFileSync(
    credentials.ca_file || path.join(path.dirname(credentialsFile), 'cert.pem')));
  const spki = crypto.createHash('sha256').update(cert.publicKey.export({ format: 'der', type: 'spki' })).digest('base64');
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--ignore-certificate-errors-spki-list=' + spki],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  // Enforce the same public-header readiness boundary that failed in production,
  // using the real widget and native modules rather than a substitute chart.
  await page.addInitScript(() => {
    let surface;
    window.__notificationHeaderChecks = [];
    Object.defineProperty(globalThis, 'nativeNotificationSurface', {
      configurable: true,
      get: () => surface,
      set: implementation => {
        surface = async (widget, report) => {
          const check = { waited: false, ready: false, buttons: 0 };
          window.__notificationHeaderChecks.push(check);
          const proxy = new Proxy(widget, {
            get(target, key) {
              if (key === 'headerReady') return async () => {
                check.waited = true;
                await target.headerReady();
                await new Promise(resolve => setTimeout(resolve, 750));
                check.ready = true;
              };
              if (key === 'createButton') return (...args) => {
                assertHeader();
                check.buttons++;
                return target.createButton(...args);
              };
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          function assertHeader() {
            if (!check.ready) throw Error('Cannot create button: header widget is not ready or is not loaded - use `headerReady` to wait until header is ready');
          }
          return implementation(proxy, report);
        };
      },
    });
  });
  try {
    await page.goto(base + '/advanced-charts/D1_BTCUSDT');
    await page.getByLabel('管理员密码').fill(credentials.login_password);
    const login = page.waitForResponse(r => r.url() === base + '/api/login' && r.request().method() === 'POST');
    await page.getByRole('button', { name: /登录并/ }).click();
    assert.equal((await login).status(), 200);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.frames().some(frame => frame.url().startsWith('blob:')), { timeout: 60000 }).toBe(true);
      const native = page.frames().find(frame => frame.url().startsWith('blob:'));
      const entry = native.getByRole('button', { name: '系统消息', exact: true });
      await expect(entry).toBeVisible({ timeout: 60000 });
      await entry.click();
      await expect(native.locator('[data-name="mw-native-system-message-center"]')).toBeVisible();
      await native.locator('[data-name="mw-native-system-message-center"]').press('Escape');
      const probes = await page.evaluate(() => window.__notificationHeaderChecks);
      assert.ok(probes.length > 0);
      assert.ok(probes.every(probe => probe.waited && probe.ready && probe.buttons > 0), JSON.stringify(probes));
      await expect(page.getByText('图表界面接入未完成，请重新加载。', { exact: true })).toHaveCount(0);
      checks.push({ attempt: attempt + 1, notification_surfaces: probes.length, header_waited: true, panel_opened: true });
    }
    // Also cross the application's 25-second shell timeout after a successful attach.
    await expect.poll(() => page.evaluate(() => performance.now()), { timeout: 35000, intervals: [1000] }).toBeGreaterThan(26000);
    await expect(page.getByText('图表界面接入未完成，请重新加载。', { exact: true })).toHaveCount(0);
    const screenshot = path.join(process.env.MW_SCREENSHOT_DIR || '/tmp', 'mw-notification-startup-fixed-20261028.png');
    await page.screenshot({ path: screenshot });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, errors, screenshot, production_modified: false }));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
