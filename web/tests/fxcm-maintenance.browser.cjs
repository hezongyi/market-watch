// Only restarts the explicitly named task-owned history worker. Never use a long-lived instance.
const { request } = require('@playwright/test');
const fs=require('node:fs'), assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const out=process.env.MW_FXCM_ARTIFACT_DIR;
assert(out && process.env.MW_FXCM_BASE_URL && process.env.MW_FXCM_CREDENTIAL_FILE, 'Set MW_FXCM_* acceptance parameters');
const report={passed:false,started_at:new Date().toISOString()};
const save=stage=>{report.stage=stage;fs.writeFileSync(out+'/schedule-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({stage}));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const worker='mw-fxcm-history-20261024-history-worker-1';
const docker=(...args)=>execFileSync('docker',args,{timeout:45000,stdio:['ignore','pipe','pipe']});
(async()=>{
 const context=await request.newContext({baseURL:process.env.MW_FXCM_BASE_URL,ignoreHTTPSErrors:true});
 let csrf;
 async function api(route,body){const r=await context.fetch('/api/'+route,{method:body===undefined?'GET':'POST',data:body,headers:csrf?{'X-CSRF-Token':csrf}:{},timeout:75000});assert(r.ok(),route+': HTTP '+r.status());return r.json();}
 async function completed(id){for(let i=0;i<200;i++){const r=await api('market-data/versions/'+id);assert(!['failed','cancelled'].includes(r.status));const p=await api('market-data/datasets/'+dataset.id+'/maintenance');if(r.status==='published'&&!p.active_version_id)return r;await sleep(1500);}throw Error('Task completion timeout');}
 let dataset,stopped=false;
 try{
  csrf=(await api('login',{password:JSON.parse(fs.readFileSync(process.env.MW_FXCM_CREDENTIAL_FILE)).password})).csrf;
  const previous=JSON.parse(fs.readFileSync(out+'/browser-result.json'));assert(previous.passed);dataset=previous.managed.dataset;
  const path='market-data/datasets/'+dataset.id;
  const parent=await api('market-data/versions/'+previous.managed.child);
  // Verify a durable queued task survives an orderly worker stop/start and remains paused.
  docker('stop','--time','25',worker);stopped=true;
  const queued=await api(path+'/tasks',{request_id:'fxcm-restart-'+Date.now(),end:parent.end+3600000});
  await api('market-data/tasks/'+queued.id+'/control',{action:'pause'});
  docker('start',worker);stopped=false;
  await sleep(10000);
  const paused=await api('market-data/versions/'+queued.id);assert.equal(paused.status,'paused');
  await api('market-data/tasks/'+queued.id+'/control',{action:'resume'});
  const recovered=await completed(queued.id);assert.equal(recovered.parent_version_id,parent.id);
  report.recovery={version:queued.id,paused_after_restart:true,resumed_published:true,mode:'orderly_stop_durable_queued_task_not_mid_request_kill'};save('worker-recovery');
  // Real wall-clock due minute. No database clock overrides.
  const due=Date.now()+120000;const d=new Date(due);
  const plan=await api(path+'/maintenance',{target_start:parent.start,timeframes:['M1','H4'],frequency:'daily',timezone:'UTC',daily_minute:d.getUTCHours()*60+d.getUTCMinutes(),overlap_minutes:30});
  assert(plan.next_at>Date.now()&&plan.next_at<Date.now()+125000);
  await api(path+'/maintenance/control',{action:'pause'});
  const oldLatest=(await api(path+'/maintenance')).latest_version_id;
  report.daily={due_at:plan.next_at,clock:'natural_UTC_minute',latest_before_due:oldLatest};save('daily-paused-waiting-for-due');
  while(Date.now()<plan.next_at+10000)await sleep(Math.min(10000,plan.next_at+10000-Date.now()));
  const stillPaused=await api(path+'/maintenance');assert.equal(stillPaused.paused,true);assert.equal(stillPaused.active_version_id,null);assert.equal(stillPaused.latest_version_id,oldLatest);
  report.daily.paused_due_did_not_run=true;
  await api(path+'/maintenance/control',{action:'resume'});save('daily-resumed');
  let auto;
  for(let i=0;i<200;i++){const current=await api(path+'/maintenance');if(current.latest_version_id!==oldLatest&&!current.active_version_id){auto=await api('market-data/versions/'+current.latest_version_id);break;}await sleep(1500);}
  assert(auto&&auto.status==='published','Natural due daily task did not publish');
  assert.equal(auto.parent_version_id,oldLatest);
  report.daily.version=auto.id;report.daily.automatic_publish=true;
  await api(path+'/maintenance/control',{action:'pause'});
  report.daily.left_paused=true;report.passed=true;save('schedule-complete');
 }catch(e){report.error=String(e.message).split('\n')[0];process.exitCode=1;save('failed');}
 finally{
  if(stopped)docker('start',worker);
  if(dataset&&csrf){try{
   const p=await api('market-data/datasets/'+dataset.id+'/maintenance/control',{action:'pause'});
   if(!report.passed&&p.active_version_id)await api('market-data/tasks/'+p.active_version_id+'/control',{action:'pause'});
   report.left_paused=true;
  }catch{report.left_paused=false;report.passed=false;process.exitCode=1;}}
  report.finished_at=new Date().toISOString();fs.writeFileSync(out+'/schedule-result.json',JSON.stringify(report,null,2));await context.dispose();
 }
})();
