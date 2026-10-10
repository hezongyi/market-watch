const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {buildSync} = require('esbuild');
const {chromium, expect} = require('@playwright/test');

// Actual Window/DatasetDetail code with read-only API fixtures. No server,
// database or supplier connection is started by this regression test.
const root = path.resolve(__dirname, '../..');
const id = 'a'.repeat(64), version = '11111111-1111-4111-8111-111111111111';
const route = '/market-data/datasets/' + id;
const script = buildSync({
  stdin: {resolveDir: path.join(root, 'web'), loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import Window from './src/market-data/Window';
    import {setCenterTransport} from './src/market-data/api';
    const id = '${id}', version = '${version}';
    const dataset = {id, logical_symbol:'EURUSD', display_symbol:'EUR/USD',
      identity:{source:'dukascopy',basis:'bid',provider_symbol:'EURUSD',environment:'prod'},
      aggregation_calendar:'ny17', maintenance:{configured:false,paused:false,archived:false},
      periods:['M1','M5','M15','M30','H1','H4','D1','W1','MN'].map(timeframe =>
        ({id:timeframe,timeframe,status:'published',rows:100,complete_rows:100})),
      usable_timeframes:[],availability:'available',latest_version_id:version};
    setCenterTransport(async path => {
      if(path.includes('/center/datasets/')) return dataset;
      if(path.includes('/live/status')) {
        await new Promise(resolve=>setTimeout(resolve,300));
        return {provider:{configured:true,error:null},datasets:Array.from({length:12},(_,i)=>
          ({dataset_id:String(i),logical_symbol:'EURUSD'+i,quote_ready:false,candle_ready:false,
            market_session:'unknown',quote:null,last_confirmed_m1:null}))};
      }
      if(path.startsWith('/market-data/versions?')) return [{id:version,status:'published',start:0,end:60000,published_at:60000}];
      if(path.includes('/requests?')) return {items:Array.from({length:25},(_,i)=>
        ({id:String(i),start:i*60000,end:(i+1)*60000,started_at:60000,finished_at:60000,
          result:'data',read_kind:'supplier_request',accepted:true,observations:1})),
        total:100,failed:0,evidence_available:true};
      return {items:[],total:0};
    });
    let root;
    window.mountCenter = location => {
      root=createRoot(document.getElementById('root'));
      root.render(<Window hosted={{context:{workspace:'position-test',target:'t',theme:'light',
        symbolSync:false,intervalSync:false,location},
        post:m=>{if(m.type==='location') window.currentRoute=m.location; if(m.type==='close') queueMicrotask(()=>root.unmount());},subscribe:listener=>{window.centerMessage=listener;return ()=>{window.centerMessage=null;};}}}/>);
    };
    window.unmountCenter = () => root.unmount();
  `},
  bundle:true, write:false, platform:'browser', format:'iife', jsx:'automatic',
  loader:{'.css':'empty'}, logLevel:'silent',
  define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},
}).outputFiles[0].text;

(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:375,height:700}});
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('https://position.invalid/**', request => request.fulfill({
      contentType:'text/html',body:'<div id="root" style="height:100vh"></div>',
    }));
    await page.goto('https://position.invalid/');
    await page.addStyleTag({content:'html,body{margin:0;height:100%;}' +
      fs.readFileSync(path.join(root,'web/src/market-data/content.css'),'utf8') +
      fs.readFileSync(path.join(root,'web/src/market-data/window.css'),'utf8')});
    await page.addScriptTag({content:script});
    const body = page.locator('.dc-dataset-body');
    const section = name => page.getByRole('navigation',{name:'自建行情管理'}).getByRole('button',{name,exact:true}).click();
    await page.evaluate(route => window.mountCenter(route), route);
    await expect(page.locator('.dc-period-row')).toHaveCount(9);
    await body.evaluate(node => node.scrollTop=200);
    const top = await body.evaluate(node => node.scrollTop);
    assert.equal(top,200);
    await section('维护设置');
    await section('概览');
    await expect.poll(() => body.evaluate(node=>node.scrollTop)).toBe(top);
    checks.push('Default overview survives category round-trip (200 → 200)');

    await page.evaluate(() => window.unmountCenter());
    const coverage = route+'?section=coverage&version='+version+'&view=requests&request_page=2';
    await page.evaluate(route => window.mountCenter(route), coverage);
    await expect(page.locator('.dc-request-columns.dc-business-row')).toHaveCount(25);
    await body.evaluate(node=>node.scrollTop=350);
    await section('概览');
    await section('覆盖与质量');
    await expect.poll(() => body.evaluate(node=>node.scrollTop)).toBe(350);
    const returned = await page.evaluate(()=>window.currentRoute);
    assert.notEqual(returned,coverage);
    assert.equal(new URL(returned,'https://position.invalid').searchParams.get('request_page'),'2');
    assert.equal(new URL(returned,'https://position.invalid').searchParams.get('version'),version);
    checks.push('Coverage parameters reordered on return retain page/version and scroll (350 → 350)');

    await page.evaluate(() => window.unmountCenter());
    await page.evaluate(route => sessionStorage.setItem('mw-data-center:position-test:positions',
      JSON.stringify({[route]:{top:180,tableTop:0,tableLeft:0,focus:'dc-dataset-tasks'}})),route);
    await page.evaluate(route=>window.mountCenter(route+'?section=overview'),route);
    await expect.poll(()=>body.evaluate(node=>node.scrollTop)).toBe(180);
    await expect(page.locator('#dc-dataset-tasks')).toBeFocused();
    checks.push('Legacy stored URL migrates and restores both scroll and focus');
    await page.evaluate(() => window.unmountCenter());
    const sourceRoute='/market-data?tab=sources';
    await page.evaluate(route => sessionStorage.setItem('mw-data-center:position-test:positions',
      JSON.stringify({[route]:{top:350,tableTop:0,tableLeft:0,focus:'dc-source-diagnostics-toggle'}})),sourceRoute);
    const scroller=page.locator('.dc-window-content');
    await page.evaluate(route=>window.mountCenter(route),sourceRoute);
    await expect(page.locator('.dc-source-table tbody tr')).toHaveCount(12);
    await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).toBe(350);
    await expect(page.locator('#dc-source-diagnostics-toggle')).toBeFocused();
    checks.push('Delayed source snapshot restores saved scroll and diagnostic focus on reopen');
    await page.getByRole('button',{name:'任务与记录',exact:true}).click();
    await page.getByRole('button',{name:'来源状态',exact:true}).click();
    await expect(page.locator('.dc-source-table tbody tr')).toHaveCount(12);
    await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).toBe(350);
    await expect(page.locator('#dc-source-diagnostics-toggle')).toBeFocused();
    checks.push('Source category round-trip preserves scroll and diagnostic focus after delayed reload');
    await page.evaluate(()=>window.centerMessage({type:'request-close'}));
    await expect(page.locator('.dc-window')).toHaveCount(0);
    await page.evaluate(route=>window.mountCenter(route),sourceRoute);
    await expect(page.locator('.dc-source-table tbody tr')).toHaveCount(12);
    await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).toBe(350);
    await expect(page.locator('#dc-source-diagnostics-toggle')).toBeFocused();
    checks.push('Actual close and reopen preserves source scroll and diagnostic focus');
    await page.evaluate(() => window.unmountCenter());
    await page.evaluate(route=>window.mountCenter(route),sourceRoute);
    await page.locator('#dc-sources-title').click();
    await expect(page.locator('.dc-source-table tbody tr')).toHaveCount(12);
    await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).toBe(0);
    await expect(page.locator('#dc-sources-title')).toBeFocused();
    checks.push('User interaction during initial source read cancels late position restoration');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,environment:'Ubuntu Chromium; actual React UI and read-only browser API fixtures',checks,errors},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
