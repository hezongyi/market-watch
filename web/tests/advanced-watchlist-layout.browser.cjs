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
      <div style="position:absolute;right:20px;top:20px"><button aria-label="添加商品代码" style="width:28px;height:28px">+</button></div>
      <div class="widgetbar-widgetbody" style="position:absolute;left:300px;top:100px;width:400px;height:200px;contain:strict;overflow:hidden">
      <div id="native-columns"><button data-column-type="short_name">商品</button><button data-column-type="last_price">最新价</button><button class="columnsMenu-test">更多</button></div>
      <div data-symbol-full="MWP:EURUSD"><span class="cell-test last-test"><span class="inner-test">1.12<span class="uptick-test">234</span></span></span></div>
      </div>
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
      // Native controls rely on delegation through their original React root.
      document.querySelector('#native-columns').addEventListener('click', event => {
        if (event.target.closest('.columnsMenu-test')) {
          const menu = document.createElement('div'); menu.setAttribute('role','menu');
          menu.textContent = '成交量'; document.body.append(menu);
        }
      });
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
    await page.evaluate(() => { document.querySelector('.last-test').innerHTML = '<span class="inner-test">1.12<span class="uptick-test">250</span></span>'; });
    await page.waitForTimeout(50);
    assert.deepEqual(await read(), {text:'1.12250',raw:'1.12250',sup:'0',count:1,aria:'1.12250'});
    // React can update a text node while the existing superscript remains.
    await page.evaluate(() => { document.querySelector('.uptick-test').firstChild.data = '340'; });
    await page.waitForTimeout(50);
    assert.deepEqual(await read(), {text:'1.123400',raw:'1.123400',sup:'0',count:1,aria:'1.123400'});
    await page.locator('.columnsMenu-test').click({timeout:1500});
    assert.equal(await page.getByRole('menu').count(), 1,
      'visually moving the control must preserve its delegated native menu action');
    const bounds=await page.evaluate(()=>{
      const menu=document.querySelector('.columnsMenu-test').getBoundingClientRect();
      const plus=document.querySelector('[aria-label="添加商品代码"]').getBoundingClientRect();
      return {gap:plus.left-menu.right,top:Math.abs(plus.top-menu.top)};
    });
    assert(bounds.gap>=0&&bounds.gap<=8&&bounds.top<=2,'menu appears immediately left of +');
    await page.setViewportSize({width:780,height:950});
    await page.waitForTimeout(50);
    const narrow=await page.evaluate(()=>{
      const menu=document.querySelector('.columnsMenu-test').getBoundingClientRect();
      const plus=document.querySelector('[aria-label="添加商品代码"]').getBoundingClientRect();
      return {gap:plus.left-menu.right,top:Math.abs(plus.top-menu.top)};
    });
    assert(narrow.gap>=0&&narrow.gap<=8&&narrow.top<=2,'menu follows the toolbar after resize');
    await page.evaluate(() => layout.dispose());
    console.log('Watchlist numeric updates settle and retain live values, trailing zero and accessibility.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
