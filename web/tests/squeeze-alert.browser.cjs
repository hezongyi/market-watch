// Exercise the actual dialog, including the boolean and fractional parameter controls.
const assert=require('node:assert/strict'),{build}=require('esbuild'),{chromium}=require('@playwright/test');
(async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ChartAlertDialog} from './src/advanced/ChartAlertDialog';
 import {freshDraft} from './src/advanced/chartAlerts';
 const initial=freshDraft({instrument:'EURUSD',series_kind:'provider',source:'fixture',timeframe:'H1',
 indicator:{name:'ROLLING_RANGE_SQUEEZE',version:'1',params:{k:3,lookback:20,low_pct:5,confirm_on_close:true},output:'signal'},association:null});
 window.writes=[];window.draft=initial;
 const metadata={ROLLING_RANGE_SQUEEZE:{label:'Rolling Range Squeeze',parameter_schema:{
 k:{label:'K',min:1,max:100000},lookback:{label:'Percentile Lookback',min:20,max:100000},
 low_pct:{label:'Lowest Percentile (%)',min:0.1,max:50},confirm_on_close:{label:'Only confirm on bar close',type:'bool'}},series:[]}};
 async function request(path,body){if(path.endsWith('capabilities'))return {sources:[{source:'fixture',series_kind:'provider',available:true}],indicator_metadata:metadata};
 window.writes.push(body);return {id:'fixture',config:body.config};}
 createRoot(document.getElementById('root')).render(<ChartAlertDialog initial={initial} requestId='fixture'
 editing={null} theme='dark' onDraft={value=>window.draft=value} onSaved={()=>{}} onClose={()=>{}} request={request}/>);
 `},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost/',r=>r.fulfill({body:'<div id="root"></div>',contentType:'text/html'}));
  await page.goto('http://localhost/');await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.getByLabel('Only confirm on bar close',{exact:true}).uncheck();
  await page.getByLabel('K',{exact:true}).fill('1');
  await page.getByLabel('Lowest Percentile (%)',{exact:true}).fill('0.1');
  await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.waitForFunction(()=>writes.length===1);
  const config=await page.evaluate(()=>writes[0].config);
  assert.equal(config.condition.left.indicator.params.confirm_on_close,false);
  assert.equal(config.condition.left.indicator.params.low_pct,0.1);assert.equal(config.condition.left.indicator.params.k,1);
  assert.equal(config.condition.relation,'above');assert.equal(config.condition.right.value,'0');
  assert.equal(config.name,'Rolling Range Squeeze');assert.equal(config.message,'Rolling Range Squeeze triggered');
  assert.deepEqual(errors,[]);console.log('PASS squeeze actual alert dialog boolean/fractional inputs and saved snapshot');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
