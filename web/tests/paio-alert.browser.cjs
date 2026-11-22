// Real React form; requests terminate in a fixture, never a real alert/phone.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {build}=require('esbuild'),{chromium}=require('@playwright/test');
const input=JSON.parse(fs.readFileSync(process.env.PAIO_NATIVE_INPUT||'/evidence/native-input.json','utf8'));
(async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ChartAlertDialog} from './src/advanced/ChartAlertDialog';
 import {freshDraft} from './src/advanced/chartAlerts';
 const metadata=${JSON.stringify(input.catalog)};
 const initial=freshDraft({instrument:'EURUSD',series_kind:'provider',source:'fixture',timeframe:'H1',
 indicator:{name:'PAIO_V1',version:'1',params:metadata.PAIO_V1.params,output:'pattern_ii'},association:null});
 window.writes=[];window.draft=initial;
 async function request(path,body){if(path.endsWith('capabilities'))return {sources:[{source:'fixture',series_kind:'provider',available:true}],indicator_metadata:metadata};
 window.writes.push(body);return {id:'fixture',config:body.config};}
 createRoot(document.getElementById('root')).render(<ChartAlertDialog initial={initial} requestId='fixture'
 editing={null} theme='light' onDraft={value=>window.draft=value} onSaved={()=>{}} onClose={()=>{}} request={request}/>);
 `},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({executablePath:process.env.PAIO_CHROMIUM,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:375,height:915}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost/',r=>r.fulfill({body:'<div id="root"></div>',contentType:'text/html'}));
  await page.goto('http://localhost/');await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.waitForFunction(()=>document.querySelectorAll('.alert-paio-group').length===6);
  assert.equal(await page.locator('.alert-paio-group[open]').count(),0);
  const outputs=await page.getByLabel('输出',{exact:true}).locator('option').evaluateAll(nodes=>nodes.map(node=>node.value));
  assert.deepEqual(outputs,input.catalog.PAIO_V1.series.slice(0,10).map(item=>item.key));
  for(const summary of await page.locator('.alert-paio-group summary').all())await summary.click();
  const field=key=>page.locator(`[data-alert-field="condition.left.indicator.params.${key}"]`);
  await field('bi_specific').fill(' 1,01,1 ');
  await page.getByRole('checkbox',{name:'Use Count',exact:true}).uncheck();
  assert.equal(await page.evaluate(()=>draft.condition.left.indicator.params.bi_specific),' 1,01,1 ');
  await field('bi_specific').fill('');
  await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.waitForFunction(()=>writes.length===1);
  const config=await page.evaluate(()=>writes[0].config);
  assert.equal(config.condition.left.indicator.params.bi_specific,'');
  assert.equal(config.condition.left.indicator.params.useHLC,false);
  assert.equal(config.mode,'close');assert.equal(config.condition.relation,'above');assert.equal(config.condition.right.value,'0');
  assert.deepEqual(errors,[]);
  console.log('PASS PAIO six collapsed groups, ten source outputs, exact/empty text, boolean editing and close-confirmed saved snapshot');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
