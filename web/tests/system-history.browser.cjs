// Real React mount/unmount with held network results; never touches user pages.
const assert = require('node:assert/strict');
const {build} = require('esbuild');
const {chromium} = require('playwright');
(async()=>{
  const bundle = await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {useSystemHistory,SystemHistoryCache} from './src/notifications/useSystemHistory';
    let root, cache=new SystemHistoryCache(),config={filters:{},epoch:'one',revision:0,enabled:true};
    const pending=[]; const request=args=>new Promise((resolve,reject)=>pending.push({args,resolve,reject}));
    function View(){const view=useSystemHistory({...config,request,historyCache:cache});
      window.historyTest.view=view;
      return <div data-loading={view.loading}>{view.page?.events.map(row=><p key={row.id}>{row.id}</p>)}</div>}
    window.historyTest={pending,mount(changes={}){config={...config,...changes};
      if(!root)root=createRoot(document.getElementById('root'));root.render(<View/>);},
      unmount(){root.unmount();root=null;},reset(){cache=new SystemHistoryCache();}};
  `},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
  const remote=process.env.MW_ACCEPTANCE_CDP;
  const browser=remote?await chromium.connectOverCDP(remote):await chromium.launch({headless:true});
  const context=remote?browser.contexts()[0]:await browser.newContext();
  const page=await context.newPage();
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const count=async n=>page.waitForFunction(n=>historyTest.pending.length===n,n);
    const rows=()=>page.locator('p').allTextContents();
    const resolve=async(index,ids,before=null,epoch='one',highwater=100)=>page.evaluate(
      ({index,ids,before,epoch,highwater})=>historyTest.pending[index].resolve(
        {events:ids.map(id=>({id})),before,epoch,highwater}),{index,ids,before,epoch,highwater});
    await page.evaluate(()=>historyTest.mount());await count(1);
    assert.equal(await page.locator('[data-loading]').getAttribute('data-loading'),'true');
    await resolve(0,['a','b'],'cursor-1');await page.locator('p').first().waitFor();
    await page.evaluate(()=>historyTest.view.loadMore());await count(2);
    await resolve(1,['c','d']);await page.waitForFunction(()=>historyTest.view.page.events.length===4);
    await page.evaluate(()=>{historyTest.view.saveScroll(480);historyTest.unmount();historyTest.mount()});
    await count(3);
    assert.deepEqual(await rows(),['a','b','c','d'],'reopen immediately renders all cached chunks');
    assert.equal(await page.evaluate(()=>historyTest.view.scrollTop),480);
    await page.evaluate(()=>historyTest.pending[2].reject(Error('temporary read failure')));
    await page.waitForFunction(()=>historyTest.view.error.includes('temporary'));
    assert.deepEqual(await rows(),['a','b','c','d'],'failed refresh retains cached rows');
    await page.evaluate(()=>historyTest.mount({revision:1}));await count(4);
    await resolve(3,['new','a'],'cursor-new','one',200);await count(5);
    assert.equal(await page.evaluate(()=>historyTest.pending[4].args.before),'cursor-new');
    await resolve(4,['b','c'],'cursor-end','one',200);
    await page.waitForFunction(()=>!historyTest.view.loading);
    assert.deepEqual(await rows(),['new','a','b','c'],'refresh rebuilds every loaded page at one highwater');
    await page.evaluate(()=>historyTest.mount({filters:{q:'filter'}}));await count(6);
    assert.deepEqual(await rows(),[],'new filter never exposes another query');
    await page.evaluate(()=>historyTest.mount({epoch:'two',filters:{}}));await count(7);
    await resolve(6,['epoch-two'],null,'two',1);
    await page.waitForFunction(()=>historyTest.view.page?.epoch==='two');
    await resolve(5,['stale-filter']);
    assert.deepEqual(await rows(),['epoch-two'],'late old-filter/epoch result cannot overwrite new epoch');
    assert.equal(await page.evaluate(()=>historyTest.view.scrollTop),0);
    await page.evaluate(()=>{historyTest.unmount();historyTest.reset();historyTest.mount()});await count(8);
    assert.deepEqual(await rows(),[],'another controller cannot inherit account history');
    await resolve(7,['fresh'],null,'two',2);
    await page.waitForFunction(()=>historyTest.view.page?.events[0].id==='fresh');
    console.log('PASS React history loading, cached reopen/scroll, failed refresh, loaded-page refresh and scope fences');
  }finally{await page.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
