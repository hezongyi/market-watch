// Actual long-lived instance; isolated browser; existing user documents stay read-only.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const out=process.env.MW_FXCM_ARTIFACT_DIR,base=process.env.MW_FXCM_BASE_URL;
assert(out&&base&&process.env.MW_FXCM_CREDENTIAL_FILE);
const report={passed:false,started_at:new Date().toISOString(),platform:[],pages:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const save=stage=>{report.stage=stage;fs.writeFileSync(out+'/business-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({stage}));};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}});
 await context.grantPermissions(['local-network-access'],{origin:base});
 let csrf,dataset;
 const api=async(route,body)=>{const r=await context.request.fetch(base+'/api/'+route,{method:body===undefined?'GET':'POST',data:body,headers:csrf?{'X-CSRF-Token':csrf}:{},timeout:75000});assert(r.ok(),route+': HTTP '+r.status());return r.json();};
 async function published(id){for(let i=0;i<240;i++){const v=await api('market-data/versions/'+id);assert(!['failed','cancelled'].includes(v.status),'Version failed: '+String(v.error));if(v.status==='published')return v;await sleep(1500);}throw Error('Publish timeout');}
 try{
  csrf=(await api('login',{password:JSON.parse(fs.readFileSync(process.env.MW_FXCM_CREDENTIAL_FILE)).password})).csrf;
  const refresh=await api('market-data/history-catalog/refresh',{source:'fxcm'});assert(refresh.count>0);report.directory_count=refresh.count;save('directory');
  let eur;
  for(const [query,symbol,digits] of [['EURUSD','EUR/USD',5],['XAUUSD','XAU/USD',2]]){
   const c=await api('market-data/center/platform?source=fxcm&query='+query);const item=c.items.find(i=>i.provider_symbol===symbol);assert(item);assert.equal(item.precision,digits);if(!eur)eur=item;
   for(const timeframe of ['M1','H1','D1']){
    const q={instrument:item.id,series_kind:'provider',timeframe,limit:20};const a=await api('charts/data',q);assert(a.bars.length);assert.equal(a.source,'fxcm');assert.equal(a.volume_kind,'tick_count');const b=await api('charts/data',{...q,before:a.bars[0].start});assert(b.bars.length&&b.bars.every(r=>r.start<a.bars[0].start));report.platform.push({symbol,timeframe,bars:a.bars.length,older:b.bars.length});save(symbol+'-'+timeframe);
   }
  }
  // Only a newly registered FXCM dataset is modified. Existing datasets are rejected.
  const existing=await api('market-data/center/datasets?source=fxcm&query=EURUSD&page_size=100');
  assert.equal(existing.items.length,0,'FXCM dataset already exists: preserve it and inspect before rerun');
  dataset=await api('market-data/datasets',{source:'fxcm',logical_symbol:'EURUSD',provider_symbol:eur.provider_symbol,asset_class:'forex',precision:5,aggregation_calendar:'utc0',catalog_id:eur.id});report.dataset=dataset.id;save('dataset');
  const start=Date.parse('2026-10-23T16:00:00Z'),end=start+2*3600000;
  await api('market-data/datasets/'+dataset.id+'/maintenance',{target_start:start,timeframes:['M1','H4'],frequency:'once',overlap_minutes:30});
  const body={request_id:'fxcm-mwa-first-20261025',end};const first=await api('market-data/datasets/'+dataset.id+'/tasks',body);assert.equal((await api('market-data/datasets/'+dataset.id+'/tasks',body)).id,first.id);
  const parent=await published(first.id);const original=await api('market-data/versions/'+parent.id+'/bars?timeframe=M1');const h4=await api('market-data/versions/'+parent.id+'/bars?timeframe=H4');assert.equal(original.bars.length,120);assert(h4.bars.length);report.parent=parent.id;save('initial-published');
  const child=await published((await api('market-data/datasets/'+dataset.id+'/tasks',{request_id:'fxcm-mwa-increment-20261025',end:end+3600000})).id);assert.equal(child.parent_version_id,parent.id);assert.deepEqual((await api('market-data/versions/'+parent.id)).manifest,parent.manifest);assert.deepEqual(await api('market-data/versions/'+parent.id+'/bars?timeframe=M1'),original);report.child=child.id;report.parent_unchanged=true;report.duplicate_request_reused=true;report.m1_count=120;report.h4_count=h4.bars.length;save('increment-published');
  // Read an existing workspace; override its document only in this temporary context.
  const workspaces=await api('advanced-charts/workspaces');const workspace=workspaces[0];assert(workspace);
  const old=await api('advanced-charts/workspaces/'+workspace.id);
  let doc={engine:'tv31',schemaVersion:1,symbol:'MWP:'+eur.id,series_kind:'provider',interval:'60'};
  const blocked=[];
  await context.route(/\/api\/advanced-charts\/(?:workspaces|native-charts|preferences)(?:\/|$)/,async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(req.method()!=='GET'){blocked.push(p);if(p.endsWith('/migrate'))return route.fulfill({json:{migrated:0}});return route.abort('blockedbyclient');}
   if(p==='/api/advanced-charts/workspaces/'+workspace.id)return route.fulfill({json:{...old,document:doc}});
   return route.continue();
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const frame=()=>page.frames().find(f=>{try{return f.parentFrame()===page.mainFrame()&&new URL(f.url()).searchParams.get('parent')===base;}catch{return false;}});
  for(const [name,ticker,kind,interval] of [['platform','MWP:'+eur.id,'provider','60'],['managed','MWH:'+child.id,'history','1']]){
   doc={engine:'tv31',schemaVersion:1,symbol:ticker,series_kind:kind,interval};await page.goto(base+'/advanced-charts/'+workspace.id);for(let i=0;i<240&&!frame();i++)await sleep(250);assert(frame(),'Chart host missing');
   await frame().waitForFunction(expected=>typeof ready!=='undefined'&&ready&&!loading&&widget&&MWSeries.same(widget.activeChart().symbol(),expected)&&widget.activeChart().dataReady(),ticker,{timeout:90000});
   const study=await frame().evaluate(()=>widget.activeChart().createStudy('Moving Average',false,false,{length:5}));assert(study);
   if(name==='platform'){
    await frame().evaluate(()=>dataCenter.open('/market-data?tab=platform&source=fxcm&query=EURUSD'));
    let native;for(let i=0;i<120;i++){native=page.frames().find(f=>f.url().startsWith('blob:')&&f.parentFrame()===frame());if(native&&await native.locator('.dc-window').count())break;await sleep(250);}
    assert(native);await native.locator('.dc-window').getByRole('heading',{name:'平台行情',exact:true}).waitFor({timeout:30000});report.directory_ui_rendered=true;
    await page.screenshot({path:out+'/fxcm-platform-directory.png'});
    await native.getByRole('button',{name:'关闭数据中心',exact:true}).click();
   }
   await page.screenshot({path:out+'/fxcm-'+name+'-chart.png'});report.pages.push({name,ticker,rendered:true,moving_average:true});save(name+'-browser');
  }
  await page.close();report.browser_errors=errors;assert.equal(errors.length,0);report.workspace_writes_blocked=blocked.length;report.user_documents_preserved=true;
  // Real wall-clock daily schedule, with no worker restart or DB clock overrides.
  const d=new Date(Date.now()+120000);const plan=await api('market-data/datasets/'+dataset.id+'/maintenance',{target_start:start,timeframes:['M1','H4'],frequency:'daily',timezone:'UTC',daily_minute:d.getUTCHours()*60+d.getUTCMinutes(),overlap_minutes:30});report.daily_due=plan.next_at;save('daily-wait');
  let automatic;
  for(let i=0;i<360;i++){const p=await api('market-data/datasets/'+dataset.id+'/maintenance');if(p.latest_version_id!==child.id&&!p.active_version_id){const v=await api('market-data/versions/'+p.latest_version_id);assert.equal(v.status,'published');automatic=v;break;}await sleep(2000);}
  assert(automatic,'Daily schedule did not publish');assert.equal(automatic.parent_version_id,child.id);report.daily_version=automatic.id;report.daily_automatic_publish=true;
  await api('market-data/datasets/'+dataset.id+'/maintenance/control',{action:'pause'});assert.equal((await api('market-data/datasets/'+dataset.id+'/maintenance')).paused,true);
  await api('market-data/datasets/'+dataset.id+'/maintenance/control',{action:'resume'});assert.equal((await api('market-data/datasets/'+dataset.id+'/maintenance')).paused,false);
  report.pause_resume=true;report.passed=true;save('complete');
 }catch(e){report.error=String(e.message).split('\n')[0];save('failed');process.exitCode=1;}
 finally{
  if(dataset&&csrf){try{const p=await api('market-data/datasets/'+dataset.id+'/maintenance/control',{action:'pause'});if(p.active_version_id)await api('market-data/tasks/'+p.active_version_id+'/control',{action:'pause'});report.left_paused=true;}catch{report.left_paused=false;report.passed=false;process.exitCode=1;}}
  report.finished_at=new Date().toISOString();fs.writeFileSync(out+'/business-result.json',JSON.stringify(report,null,2));await context.close();await browser.close();console.log(JSON.stringify({passed:report.passed,stage:report.stage,error:report.error}));
 }
})();
