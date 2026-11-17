// Actual native labels follow the chart on symbol/precision changes and reload.
// Synthetic feeds only: no deployed workspaces or indicator preferences are saved.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const output = process.env.MW_TEST_ARTIFACT_DIR || path.join(root, 'artifacts/lwma-presentation');
const source = fs.readFileSync(path.join(root, 'advanced-host/indicators.js'), 'utf8');
const baseline = require('node:child_process').execFileSync('git', ['show', 'c41706f0:advanced-host/indicators.js'], { cwd: root, encoding: 'utf8' });
const origin = 'https://lwma-presentation.invalid';
const report = { passed: false, checks: [], errors: [] };
const html = (legacy, custom) => `<!doctype html><html><body style="margin:0"><div id="chart" style="height:100vh"></div>
<script src="/charting_library/charting_library.js"></script><script>${legacy ? baseline : source}</script><script>
const catalog={LWMA:{pane:'main',params:{period:5},series:[{key:'value',type:'line'}]}};
const end=Date.UTC(2026,10,17),step=3600000;
const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['60']}),0),
 resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:s,type:'forex',session:'24x7',timezone:'Etc/UTC',
 minmov:1,pricescale:10**(s.includes('THREE')?3:s.includes('TWO')?2:5),has_intraday:true,supported_resolutions:['60'],format:'price'}),0),
 getBars:(s,r,p,cb)=>{const auxiliary=s.ticker.startsWith('MWPY_'),symbol=auxiliary?JSON.parse(atob(s.ticker.slice(5))).symbol:s.ticker;
 const base=symbol.includes('THREE')?107.354:symbol.includes('TWO')?252.29:1.23456;
 const rows=Array.from({length:400},(_,i)=>{const value=base+Math.sin(i)*0.003-(auxiliary?0.000123456789:0);return {time:end-(400-i)*step,open:value,high:value+0.01,low:value-0.01,close:value,volume:1}})
 .filter(b=>b.time<p.to*1000).slice(-p.countBack);setTimeout(()=>cb(rows,{noData:!rows.length}),0)},subscribeBars(){},unsubscribeBars(){}};
let ready=false;
const widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',symbol:'FX_FIVE',interval:'60',autosize:true,theme:'Dark',locale:'zh',datafeed:feed,
 disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default','header_saveload'],
 custom_formatters:{priceFormatterFactory:(s,t)=>${custom}&&t==='default'?{format:v=>'FX '+Number(v).toFixed(4)}:null},
 custom_indicators_getter:p=>Promise.resolve(pythonStudies(p,catalog))});
widget.onChartReady(async()=>{await widget.activeChart().createStudy('守望 Python LWMA',false,false);ready=true});
</script></body></html>`;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch();
  async function open(query = '') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route(origin + '/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html(url.searchParams.has('legacy'), url.searchParams.has('custom')) });
      if (!url.pathname.startsWith('/charting_library/')) return route.fulfill({ status: 404 });
      const file = path.resolve(root, 'advanced-host', '.' + url.pathname);
      if (!file.startsWith(path.join(root, 'advanced-host/charting_library/'))) return route.fulfill({ status: 403 });
      return route.fulfill({ path: file });
    });
    await page.goto(origin + '/?' + query);
    await page.waitForFunction(() => ready && widget.activeChart().dataReady());
    return page;
  }
  const inspect = page => page.evaluate(() => {
    const chart = widget.activeChart(), id = chart.getAllStudies()[0].id;
    const study = chart._chartWidget.model().model().dataSourceForId(id);
    const raw = study.data().last()?.value[1];
    const doc = document.querySelector('iframe').contentDocument;
    const labels = Array.from(doc.querySelectorAll('[data-entity-id="' + id + '"] [data-test-id-value-title]'))
      .filter(node => node.getClientRects().length).map(node => node.textContent);
    return { symbol: chart.symbol(), raw, labels, expected: Number.isFinite(raw) ? chart.priceFormatter().format(raw) : null,
      color: chart.getStudyById(id).getStyleValues().styles.plot0.color };
  });
  async function check(page, name) {
    await page.mouse.move(1275, 5);
    await expect.poll(async () => { const s = await inspect(page); return !!s.expected && s.labels.includes(s.expected); },
      { timeout: 10000, message: name + ': native LWMA label must match the main price formatter' }).toBe(true);
    report.checks.push({ name, ...await inspect(page) });
  }
  try {
    const legacy = await open('legacy');
    await expect.poll(async () => (await inspect(legacy)).raw).not.toBeUndefined();
    await legacy.evaluate(() => { const c = widget.activeChart(); c.getStudyById(c.getAllStudies()[0].id).applyOverrides({ 'value.color': '#123456' }); });
    const saved = await legacy.evaluate(() => new Promise(resolve => widget.save(resolve)));
    await legacy.close();
    const page = await open();
    for (const symbol of ['FX_THREE', 'FX_TWO', 'FX_FIVE']) {
      await page.evaluate(symbol => new Promise(resolve => widget.activeChart().setSymbol(symbol, resolve)), symbol);
      await check(page, symbol);
      assert.equal((await inspect(page)).color.toLowerCase(), '#787b86', 'new LWMA defaults to neutral gray');
      await page.screenshot({ path: path.join(output, symbol + '.png') });
    }
    for (const tick of ['10000,1,false', '100,1,false', 'default']) {
      await page.evaluate(tick => widget.activeChart().applyOverrides({ 'mainSeriesProperties.minTick': tick }), tick);
      await check(page, 'chart precision ' + tick);
    }
    await page.evaluate(saved => widget.load(saved), saved);
    await expect.poll(async () => (await inspect(page)).color).toBe('#123456');
    await check(page, 'legacy layout preserves custom color and inherits precision');
    await page.close();
    const custom = await open('custom');
    await check(custom, 'custom chart formatter');
    await custom.close();
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('PASS LWMA chart precision, gray default, manual precision, legacy custom color and custom formatter');
  } catch (error) { report.failure = error.stack; throw error; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
