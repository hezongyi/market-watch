const assert=require('node:assert/strict');
const {build}=require('esbuild');
const {chromium}=require('playwright');
(async()=>{
  const built=await build({entryPoints:['src/notifications/runtime.ts'],bundle:true,write:false,
    format:'iife',globalName:'Notices',platform:'browser',plugins:[{name:'offline-api',setup(b){
      b.onLoad({filter:/\/src\/api\.ts$/},()=>({contents:'export class ApiError extends Error {} export const api=async()=>{throw Error("offline")}',loader:'js'}));
    }}]});
  const remote=process.env.MW_ACCEPTANCE_CDP;
  const browser=remote?await chromium.connectOverCDP(remote):await chromium.launch({headless:true});
  // Private ephemeral browser context: no user cookies, storage or pages.
  const context=await browser.newContext();
  await context.route('https://notice-tests.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<title>Notice lifecycle test</title>'}));
  const page=await context.newPage();
  try {
    await page.goto('https://notice-tests.invalid/start');
    await page.addScriptTag({content:built.outputFiles[0].text});
    const id=await page.evaluate(async()=>{
      const runtime=window.runtime=new Notices.NoticeRuntime();
      runtime.attach();runtime.schedule=()=>{};runtime.subject='exit-test';runtime.ready=true;
      runtime.profile=crypto.randomUUID();await runtime.store.open();
      return runtime.report({source_kind:'market',code:'MARKET_REQUEST_FAILED',attempt_id:'one',
        title:'tagged exit sample',message:'offline',context:{epoch:7,acceptance_run:'page-exit',source_id:'request-one'}});
    });
    // A real reload destroys the document (unlike BFCache navigation).
    await page.reload();
    // No asynchronous write is required during unload. Resume the persisted
    // exit intents in the next document, as an existing peer would also do.
    await page.addScriptTag({content:built.outputFiles[0].text});
    await page.evaluate(async()=>{
      const runtime=new Notices.NoticeRuntime();runtime.subject='exit-test';runtime.ready=true;
      await runtime.store.open();await runtime.stageObservationEnds();runtime.store.close();
    });
    const pending=await page.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mw-professional-notices-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const rows=await new Promise((resolve,reject)=>{const r=db.transaction('pending').objectStore('pending').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      db.close();return rows;
    });
    assert.equal(pending.length,2,'offline failure and page-exit end both survive navigation');
    const fault=pending.find(row=>row.value.event.event_id===id);
    const end=pending.find(row=>row.value.event.recovery_of===id);
    assert.ok(fault && end);
    assert.equal(end.value.event.observation_ended,true);
    assert.equal(end.value.event.context.epoch,7);
    assert.deepEqual(end.value.event.context,fault.value.event.context);
    assert.ok(end.order>fault.order,'ordinary uploader sends original failure before its end');
    console.log('PASS real pagehide durably stages observation end with original context and ordered offline upload');
  }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
