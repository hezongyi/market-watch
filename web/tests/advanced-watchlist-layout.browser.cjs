const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-test-id-widget-type="watchlist">
      <button data-column-type="last_price">最新价</button>
      <div data-symbol-full="MWP:EURUSD"><span class="cell-test last-test">1.12234</span></div>
    </div>`);
    await page.evaluate(() => {
      const NativeObserver = MutationObserver;
      window.observerCalls = 0;
      window.MutationObserver = class extends NativeObserver {
        constructor(callback) {
          super((records, observer) => {
            // Bound a broken observer loop so the regression reports a failure
            // instead of starving the browser and hanging the test runner.
            if (++window.observerCalls > 8) { observer.disconnect(); return; }
            callback(records, observer);
          });
        }
      };
      window.TradingView = {version: () => '6b804c486857f27920cf761aa7eb6e29d9bb6362'};
    });
    await page.addScriptTag({path:path.resolve(__dirname, '../../advanced-host/watchlist-layout.js')});
    await page.evaluate(() => {
      window.layout = MWWatchlistLayout.attach({
        createButton: () => document.createElement('button'), removeButton() {},
      }, error => { throw error; });
    });
    await page.waitForTimeout(50);
    assert.ok(await page.evaluate(() => observerCalls <= 2),
      'numeric quotes must settle; the adapter must not observe its own changes forever');
    const read = () => page.locator('.last-test').evaluate(cell => ({
      text:cell.textContent,raw:cell.dataset.mwRawPrice,sup:cell.querySelector('sup')?.textContent,
      count:cell.querySelectorAll('sup').length,aria:cell.getAttribute('aria-label'),
    }));
    assert.deepEqual(await read(), {text:'1.12234',raw:'1.12234',sup:'4',count:1,aria:'1.12234'});
    await page.evaluate(() => { layout.refresh(); layout.refresh(); });
    assert.equal((await read()).text, '1.12234', 'repeated refresh preserves every digit');
    await page.evaluate(() => { document.querySelector('.last-test').textContent = '1.12250'; });
    await page.waitForTimeout(50);
    assert.deepEqual(await read(), {text:'1.12250',raw:'1.12250',sup:'0',count:1,aria:'1.12250'});
    // React can update a text node while the existing superscript remains.
    await page.evaluate(() => { document.querySelector('.last-test').firstChild.data = '1.1234'; });
    await page.waitForTimeout(50);
    assert.deepEqual(await read(), {text:'1.12340',raw:'1.12340',sup:'0',count:1,aria:'1.12340'});
    await page.evaluate(() => layout.dispose());
    console.log('Watchlist numeric updates settle and retain live values, trailing zero and accessibility.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
