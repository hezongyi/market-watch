/* Actual React components with deterministic HTTP fixtures; no live supplier IO. */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { chromium } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const script = buildSync({ stdin: { contents: `
import React, {useState, useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {CenterContext} from './src/market-data/router';
import {setCenterTransport} from './src/market-data/api';
import {useMarketRows} from './src/market-data/MarketList';
import {DatasetContinuation, ManagedOpenChart} from './src/market-data/DatasetContinuation';
import {PlatformMarket} from './src/market-data/PlatformMarket';
import {ManagedMarket} from './src/market-data/ManagedMarket';
import {centerLocation} from './src/market-data/location';
setCenterTransport(async (path, body, signal) => {
  window.requests.push({path, body, aborted:false});
  const request = window.requests.at(-1);
  signal?.addEventListener('abort', () => {request.aborted=true}, {once:true});
  const r=await fetch('/test-api'+path, {method:body===undefined?'GET':'POST', body:body===undefined?undefined:JSON.stringify(body), signal});
  if(!r.ok) throw Error((await r.json()).detail);
  return r.json();
});
function Rows(){
  const [query,setQuery]=useState(''),[refresh,change]=useState(0);
  const rows=useMarketRows('/market-data/center/dataset-summaries',new URLSearchParams({query}),refresh);
  return <><input aria-label="filter" value={query} onChange={e=>setQuery(e.target.value)}/>
    <button onClick={()=>change(v=>v+1)}>poll</button>
    <div data-loading={rows.loading} data-total={rows.total} ref={rows.list} style={{height:300,overflow:'auto'}}>
    {rows.items.map(row=><div data-row={row.id} key={row.id} style={{height:24}}>{row.label}</div>)}
    <div ref={rows.sentinel}/></div>{rows.error&&<p role="alert">{rows.error}</p>}</>;
}
function App(){
  const [location,navigate]=useState('/market-data'),[view,setView]=useState('rows'),[workspace,setWorkspace]=useState('A');
  window.control={setView,navigate:(to)=>navigate(centerLocation(to)),setWorkspace};
  const apply=useCallback(async(ticker,frame)=>{window.opened.push({ticker,frame})},[]);
  return <CenterContext.Provider value={{location,navigate,workspace,apply,setDirty:()=>{},clearDirty:()=>{},busy:false}}>
    <main className="dc-window-content">{view==='rows'?<Rows/>:view==='native'?<PlatformMarket/>:view==='managed'?<ManagedMarket/>:view==='extension'?<><DatasetContinuation id={'a'.repeat(64)}/><ManagedOpenChart id={'a'.repeat(64)} ticker="MWH:fixed"/></>:<p>away</p>}</main>
  </CenterContext.Provider>;
}
window.requests=[];window.opened=[];
let hidden=false; Object.defineProperty(document,'hidden',{get:()=>hidden});
window.visibility=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
const observers=new Set();
window.IntersectionObserver=class {constructor(fn){this.fn=fn} observe(){observers.add(this)} disconnect(){observers.delete(this)}};
window.more=()=>{for(const observer of [...observers])observer.fn([{isIntersecting:true}])};
createRoot(document.getElementById('root')).render(<App/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', loader:{'.css':'empty'}, jsx: 'automatic' }).outputFiles[0].text;
const id = n => n.toString(16).padStart(64,'0');
(async()=>{
  const server = http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?script:'<div id="root"></div><script src="/app.js"></script>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  let members=Array.from({length:260},(_,i)=>({id:id(i+1),label:`Row ${i+1}`,position:i+1}));
  let directoryRevision='r1';
  let extension={dataset_id:id(10),supported:true,reason:'请选择默认实时接续配置',enabled:false,ready_to_enable:false,status:'disabled',default_mapping_id:null,configurations:[{id:id(80),active_revision_id:id(81),created_at:1000}],mappings:[1,2].map(i=>({id:id(i),current_account:true,valid_for_selection:true,match:{},target_identity:{provider_symbol:'EUR_USD'}})),composite:null};
  let failSave=false;
  await page.route('**/test-api/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname.replace('/test-api',''),q=url.searchParams;
    let result;
    if(p.endsWith('dataset-summaries')){
      if(q.get('query')) await new Promise(resolve=>setTimeout(resolve,200));
      let rows=q.get('query')?members.filter(r=>r.label.includes(q.get('query'))):members;
      rows=rows.map((r,i)=>({...r,position:i+1}));
      const anchor=q.get('anchor'),target=anchor?.startsWith('dataset-')?rows.find(r=>'dataset-'+r.id===anchor):rows.find(r=>r.continuation?.composite_ids?.some(c=>'composite-'+c===anchor));
      result={anchor_position:target?.position||null,total:rows.length,items:q.has('ids')?rows.filter(r=>q.get('ids').split(',').includes(r.id)):rows.slice(((Number(q.get('page'))||1)-1)*25,(Number(q.get('page'))||1)*25)};
    }else if(p.endsWith('/platform-revision'))result={revision:directoryRevision};
    else if(p.endsWith('/center/platform')){
      const start=((Number(q.get('page'))||1)-1)*50;
      result={revision:directoryRevision,total:130,items:Array.from({length:Math.min(50,130-start)},(_,i)=>({id:`BINANCE:T${i+start}`,label:`Native ${directoryRevision} ${i+start}`,name_zh:'',source:'binance',provider_symbol:`T${i+start}`,display_symbol:`T${i+start}`,history_catalog_id:`BINANCE:T${i+start}`,asset_class:'crypto',available:true,capabilities:{native_periods:['M1'],history_m1:true}}))};
    }else if(p.includes('directory-status'))result=[];
    else if(p.endsWith('/continuation')){
      if(route.request().method()==='POST'){
        if(failSave)return route.fulfill({status:422,json:{detail:'固定历史准备失败'}});
        const body=route.request().postDataJSON();
        assert.equal(typeof body.enabled,'boolean');
        extension={...extension,enabled:body.enabled,default_mapping_id:body.mapping_id||extension.default_mapping_id,status:body.enabled?'preparing':'disabled',reason:null};
      }
      result=extension;
    }else throw Error('Unexpected HTTP fixture '+p);
    await route.fulfill({json:result});
  });
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const rows=page.locator('[data-row]');
    await page.waitForFunction(()=>document.querySelectorAll('[data-row]').length===25);
    for(let count=2;count<=10;count++){
      await page.waitForFunction(()=>document.querySelector('[data-loading]')?.dataset.loading==='false');
      await page.evaluate(()=>window.more());
      await page.waitForFunction(n=>document.querySelectorAll('[data-row]').length===n,count*25);
    }
    let requests=await page.evaluate(()=>window.requests);
    assert.deepEqual(requests.filter(r=>r.path.includes('dataset-summaries')).map(r=>new URL(r.path,'http://test').searchParams.get('page')),Array.from({length:10},(_,i)=>String(i+1)));
    await page.getByRole('button',{name:'poll',exact:true}).click();
    await page.waitForFunction(()=>window.requests.filter(r=>r.path.includes('ids=')).length===3);
    await page.waitForFunction(()=>document.querySelector('[data-loading]').dataset.loading==='false');
    requests=await page.evaluate(()=>window.requests);
    assert.equal(requests.filter(r=>r.path.includes('dataset-summaries')&&!r.path.includes('ids=')).length,10);
    assert.equal(await rows.count(),250);
    // A new preceding member invalidates loaded ranks and rebuilds the prefix.
    members=[{id:id(400),label:'Inserted'},...members];
    await page.getByRole('button',{name:'poll',exact:true}).click();
    await page.waitForFunction(first=>document.querySelector('[data-row]')?.dataset.row===first,id(400));
    await page.waitForFunction(()=>document.querySelectorAll('[data-row]').length===250&&document.querySelector('[data-loading]').dataset.loading==='false');
    await page.evaluate(()=>{document.querySelector('[data-loading]').scrollTop=900});
    await page.waitForFunction(()=>Object.keys(sessionStorage).some(k=>k.startsWith('mw-market-scroll:')&&sessionStorage.getItem(k)==='900'));
    await page.evaluate(()=>window.control.setView('away'));
    await page.evaluate(()=>window.control.setView('rows'));
    await page.waitForFunction(()=>document.querySelectorAll('[data-row]').length===250&&document.querySelector('[data-loading]').scrollTop===900);
    // Hiding pauses reads; restoring visibility immediately validates loaded IDs.
    await page.evaluate(()=>window.visibility(true));
    await page.clock.install();
    const before=await page.evaluate(()=>window.requests.length);
    await page.clock.runFor(11000);
    assert.equal(await page.evaluate(()=>window.requests.length),before);
    await page.evaluate(()=>window.visibility(false));
    await page.clock.runFor(20);
    await page.waitForFunction(n=>window.requests.length>n,before);
    await page.clock.resume();
    await page.getByRole('textbox',{name:'filter',exact:true}).fill('Row 25');
    await page.waitForFunction(()=>window.requests.some(r=>r.path.includes('query=Row+25')));
    await page.getByRole('textbox',{name:'filter',exact:true}).fill('Row 2');
    await page.waitForFunction(()=>window.requests.some(r=>r.path.includes('query=Row+25')&&r.aborted));
    await page.waitForFunction(()=>document.querySelector('[data-loading]').dataset.loading==='false'&&document.querySelector('[data-row]')?.textContent==='Row 2');
    assert.equal(await page.locator('[data-row]').filter({hasText:'Row 1'}).count(),0);
    // Native fallback shares prefix cache, returns immediately, then checks revision.
    await page.evaluate(()=>{window.control.navigate('/market-data?tab=platform');window.control.setView('native')});
    await page.waitForFunction(()=>document.querySelectorAll('.dc-platform-fallback-row').length===50);
    await page.evaluate(()=>window.more());
    await page.waitForFunction(()=>document.querySelectorAll('.dc-platform-fallback-row').length===100);
    const nativeBefore=await page.evaluate(()=>window.requests.filter(r=>r.path.includes('/center/platform?')).length);
    await page.evaluate(()=>window.control.setView('away'));
    await page.evaluate(()=>window.control.setView('native'));
    await page.waitForFunction(()=>document.querySelectorAll('.dc-platform-fallback-row').length===100);
    await page.waitForFunction(()=>window.requests.some(r=>r.path.endsWith('/platform-revision')));
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path.includes('/center/platform?')).length),nativeBefore);
    directoryRevision='r2';
    await page.evaluate(()=>window.control.setView('away'));
    await page.evaluate(()=>window.control.setView('native'));
    await page.waitForFunction(()=>document.querySelector('.dc-platform-fallback-row')?.textContent.includes('Native r2'));
    await page.waitForFunction(()=>document.querySelectorAll('.dc-platform-fallback-row').length===100);
    // Two mappings require a real choice; browse causes no write or chart open.
    await page.evaluate(()=>window.control.setView('extension'));
    await page.getByRole('switch',{name:'实时接续',exact:true}).waitFor();
    assert.equal(await page.getByRole('switch').isDisabled(),true);
    assert.equal((await page.evaluate(()=>window.requests)).filter(r=>r.body!==undefined).length,0);
    await page.getByText('已有接续配置与旧引用',{exact:true}).click();
    assert.equal(await page.locator(`a[href*="${id(80)}"]`).count(),1);
    await page.getByRole('combobox',{name:'默认接续配置'}).selectOption(id(2));
    failSave=true;
    await page.getByRole('switch').click();
    await page.getByRole('alert').filter({hasText:'固定历史准备失败'}).waitFor();
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');
    failSave=false;
    await page.getByRole('switch').click();
    await page.waitForFunction(()=>document.querySelector('[role=switch]').getAttribute('aria-checked')==='true');
    await page.getByRole('button',{name:'打开图表',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'实时接续准备中'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.opened),[]);
    extension={...extension,ready_to_enable:true,status:'receiving',composite:{id:id(90),active_revision_id:id(91),revision:{history_version_id:'fixed',seam:1000},preparation:{status:'queried',confirmed_end:2000,error:null}}};
    await page.evaluate(()=>window.control.setView('away'));
    await page.evaluate(()=>window.control.setView('extension'));
    await page.getByRole('button',{name:'查看固定历史',exact:true}).click();
    await page.getByRole('button',{name:'打开图表',exact:true}).click();
    await page.waitForFunction(()=>window.opened.length===2);
    assert.deepEqual((await page.evaluate(()=>window.opened)).map(v=>v.ticker),['MWH:fixed',`MWC:${id(90)}`]);
    await page.getByRole('switch').click();
    await page.waitForFunction(()=>document.querySelector('[role=switch]').getAttribute('aria-checked')==='false');
    await page.getByRole('button',{name:'打开图表',exact:true}).click();
    await page.waitForFunction(()=>window.opened.length===3);
    assert.equal((await page.evaluate(()=>window.opened)).at(-1).ticker,'MWH:fixed');
    // Old composite and candidate row links restore focus on their dataset.
    const managedRow={logical_symbol:'EUR/USD',asset_class:'forex',identity:{source:'dukascopy',basis:'bid'},maintenance:{configured:true},usable_timeframes:[],periods:[],availability:'available'};
    members=[...Array.from({length:27},(_,i)=>({...managedRow,id:id(500+i)})),{...managedRow,id:id(10),continuation:{enabled:false,configured:true,status:'disabled',composite_ids:[id(80),id(90)]}}];
    const legacyStart=await page.evaluate(()=>window.requests.length);
    await page.evaluate(composite=>{window.control.navigate('/market-data?tab=composite#composite-'+composite);window.control.setView('managed')},id(80));
    await page.waitForFunction(dataset=>document.activeElement?.id==='dataset-'+dataset,id(10));
    assert.equal(await page.locator('.dc-market-row').count(),28);
    await page.evaluate(dataset=>window.control.navigate('/market-data/?tab=composite&view=candidates#candidate-'+dataset),id(10));
    await page.waitForFunction(()=>window.requests.at(-1)?.path.includes('dataset-summaries')&&!window.requests.at(-1)?.path.includes('view=continuation'));
    await page.waitForFunction(dataset=>document.activeElement?.id==='dataset-'+dataset,id(10));
    const legacyRequests=await page.evaluate(start=>window.requests.slice(start),legacyStart);
    assert.equal(legacyRequests.filter(r=>!r.path.includes('dataset-summaries')).length,0);
    assert.equal(legacyRequests.filter(r=>r.path.includes('page=2')).length,2);
    // A larger old page must revalidate a complete shorter cached list.
    await page.evaluate(()=>window.control.setView('away'));
    members=members.slice(-1);
    await page.evaluate(()=>{window.control.navigate('/market-data?tab=managed');window.control.setView('managed')});
    await page.waitForFunction(()=>document.querySelectorAll('.dc-market-row').length===1);
    await page.evaluate(()=>window.control.setView('away'));
    members=[...Array.from({length:27},(_,i)=>({...managedRow,id:id(700+i)})),...members];
    const cacheStart=await page.evaluate(()=>window.requests.length);
    await page.evaluate(dataset=>{window.control.navigate('/market-data?tab=composite&view=candidates&page=4#candidate-'+dataset);window.control.setView('managed')},id(10));
    await page.waitForFunction(()=>document.querySelectorAll('.dc-market-row').length===28);
    await page.waitForFunction(dataset=>document.activeElement?.id==='dataset-'+dataset,id(10));
    assert.ok((await page.evaluate(start=>window.requests.slice(start),cacheStart)).some(r=>r.path.includes('anchor=')));
    assert.deepEqual(errors,[]);
    console.log('PASS actual React: 10 pages/10 reads; batched refresh; rank invalidation; cache/scroll return; visibility; stale search abort; native cached return/revision invalidation; explicit mapping, failed enable, old config access, fixed vs continued chart; legacy composite/candidate row return');
  }catch(error){console.error(errors);console.error(await page.evaluate(()=>({requests:window.requests.slice(-8),html:document.body.innerText.slice(0,900),storage:{...sessionStorage},scroll:document.querySelector('[data-loading]')?.scrollTop,errors:[]})));throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
