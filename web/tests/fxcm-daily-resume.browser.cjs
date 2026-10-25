// Continue the recorded daily failure, then verify a fresh natural due minute.
const {request}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const out=process.env.MW_FXCM_ARTIFACT_DIR;
assert(out&&process.env.MW_FXCM_BASE_URL&&process.env.MW_FXCM_CREDENTIAL_FILE,'Set MW_FXCM_* acceptance parameters');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const before=JSON.parse(fs.readFileSync(out+'/schedule-result.json'));
 assert(before.recovery?.resumed_published&&before.daily?.paused_due_did_not_run);
 assert.equal(before.passed,false,'Continuation requires the preserved failed report');
 const browser=JSON.parse(fs.readFileSync(out+'/browser-result.json'));
 const dataset=browser.managed.dataset.id,path='market-data/datasets/'+dataset;
 const report={passed:false,started_at:new Date().toISOString(),recovery:before.recovery,prior_failure:before.error,clock:'natural_UTC_minute'};
 const save=stage=>{report.stage=stage;fs.writeFileSync(out+'/daily-resume-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({stage}));};
 const context=await request.newContext({baseURL:process.env.MW_FXCM_BASE_URL,ignoreHTTPSErrors:true});let csrf;
 async function api(route,body){const r=await context.fetch('/api/'+route,{method:body===undefined?'GET':'POST',data:body,headers:csrf?{'X-CSRF-Token':csrf}:{},timeout:75000});assert(r.ok(),route+': HTTP '+r.status());return r.json();}
 async function completed(id){const until=Date.now()+240000;while(Date.now()<until){const v=await api('market-data/versions/'+id),p=await api(path+'/maintenance');assert(!['failed','cancelled','configuration_error'].includes(v.status));if(v.status==='published'&&!p.active_version_id)return v;await sleep(1500);}throw Error('Daily task completion timeout');}
 try{
  csrf=(await api('login',{password:JSON.parse(fs.readFileSync(process.env.MW_FXCM_CREDENTIAL_FILE)).password})).csrf;
  const plan=await api(path+'/maintenance');assert(plan.paused&&plan.active_version_id);
  report.original_daily=plan.active_version_id;
  await api('market-data/tasks/'+plan.active_version_id+'/control',{action:'resume'});save('original-daily-resumed');
  const recovered=await completed(plan.active_version_id);assert.equal(recovered.parent_version_id,before.daily.latest_before_due);
  report.original_daily_published=true;save('original-daily-published');
  const d=new Date(Date.now()+120000);
  await api(path+'/maintenance',{target_start:recovered.start,timeframes:['M1','H4'],frequency:'daily',timezone:'UTC',daily_minute:d.getUTCHours()*60+d.getUTCMinutes(),overlap_minutes:30});
  await api(path+'/maintenance/control',{action:'resume'});
  const armed=await api(path+'/maintenance');assert(armed.next_at>Date.now()&&armed.next_at<Date.now()+125000);
  report.due_at=armed.next_at;report.parent_version=recovered.id;save('fresh-daily-armed');
  while(Date.now()<armed.next_at)await sleep(Math.min(10000,armed.next_at-Date.now()));
  let auto;const until=Date.now()+240000;
  while(Date.now()<until){const p=await api(path+'/maintenance');if(p.latest_version_id!==recovered.id&&!p.active_version_id){auto=await api('market-data/versions/'+p.latest_version_id);break;}await sleep(1500);}
  assert(auto&&auto.status==='published','Fresh natural daily did not publish');assert.equal(auto.parent_version_id,recovered.id);
  report.fresh_daily=auto.id;report.automatic_publish=true;report.passed=true;save('fresh-daily-published');
 }catch(e){report.error=String(e.message).split('\n')[0];process.exitCode=1;save('failed');}
 finally{
  if(csrf){try{
   const p=await api(path+'/maintenance/control',{action:'pause'});
   if(!report.passed&&p.active_version_id)await api('market-data/tasks/'+p.active_version_id+'/control',{action:'pause'});
   report.left_paused=true;
  }catch{report.left_paused=false;report.passed=false;process.exitCode=1;}}
  report.finished_at=new Date().toISOString();save(report.passed?'schedule-complete':'failed');await context.dispose();
 }
})();
