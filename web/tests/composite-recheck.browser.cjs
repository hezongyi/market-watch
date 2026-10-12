// Built data-center entry: fixed-revision source form and retry identity.
// Controlled transport only; HTTP permissions are covered by backend tests.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dist=path.resolve(__dirname,'../dist'),origin='https://mw-recheck.invalid';
(async()=>{
  const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:1300,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route(origin+'/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/data-center-native.css"><style>#mount{width:1200px;height:900px}.dc-window{position:relative;width:100%;height:100%}</style><div id="mount"></div><script src="/data-center-native.js"></script>'});
      return route.fulfill({path:path.join(dist,url.pathname.slice(1))});
    });
    await page.goto(origin+'/');
    await page.evaluate(()=>{
      window.recheckCalls=[];window.sourceMode='network';
      const id='a'.repeat(64),seam=Date.parse('2026-10-08T21:00:00Z'),revision={id:'fixed',request_id:'initial',parent_revision_id:null,
        history_version_id:'history',seam,rules:{aggregation_calendar:'ny17'},reason:'Fixed test input',activated_at:null,change:null,
        preparation:{ready:false,status:'queried',cutoff:seam+86400000,input_revision:1,periods_ready:false,query_error:null,indicators:[]}};
      MWNativeCenter.mount(document.querySelector('#mount'),{ui:null,
        context:{workspace:'recheck-fixture',target:'0',theme:'dark',symbolSync:false,intervalSync:false,
          location:'/market-data/composites/'+id+'?tab=composite&section=seam'},post(){},subscribe(){return()=>{};},
        async request(input,body){
          const url=new URL(input,location.origin),p=url.pathname;
          if(p.endsWith('/recheck')){
            recheckCalls.push({path:p,body});
            if(sourceMode==='network')throw new TypeError('Load failed');
            return {status:sourceMode==='pending'?'started':'empty_success',observations:sourceMode==='pending'?null:0,finished_at:sourceMode==='pending'?null:Date.now()};
          }
          if(p.endsWith('/revision-options'))return {items:[]};
          if(p.endsWith('/revisions'))return {items:[revision],total:1,page_size:25};
          if(p.endsWith('/requests'))return {items:[],total:0,page_size:25};
          if(p.endsWith('/composites/'+id))return {id,logical_symbol:'EURUSD',historical_source:'dukascopy',calendar:'ny17',status:'receiving',active_revision_id:'fixed',revision,
            mapping:{target_identity:{provider_symbol:'EUR_USD'},match:{rationale:'Same source',historical_evidence:'https://example.invalid/history',live_evidence:'https://example.invalid/live'}},preparation:revision.preparation};
          throw Error('unexpected request '+p);
        }});
    });
    await page.getByText('复核来源缺分钟',{exact:true}).click();
    const start=page.getByLabel('复核开始（UTC）'),end=page.getByLabel('复核结束（UTC）'),submit=page.getByRole('button',{name:'复核此区间',exact:true});
    await start.fill('2026-10-08T21:00');await end.fill('2026-10-08T21:20');
    await submit.click();await expect(page.getByRole('alert')).toContainText('Load failed');
    await page.evaluate(()=>sourceMode='pending');await submit.click();
    await expect(page.getByRole('status').filter({hasText:'核对状态'})).toContainText('started');
    await page.evaluate(()=>sourceMode='empty');await submit.click();
    await expect(page.getByRole('status').filter({hasText:'核对状态'})).toContainText('缺失分钟仍为未知');
    await submit.click();
    await expect.poll(()=>page.evaluate(()=>recheckCalls.length)).toBe(4);
    const calls=await page.evaluate(()=>recheckCalls);
    assert.equal(calls[0].body.start,Date.parse('2026-10-08T21:00:00Z'));
    assert.equal(calls[0].body.end,Date.parse('2026-10-08T21:20:00Z'));
    assert.equal(calls[0].body.request_id,calls[1].body.request_id);
    assert.equal(calls[1].body.request_id,calls[2].body.request_id,'pending query keeps its identity');
    assert.notEqual(calls[2].body.request_id,calls[3].body.request_id,'completed query permits a fresh bounded read');
    assert.ok(calls.every(call=>call.path==='/market-data/composites/'+'a'.repeat(64)+'/revisions/fixed/recheck'));
    assert.deepEqual(errors,[]);
    console.log('PASS built source recheck form: UTC bounds, fixed revision, network/pending idempotency, fresh completed query and unknown empty response');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
