const {chromium} = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The native watchlist paints rows before headerReady/datafeed quote callbacks.
// Keep this captured row structure at that seam: attaching after construction
// alone cannot prevent the first frame from exposing the storage identity.
(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-test-id-widget-type="watchlist"></div>');
    await page.route('**/indicator-picker.css', route => route.fulfill({body:''}));
    await page.addStyleTag({path:path.resolve(__dirname,'../../advanced-host/chart-menu.css')});
    const identities = ['MWC:'+'a'.repeat(64), 'MWH:24df99fe-2fb9-4d43-ac33-2c272bab9226',
      'MWP:DUKA:'+'b'.repeat(32), 'NATIVE:'+'c'.repeat(32), 'MWP:YAHOO:'+'d'.repeat(32),
      'MWP:MD:'+'e'.repeat(24)+':GBPUSD', 'MWP:OANDA:EUR_USD', 'MWP:BINANCE:BTCUSDT'];
    await page.evaluate(identities => {
      const root = document.querySelector('[data-test-id-widget-type="watchlist"]');
      for(const ticker of [...identities, 'MWP:EURUSD']) {
        const row = document.createElement('div'); row.dataset.symbolFull = ticker;
        row.dataset.symbolShort = ticker.replace(/^MW[CPH]:/,'');
        row.innerHTML = '<div class="firstItem-test symbolName-test"><span class="inner-test symbolNameText-test"></span></div><span class="last-test">1.12250</span>';
        row.querySelector('.symbolNameText-test').textContent = row.dataset.symbolShort;
        root.append(row);
      }
    },identities);
    const names = () => page.locator('.symbolNameText-test').evaluateAll(nodes => nodes.map(n => ({
      visibility:getComputedStyle(n).visibility,text:n.innerText,
      placeholder:getComputedStyle(n,'::after').content,
    })));
    let rows = await names();
    assert(rows.slice(0,-1).every(r=>r.visibility==='hidden'&&r.placeholder==='"加载中…"'),
      'constructor rows must not paint opaque tickers before the adapter attaches');
    assert.equal(rows.at(-1).visibility,'hidden','every source uses the same safe initial state');
    await page.evaluate(() => {
      window.TradingView={version:()=> '6b804c486857f27920cf761aa7eb6e29d9bb6362'};
      window.MWSeries={};
    });
    await page.addScriptTag({path:path.resolve(__dirname,'../../advanced-host/watchlist-layout.js')});
    await page.evaluate(() => {
      window.knownNames=new Map();
      const rows=[...document.querySelectorAll('[data-symbol-full]')];
      window.knownNames.set(rows[0].dataset.symbolFull,'EURUSD');
      window.knownNames.set(rows[1].dataset.symbolFull,'EURUSD');
      window.knownNames.set(rows[2].dataset.symbolFull,'GBPUSD');
      window.layout=MWWatchlistLayout.attach({createButton:()=>document.createElement('button'),removeButton(){}},e=>{throw e},ticker=>knownNames.get(ticker));
    });
    assert.equal((await names()).at(-1).visibility,'visible','readable platform code is released without a quote');
    assert.deepEqual((await names()).slice(0,3).map(r=>r.placeholder),['"EURUSD"','"EURUSD"','"GBPUSD"'],
      'already resolved names display immediately, independently of the first quote');
    const change = async (index, text) => page.evaluate(({index,text}) => {
      const row=document.querySelectorAll('[data-symbol-full]')[index];
      row.dataset.symbolShort=text; row.querySelector('.symbolNameText-test').textContent=text;
      return new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    },{index,text});
    await change(0,'EURUSD');
    assert.equal((await names())[0].visibility,'visible','resolved human name is released');
    await change(0,'a'.repeat(64));
    assert.equal((await names())[0].visibility,'hidden','list rebuild/rebind cannot repaint a stale internal name');
    await change(2,'GBPUSD');
    assert.equal((await names())[2].visibility,'visible','Dukascopy resolved code is released');
    for(const [index,code] of [[3,'^GSPC'],[4,'GC=F'],[5,'BTC-USD'],[6,'EURUSD'],[7,'BTCUSDT']]) {
      await change(index,code);
      assert.equal((await names())[index].visibility,'visible','valid display punctuation is preserved: '+code);
    }
    // Native can update attributes without replacing the name text node.
    await page.evaluate(() => {
      const row=document.querySelectorAll('[data-symbol-full]')[2];
      row.dataset.symbolFull='MWP:DUKA:'+'e'.repeat(32);
      row.dataset.symbolShort='DUKA:'+'e'.repeat(32);
      row.querySelector('.symbolNameText-test').textContent=row.dataset.symbolShort;
    });
    await page.waitForTimeout(30);
    assert.equal((await names())[2].visibility,'hidden');
    assert.equal((await names())[2].placeholder,'"加载中…"','reused identities cannot retain an old metadata name');
    await page.evaluate(() => {
      const row=document.querySelectorAll('[data-symbol-full]')[2];
      knownNames.set(row.dataset.symbolFull,'USDJPY');layout.refresh();
    });
    assert.equal((await names())[2].placeholder,'"USDJPY"','new metadata releases the actual name before any quote');
    assert.equal(await page.locator('.last-test').first().innerText(),'1.12250','name guard leaves quotes intact');
    await page.evaluate(() => {
      layout.dispose();
      TradingView.version=()=> 'unsupported-library-version';
      window.fallbackReports=[];
      window.fallback=MWWatchlistLayout.attach({createButton:()=>document.createElement('button'),removeButton(){}},
        error=>fallbackReports.push(error.message));
    });
    assert((await names()).every(r=>r.visibility==='visible'),'unsupported versions release native names');
    assert.equal(await page.evaluate(()=>fallbackReports.length),1);
    await page.evaluate(()=>{
      TradingView.version=()=> '6b804c486857f27920cf761aa7eb6e29d9bb6362';
      window.layout=MWWatchlistLayout.attach({createButton:()=>document.createElement('button'),removeButton(){}},
        error=>{throw error},ticker=>knownNames.get(ticker));
    });
    assert.equal((await names())[0].visibility,'hidden','supported reattach restores first-frame protection');
    await page.evaluate(() => layout.dispose());
    console.log('Watchlist names are safe before startup, after resolution and during list rebuilds.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
