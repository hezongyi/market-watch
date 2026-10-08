const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; comparison with current native indicator dialog', project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { native, host, center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name); };
  try {
    await page.goto(base + '/advanced-charts');
    await fixture.login(page);
    await expect.poll(() => !!native(), { timeout: 30000 }).toBeTruthy();
    await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeVisible({ timeout: 30000 });
    for (const theme of ['Dark', 'Light']) {
      await host().evaluate(theme => widget.changeTheme(theme), theme);
      await expect.poll(() => host().evaluate(() => widget.getTheme())).toBe(theme.toLowerCase());
      await host().evaluate(() => widget.activeChart().executeActionById('insertIndicator'));
      const vendor = native().locator('[data-name="indicators-dialog"]');
      await expect(vendor).toBeVisible();
      const reference = await vendor.evaluate(dialog => {
        const surface = getComputedStyle(dialog.parentElement);
        const header = dialog.firstElementChild, title = header.firstElementChild;
        const titleStyle = getComputedStyle(title);
        return { surface: surface.backgroundColor, radius: surface.borderRadius, shadow: surface.boxShadow,
          font: surface.fontFamily, ink: surface.color, headerHeight: header.getBoundingClientRect().height,
          titleSize: titleStyle.fontSize, titleWeight: titleStyle.fontWeight };
      });
      await page.screenshot({ path: path.join(art, `native-ui-reference-${theme.toLowerCase()}.png`) });
      await host().evaluate(() => widget.closePopupsAndDialogs());
      for (const width of [1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        const indicator = await native().getByRole('button', { name: '指标', exact: true }).boundingBox();
        const button = native().getByRole('button', { name: '数据中心', exact: true });
        const entry = await button.boundingBox();
        await expect(button).toHaveText('数据中心');
        const aligned = await button.evaluate(element => {
          const box = element.getBoundingClientRect(), icon = element.querySelector('svg').getBoundingClientRect();
          return { center: box.y + box.height / 2, icon: icon.y + icon.height / 2 };
        });
        expect(Math.abs(aligned.center - aligned.icon)).toBeLessThanOrEqual(1);
        await expect(native().getByRole('button', { name: '指标', exact: true }).locator('svg path').first()).toHaveAttribute('d', 'm6.5 11.5 5-5 4 4 7-5');
        const search = await native().getByText('行情搜索', { exact: true }).evaluateAll(nodes => {
          const visible = nodes.map(node => ({ node, rect: node.getBoundingClientRect() })).find(({ node, rect }) => {
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return rect.width > 0 && (hit === node || node.contains(hit));
          });
          return visible.rect.toJSON();
        });
        expect(entry.x).toBeGreaterThanOrEqual(indicator.x + indicator.width);
        expect(entry.x + entry.width).toBeLessThanOrEqual(search.x + 1);
        expect(entry.y).toBe(indicator.y);
        await expect(button).toHaveCount(1);
        await button.click();
        await expect.poll(() => !!center()).toBeTruthy();
        await expect(center().getByRole('heading', { name: '自建行情', exact: true })).toBeVisible();
        await expect(center().locator('.dc-table')).toBeVisible();
        await expect(center().locator('.dc-window-header h2 svg')).toHaveAttribute('aria-hidden', 'true');
        await expect(center().locator('.dc-window-header h2')).toHaveText('数据中心');
        // Opening installs theme tokens; buttons inherit a short color transition.
        await expect.poll(() => center().evaluate(() => {
          const ink = getComputedStyle(document.querySelector('.dc-window')).color;
          return [...document.querySelectorAll('.dc-window-nav button')].every(button => getComputedStyle(button).color === ink);
        })).toBeTruthy();
        const actual = await center().evaluate(() => {
          const window = document.querySelector('.dc-window'), style = getComputedStyle(window);
          const header = document.querySelector('.dc-window-header'), title = header.querySelector('h2');
          const selected = document.querySelector('.dc-window-nav [aria-current="page"]');
          return { surface: style.backgroundColor, font: style.fontFamily, ink: style.color,
            headerHeight: header.getBoundingClientRect().height, titleSize: getComputedStyle(title).fontSize,
            titleWeight: getComputedStyle(title).fontWeight, selectedColor: getComputedStyle(selected).color,
            controlColor: getComputedStyle(document.querySelector('.dc-window-nav button:not([aria-current])')).color,
            tableRadius: getComputedStyle(document.querySelector('.dc-table')).borderRadius,
            muted: getComputedStyle(document.querySelector('.dc-subtle')).color };
        });
        expect(actual.surface).toBe(reference.surface);
        expect(actual.font).toBe(reference.font);
        expect(actual.ink).toBe(reference.ink);
        expect(actual.headerHeight).toBe(reference.headerHeight);
        expect(actual.titleSize).toBe(reference.titleSize);
        expect(actual.titleWeight).toBe(reference.titleWeight);
        expect(actual.selectedColor).toBe(actual.ink);
        expect(actual.controlColor).toBe(actual.ink);
        expect(actual.tableRadius).toBe('0px');
        const dialog = await native().locator('.mw-data-center-dialog').evaluate(element => {
          const style = getComputedStyle(element), backdrop = getComputedStyle(element, '::backdrop');
          return { radius: style.borderRadius, shadow: style.boxShadow, border: style.borderWidth, backdrop: backdrop.backgroundColor };
        });
        expect(dialog.radius).toBe(reference.radius);
        expect(dialog.shadow).toBe(reference.shadow);
        expect(dialog.border).toBe('0px');
        expect(dialog.backdrop).toBe('rgba(0, 0, 0, 0)');
        await page.screenshot({ path: path.join(art, `native-ui-center-${theme.toLowerCase()}-${width}.png`) });
        const savedHost = host(), savedNative = native();
        await center().getByRole('button', { name: '平台品种', exact: true }).click();
        await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
        expect(host()).toBe(savedHost); expect(native()).toBe(savedNative);
        await center().getByRole('button', { name: '自建行情', exact: true }).click();
        await center().getByRole('button', { name: '关闭数据中心' }).focus();
        await page.keyboard.press('Shift+Tab');
        expect(await center().evaluate(() => !!document.activeElement.closest('.dc-window'))).toBeTruthy();
        await page.keyboard.press('Escape');
        await expect.poll(() => !!center()).toBeFalsy();
        await expect(button).toBeFocused();
        record(`${theme} ${width}: indicator → data center → search; native dialog style, frame and focus retained`, { reference, actual });
      }
    }
    // Creation order must remain correct after rebuilding the toolbar on reload.
    await page.reload();
    await expect.poll(() => !!native(), { timeout: 30000 }).toBeTruthy();
    await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeVisible({ timeout: 30000 });
    const indicator = await native().getByRole('button', { name: '指标', exact: true }).boundingBox();
    const entry = await native().getByRole('button', { name: '数据中心', exact: true }).boundingBox();
    expect(entry.x - (indicator.x + indicator.width)).toBeGreaterThanOrEqual(0);
    expect(entry.x - (indicator.x + indicator.width)).toBeLessThanOrEqual(12);
    record('reload retains immediate adjacency after indicator');
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'native-ui-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, 'native-ui-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
