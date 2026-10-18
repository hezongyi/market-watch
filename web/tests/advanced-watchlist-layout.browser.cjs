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
      <div id="native-columns" style="display:flex;flex-direction:row-reverse"><button data-column-type="short_name">商品</button><button data-column-type="last_price">最新价</button><button class="columnsMenu-test">更多</button></div>
      <div data-symbol-full="MWP:EURUSD"><span class="cell-test last-test"><span class="inner-test">1.12<span class="uptick-test">234</span></span></span></div>
      </div>
    </div>`);
    await page.route('**/indicator-picker.css', route => route.fulfill({body:''}));
    await page.addStyleTag({path:path.resolve(__dirname, '../../advanced-host/chart-menu.css')});
    await page.addStyleTag({content:`
      body { background: white; color: black; }
      html.theme-dark body { background: rgb(20,20,20); color: white; }
      [data-symbol-full]:hover { background: rgb(240,243,250); }
      html.theme-dark [data-symbol-full]:hover { background: rgb(42,46,57); }
    `});
    await page.evaluate(() => {
      window.nativeText = document.querySelector('.uptick-test').firstChild;
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
      window.sortUpdates = 0;
      window.watchlistSymbols = ['###分区甲','MWP:ZETA','MWP:BETA','MWP:ALPHA','###分区乙','MWP:DELTA','MWP:CHARLIE'];
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
        watchList: async () => ({
          getActiveListId: () => 'test-list',
          getList: () => window.watchlistSymbols,
          updateList: (_id, symbols) => { window.sortUpdates++; window.watchlistSymbols = symbols; },
        }),
      }, error => { throw error; }, name => name, ticker => ({
        'MWP:ZETA':'blue','MWP:BETA':'red','MWP:ALPHA':'red',
        'MWP:DELTA':'blue','MWP:CHARLIE':'red',
      }[ticker]));
    });
    await page.waitForTimeout(50);
    assert.ok(await page.evaluate(() => observerCalls <= 2),
      'numeric quotes must settle; the adapter must not observe its own changes forever');
    const sortButton=page.getByRole('button',{name:'按旗标排序'});
    assert(await sortButton.isVisible(),'the flag sort control stays beside the product header');
    assert.equal(await sortButton.evaluate(button=>button.style.position),'absolute',
      'the control overlays the header without taking a flex column slot');
    assert.equal(await sortButton.evaluate(button=>button.getBoundingClientRect().width),16,
      'the control matches the row flag width');
    assert.equal(await sortButton.evaluate(button=>button.getBoundingClientRect().height),24,
      'the control matches the row flag height');
    assert(await sortButton.evaluate(button=>button.getBoundingClientRect().right <=
      button.parentElement.querySelector('[data-column-type="short_name"]').getBoundingClientRect().left),
      'the flag is visually before the product label');
    assert.equal(await page.evaluate(()=>sortUpdates),0,'sorting is not applied until requested');
    await sortButton.evaluate(button => button.dispatchEvent(new PointerEvent('pointerenter')));
    assert.equal(await sortButton.evaluate(button=>button.style.color),'rgb(174, 177, 186)',
      'the gray flag brightens slightly on hover');
    await sortButton.evaluate(button => button.click());
    await page.waitForFunction(()=>sortUpdates===1);
    assert.deepEqual(await page.evaluate(()=>watchlistSymbols),[
      '###分区甲','MWP:ALPHA','MWP:BETA','MWP:ZETA',
      '###分区乙','MWP:CHARLIE','MWP:DELTA',
    ],'red then blue symbols sort alphabetically inside each section');
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(()=>sortUpdates),1,'a completed click does not keep re-sorting');
    const read = () => page.locator('.last-test').evaluate(cell => ({
      text:cell.textContent,raw:cell.dataset.mwRawPrice,digit:cell.dataset.mwPriceDigit,
      count:cell.querySelectorAll('sup').length,aria:cell.getAttribute('aria-label'),
    }));
    assert.deepEqual(await read(), {text:'1.12234',raw:'1.12234',digit:'4',count:0,aria:'1.12234'});
    await page.evaluate(() => { layout.refresh(); layout.refresh(); });
    assert.equal((await read()).text, '1.12234', 'repeated refresh preserves every digit');
    await page.evaluate(() => { nativeText.data = '250'; });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => nativeText.isConnected),true,'original React Text remains connected');
    assert.deepEqual(await read(), {text:'1.12250',raw:'1.12250',digit:'0',count:0,aria:'1.12250'});
    await page.evaluate(() => { document.querySelector('.last-test').innerHTML = '<span class="inner-test">1.12<span class="uptick-test">250</span></span>'; });
    await page.waitForTimeout(50);
    assert.deepEqual(await read(), {text:'1.12250',raw:'1.12250',digit:'0',count:0,aria:'1.12250'});
    await page.evaluate(()=>document.documentElement.classList.add('theme-dark'));
    await page.waitForTimeout(50);
    const overlay=()=>page.locator('.last-test').evaluate(cell=>({
      color:cell.style.getPropertyValue('--mw-digit-color'),
      background:cell.style.getPropertyValue('--mw-digit-background')}));
    assert.deepEqual(await overlay(),{color:'rgb(255, 255, 255)',background:'rgb(20,20,20)'},
      'html theme change updates the decorative glyph');
    await page.locator('[data-symbol-full]').hover();
    await page.waitForTimeout(50);
    assert.equal((await overlay()).background,'rgb(42,46,57)','CSS-only hover updates the glyph background');
    await page.mouse.move(0,0);await page.waitForTimeout(50);
    assert.equal((await overlay()).background,'rgb(20,20,20)','leaving hover restores native background');
    // React can update the original Text node without retaining an old digit.
    await page.evaluate(() => { document.querySelector('.uptick-test').firstChild.data = '340'; });
    await page.waitForTimeout(50);
    assert.deepEqual(await read(), {text:'1.12340',raw:'1.12340',digit:'0',count:0,aria:'1.12340'});
    assert.equal(await page.locator('.last-test').evaluate(cell =>
      getComputedStyle(cell, '::after').content), '"0" / ""');
    assert(await page.locator('.last-test').evaluate(cell =>
      parseFloat(getComputedStyle(cell,'::after').fontSize) < parseFloat(getComputedStyle(cell).fontSize)));
    await page.evaluate(() => { document.querySelector('.uptick-test').firstChild.data = '—';
      document.querySelector('.inner-test').firstChild.data = ''; });
    await page.waitForTimeout(50);
    assert.equal((await read()).digit,undefined,'missing quotes discard the glyph overlay');
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
