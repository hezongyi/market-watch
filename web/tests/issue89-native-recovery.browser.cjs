// Real React/RPC/backend/PG/native adapter/canvas; synthetic, offline OANDA input.
// Run only against the task-owned preview described in the verification record.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync,spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {sampleNative}=require('./fixtures/issue89-sampling.cjs');
const APP='https://localhost:18389',CHART='https://localhost:18390';
const TASK='mw-issue89-20261021';
const OUT=process.env.ISSUE89_OUTPUT||'/tmp/issue89-native';
const SCENARIO=process.env.ISSUE89_SCENARIO||'full';
assert.ok(['full','correction'].includes(SCENARIO));
fs.mkdirSync(OUT,{recursive:true});
const report={app:APP,chart:CHART,task:TASK,scenario:SCENARIO,input:'synthetic offline OANDA; no real upstream',
  source:execFileSync('git',['rev-parse','HEAD']).toString().trim(),
  dirty:!!execFileSync('git',['status','--porcelain']).toString().trim(),
  tools:Object.fromEntries(['scripts/issue89_acceptance_fixture.py',
    'web/tests/issue89-native-recovery.browser.cjs','web/tests/fixtures/issue89-sampling.cjs']
    .map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  components:JSON.parse(execFileSync('docker',['inspect',...['api','web','chart-origin','postgres','tls']
    .map(service=>TASK+'-'+service+'-1')]).toString()).map(c=>({name:c.Name,image:c.Image,
      source:c.Config.Labels['io.market-watch.commit']??null,dirty:c.Config.Labels['io.market-watch.dirty']??null})),
  http:[],stages:[],samples:[],errors:[],diagnostics:[],renderFrames:[]};
const credentialRef=value=>value?createHash('sha256').update(value).digest('hex').slice(0,16):null;
const sameConsumer=(http,accepted,id)=>http.consumer?.some(c=>c.id.endsWith('|'+id)&&
  (c.generation===accepted.generation||c.generation===accepted.establishedOriginFrom&&
    http.origin===accepted.identity.calculationStart));
// Raw response values/credentials stay in memory, never in the evidence file.
const observations=[];
function fixture(operation,frame='H1',extra=[]){
  const result=execFileSync('docker',['exec',TASK+'-api-1','python',
    '/tmp/issue89_acceptance_fixture.py',operation,'--frame',frame,...extra],{timeout:30000}).toString();
  report.stages.push({fixture:operation,frame,result:JSON.parse(result)});
}
const save=()=>fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));
function startFixtureObserver(){
  const child=spawn('docker',['exec','-i',TASK+'-api-1','python',
    '/tmp/issue89_acceptance_fixture.py','observe','--watch-seconds','900']);
  report.observer={events:[],stderr:''};
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{
    report.observer.exit={code,signal};resolve();
  }));
  const ready=new Promise((resolve,reject)=>{
    let buffer='',announced=false;
    const timer=setTimeout(()=>reject(Error('offline fixture observer did not start')),15000);
    child.once('error',reject);
    child.once('close',code=>{clearTimeout(timer);if(!announced||code)reject(Error('fixture observer failed: '+report.observer.stderr));});
    child.stderr.on('data',chunk=>{report.observer.stderr=(report.observer.stderr+chunk).slice(-2000);});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      while(buffer.includes('\n')){
        const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        const event=JSON.parse(line);report.observer.events.push(event);
        if(event.observer==='ready'){announced=true;clearTimeout(timer);resolve();}
      }
    });
  });
  return {ready,stop:async()=>{
    child.stdin.end();
    let timer;
    try{await Promise.race([done,new Promise((_,reject)=>{
      timer=setTimeout(()=>{child.kill();reject(Error('fixture observer stop timeout'));},10000);
    })]);}finally{clearTimeout(timer);}
  }};
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:960}});
  await context.addInitScript(()=>{
    globalThis.issue89Messages=[];
    addEventListener('message',event=>{
      if(event.data?.channel==='mw-chart-v1')issue89Messages.push({at:Date.now(),type:event.data.type,
        id:event.data.id,method:event.data.args?.method});
    });
  });
  const page=await context.newPage();let frame,referenceRead,observer;
  let activeStage='setup';
  const pending=[];
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(['warning','error'].includes(m.type()))report.diagnostics.push({
    type:m.type(),text:m.text().slice(0,700)});});
  page.on('requestfailed',r=>report.diagnostics.push({type:'requestfailed',
    path:new URL(r.url()).pathname,error:r.failure()?.errorText}));
  page.on('response',r=>{
    const pathname=new URL(r.url()).pathname;
    if(pathname.startsWith('/api/charts/')&&!pathname.includes('stream/events'))report.diagnostics.push({
      type:'http',path:pathname,status:r.status()});
    if(pathname.startsWith('/api/charts/history-loads'))pending.push((async()=>{
      const body=await r.json().catch(()=>({})),query=r.request().postDataJSON()?.query;
      const state=body.load??body;
      report.diagnostics.push({type:'history-load',path:pathname,state:state.state,pages:state.pages,
        error:state.error?.code,resultRows:body.result?.bars?.length,
        query:query?Object.fromEntries(['instrument','timeframe','limit','before','from','countBack']
          .map(key=>[key,query[key]])):undefined});
    })());
    if(!r.url().includes('/api/charts/data'))return;
    const received=Date.now();
    pending.push((async()=>{
      const q=r.request().postDataJSON(),b=await r.json().catch(()=>({}));
      const summary={at:received,started:r.request().timing().startTime,status:r.status(),frame:q.timeframe,
        consumer:q.indicator_consumers?.map(c=>({id:c.id,generation:c.generation})),
        requestCredential:credentialRef(q.provider_snapshot_id),credential:credentialRef(b.provider_snapshot_id),
        revision:String(b.input_revision??b.cache_revision??b.revision??''),
        origin:b.calculation_origin??b.origin,
        indicators:q.indicators?.map(i=>i.name)||[],code:b.detail?.code,
        attempt:r.headers()['x-mw-attempt-ref'],bars:b.bars?.length,
        calculation:b.indicators?.map(i=>({name:i.name,coverage:i.calculation?.coverage,
          status:i.calculation?.status,valid:i.series.reduce((n,s)=>n+s.values.filter(p=>p.value!==null).length,0)}))};
      observations.push({q,b,summary});report.http.push(summary);
    })());
  });
  // Associate this stage's rejected request with the same native study's actual
  // accepted credential and input revision. An unrelated 200 cannot satisfy it.
  async function recoveryEvidence(name,started,mark,res,studyId){
    await Promise.all(pending);
    const trace=await frame.evaluate(()=>issue89Trace);
    const rejected=report.http.filter(x=>x.started>=started&&x.frame===(res==='60'?'H1':'H4')&&
      x.status===422&&x.code==='DISPLAY_SNAPSHOT_EXPIRED'&&
      x.consumer?.some(c=>c.id.endsWith('|'+studyId)));
    assert.ok(rejected.length>0,name+': own old-credential 422 missing');
    for(const rejection of rejected){
      assert.ok(rejection.attempt,name+': rejection lacks HTTP/log attempt reference');
      const accepted=trace.slice(mark).find(x=>x.accepted&&x.valid>0&&x.studyId===studyId&&
        x.identity.period===res&&x.start>=rejection.at&&report.http.some(h=>
          h.started>=rejection.at&&h.status===200&&h.indicators.length&&
          h.credential===x.credential&&h.revision===x.revision&&
          sameConsumer(h,x,studyId)));
      assert.ok(accepted,name+': same-study new-read/native acceptance missing');
      report.stages.push({name:name+'-association',rejectedAttempt:rejection.attempt,
        rejectedCredential:rejection.requestCredential,acceptedCredential:accepted.credential,
        studyId,generation:accepted.generation,revision:accepted.revision,
        elapsed:accepted.start+accepted.elapsed-rejection.at});
    }
  }
  async function readStudy(index,id,mark){
    const snapshot=await frame.evaluate(({index,id,mark})=>{
      const chart=widget.chart(index),model=chart._chartWidget.model().model();
      const scope=MWNativeIndicatorResults.scope(chart,id);
      const accepted=issue89Trace.slice(mark).findLast(x=>x.chartIndex===index&&x.studyId===id&&
        x.accepted&&x.valid>0&&x.generation===scope?.generation);
      const main=[],native=[];
      model.mainSeries().data().each((_,row)=>{main.push(row.slice(0,6));});
      model.dataSourceForId(id).data().each((_,row)=>{native.push([...row]);});
      const binding=indicatorBindings.get(indicatorKey(chart.symbol(),chart.resolution()));
      return {index,id,scope,accepted,main,native,ready:chart.dataReady(),symbol:chart.symbol(),
        resolution:chart.resolution(),viewport:chart.getVisibleRange(),
        inputs:Object.fromEntries(chart.getStudyById(id).getInputValues().map(x=>[x.id,x.value])),
        binding:binding?{inputRevision:binding.inputRevision,tailVersion:binding.tailVersion,
          correctionVersion:binding.correctionVersion,calculationStart:binding.calculationStart,
          credential:binding.providerSnapshot??binding.displaySnapshot}:null};
    },{index,id,mark});
    const {scope,accepted,binding,main}=snapshot;
    if(binding)binding.credential=credentialRef(binding.credential);
    let reason;
    if(!snapshot.ready||!scope)reason='chart not ready';
    else if(!accepted)reason='current generation has no stage acceptance';
    else if(accepted.credential!==binding?.credential||accepted.revision!==String(binding.inputRevision??binding.tailVersion))reason='accepted input is behind current price binding';
    else if(accepted.identity.calculationStart!==binding.calculationStart||accepted.identity.main!==snapshot.symbol||accepted.identity.period!==snapshot.resolution)reason='accepted calculation identity differs';
    else if(!scope.coverage||['first','last','count'].some(key=>scope.coverage[key]!==scope[key])||
      scope.coverage.identity!==JSON.stringify(accepted.identity))reason='current full-range coverage not settled';
    const summary={index,studyId:id,ready:snapshot.ready,generation:scope?.generation,
      acceptedGeneration:accepted?.generation,revision:accepted?.revision,credential:accepted?.credential,
      identity:accepted?.identity,scope,viewport:snapshot.viewport,mainRows:main.length,
      mainFingerprint:createHash('sha256').update(JSON.stringify(main)).digest('hex'),reason};
    return {...snapshot,eligible:!reason,reason,summary,
      fingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
  }
  async function verifyNative(deadline,marks={}){
    await Promise.all(pending);
    const checks=[];
    const charts=await frame.evaluate(()=>Array.from({length:widget.chartsCount()},(_,index)=>
      ({index,ids:widget.chart(index).getAllStudies().map(s=>s.id)})));
    for(const c of charts)for(const id of c.ids){
      const sampled=await sampleNative({deadline,
        read:()=>readStudy(c.index,id,marks[c.index]??0),
        record:event=>{report.samples.push({stage:activeStage,at:Date.now(),...event});save();},
        reference:async(candidate,remaining)=>{
          await Promise.all(pending);
          const {accepted,scope}=candidate;
          assert.ok(scope.count<=2000,'reference must cover the complete native range');
          const pages=observations.filter(({summary:h})=>h.status===200&&h.credential===accepted.credential&&
            h.revision===accepted.revision&&sameConsumer(h,accepted,id));
          assert.ok(pages.length,'accepted batch must match an observed same-consumer HTTP result');
          const {q,b}=pages.at(-1);
          const started=Date.now();
          const reference=await referenceRead({instrument:q.instrument,series_kind:'provider',published:false,
            timeframe:q.timeframe,indicators:q.indicators,provider_snapshot_id:b.provider_snapshot_id,
            calculation_origin:accepted.identity.calculationStart,before:scope.last+1,limit:scope.count},remaining);
          report.samples.push({stage:activeStage,event:'reference',started,elapsed:Date.now()-started,
            credential:credentialRef(reference.provider_snapshot_id),revision:String(reference.input_revision??reference.cache_revision??reference.revision),
            origin:reference.calculation_origin??reference.origin,rows:reference.bars?.length});save();
          assert.equal(credentialRef(reference.provider_snapshot_id),accepted.credential);
          assert.equal(String(reference.input_revision??reference.cache_revision??reference.revision),accepted.revision);
          assert.equal(reference.calculation_origin??reference.origin,accepted.identity.calculationStart);
          return reference;
        },
        compare:(candidate,reference)=>{
          const {accepted,inputs,scope}=candidate;
          const result=reference.indicators?.find(x=>x.name===accepted.name);
          assert.ok(result,'reference must include the accepted study');
          const series=new Map(result.series.map(s=>[s.key,new Map(s.values.map(p=>[p.time,p]))]));
          const expected=new Map(reference.bars.map(bar=>{
            const point=key=>series.get(key)?.get(bar.start)?.value??null;
            let values;
            if(/supertrend/i.test(accepted.name)){
              const broken=key=>series.get(key)?.get(bar.start)?.break_before?null:point(key);
              const up=broken('up'),down=broken('down'),fill=broken('fill_reference');
              values=[up,down,fill,inputs.highlighting?up:null,inputs.highlighting?down:null,
                point('buy_price'),point('sell_price'),inputs.showsignals?point('buy_price'):null,inputs.showsignals?point('sell_price'):null];
            }else values=result.series.map(s=>point(s.key));
            return [bar.chart_time??bar.start,{values,bar}];
          }));
          const native=new Map(candidate.native.map(row=>[Math.round(row[0]*1000),row.slice(1)]));
          let valid=0,mismatches=0,missing=0,priceMismatches=0;const samples=[];
          for(const row of candidate.main){
            const time=Math.round(row[0]*1000),entry=expected.get(time),actual=native.get(time);
            if(!entry||!actual){missing++;continue;}
            if(['open','high','low','close'].some((key,i)=>Number(entry.bar[key])!==row[i+1]))priceMismatches++;
            entry.values.forEach((value,i)=>{
              if(Number.isFinite(value))valid++;
              if(value!==actual[i]){mismatches++;if(samples.length<8)samples.push({time,index:i,expected:value,actual:actual[i]});}
            });
          }
          return {index:c.index,studyId:id,rows:candidate.main.length,valid,missing,priceMismatches,mismatches,samples,
            generation:scope.generation,acceptedGeneration:accepted.generation,coverage:scope.coverage,
            first:scope.first,last:scope.last,count:scope.count,viewport:candidate.viewport,
            identity:accepted.identity,credential:accepted.credential,revision:accepted.revision};
        },
      });
      const comparison=sampled.result;
      assert.equal(comparison.rows,comparison.count,'reference must cover every current main row');
      assert.equal(comparison.missing,0,'native/reference must include every current main time');
      assert.equal(comparison.priceMismatches,0,'reference prices must match accepted main prices');
      assert.ok(comparison.valid>0,'comparison must contain valid values');
      assert.equal(comparison.mismatches,0,JSON.stringify(comparison.samples));
      assert.equal(comparison.generation,comparison.acceptedGeneration);
      for(const key of ['first','last','count'])assert.equal(comparison.coverage[key],comparison[key],'native coverage '+key);
      checks.push(comparison);
    }
    return checks;
  }
  async function state(){return frame.evaluate(()=>({
    accepted:issue89Trace, reloads:issue89Reloads,
    charts:Array.from({length:widget.chartsCount()},(_,i)=>{
      const c=widget.chart(i),model=c._chartWidget.model().model(),data=model.mainSeries().data();
      const rows=[];data.each((_,row)=>{rows.push(row.slice(0,6));});
      return {index:i,symbol:c.symbol(),resolution:c.resolution(),ready:c.dataReady(),viewport:c.getVisibleRange(),
        mainRows:rows.length,mainFingerprint:JSON.stringify(rows),studies:c.getAllStudies().map(s=>{
          const source=model.dataSourceForId(s.id),d=source.data(),values=[];
          d.each((_,row)=>{values.push(row);});
          return {id:s.id,name:s.name,scope:MWNativeIndicatorResults.scope(c,s.id),
            rows:values.length,valid:values.reduce((n,row)=>n+row.slice(1).filter(Number.isFinite).length,0)};
        })};
    })}));}
  async function checkpoint(name,{deadline=Date.now()+45000,marks={}}={}){
    activeStage=name;
    report.currentCheckpoint={name,deadline,started:Date.now()};save();
    await verifyNative(deadline,marks);
    // The real coordinator polls every 500ms. Retain frames across more than
    // two periods, then require a final stable current-generation comparison.
    for(let offset=0;offset<3;offset++){
      await page.screenshot({path:path.join(OUT,name+'-settled-'+offset+'.png')});
      const seen=await state();
      report.renderFrames.push({name,file:name+'-settled-'+offset+'.png',at:Date.now(),
        charts:seen.charts.map(c=>({index:c.index,ready:c.ready,valid:c.studies.map(s=>s.valid)}))});
      if(offset<2)await page.waitForTimeout(600);
    }
    const nativeChecks=await verifyNative(deadline,marks);
    const s=await state();
    for(const c of s.charts){assert.ok(c.ready&&c.mainRows>0);assert.ok(c.studies.some(x=>x.valid>0));}
    // The full fingerprint is used in-process only; evidence keeps bounded summaries.
    report.stages.push({name,at:Date.now(),...s,nativeChecks,charts:s.charts.map(({mainFingerprint,...c})=>c)});
    await page.screenshot({path:path.join(OUT,name+'.png')});save();return {...s,nativeChecks};
  }
  async function withFrames(name,run){
    activeStage=name;
    await page.screenshot({path:path.join(OUT,name+'-before.png')});
    let running=true;
    const capture=(async()=>{
      for(let number=0;running&&number<100;number++){
        const file=name+'-during-'+String(number).padStart(3,'0')+'.png';
        await page.screenshot({path:path.join(OUT,file)});
        const seen=await state();
        report.renderFrames.push({name,file,at:Date.now(),
          charts:seen.charts.map(c=>({index:c.index,ready:c.ready,valid:c.studies.map(s=>s.valid)}))});
        await page.waitForTimeout(400);
      }
    })();
    try{return await run();}finally{running=false;await capture;save();}
  }
  function otherStable(before,after,index){
    const other=1-index;
    assert.equal(after.charts[other].mainFingerprint,before.charts[other].mainFingerprint,'unaffected pane prices');
    assert.equal(after.charts[other].studies[0].id,before.charts[other].studies[0].id,'unaffected study');
    assert.equal(after.charts[other].studies[0].scope.generation,before.charts[other].studies[0].scope.generation,'unaffected generation');
  }
  function visibleRetained(before,after,index){
    const a=before.charts[index],b=after.charts[index];
    const visible=JSON.parse(a.mainFingerprint).filter(row=>row[0]>=a.viewport.from&&row[0]<=a.viewport.to);
    const times=new Set(JSON.parse(b.mainFingerprint).map(row=>row[0]));
    assert.ok(visible.length>0,'original viewport must contain prices');
    assert.ok(visible.every(row=>times.has(row[0])),'original visible interval must remain covered');
    assert.deepEqual(b.viewport,a.viewport,'correction must preserve original viewport');
    report.stages.push({name:'visible-range-preserved',index,viewport:a.viewport,
      visibleRows:visible.length,mainRowsBefore:a.mainRows,mainRowsAfter:b.mainRows});
  }
  async function boundReference(snapshot,index,deadline){
    await Promise.all(pending);
    const id=snapshot.charts[index].studies[0].id,scope=snapshot.charts[index].studies[0].scope;
    const accepted=snapshot.accepted.findLast(x=>x.accepted&&x.studyId===id&&x.generation===scope.generation);
    assert.ok(accepted);
    const observed=observations.findLast(({summary:h})=>h.status===200&&h.credential===accepted.credential&&
      h.revision===accepted.revision&&sameConsumer(h,accepted,id));
    assert.ok(observed);
    const query={instrument:observed.q.instrument,series_kind:'provider',timeframe:observed.q.timeframe,
      indicators:observed.q.indicators,provider_snapshot_id:observed.b.provider_snapshot_id,
      calculation_origin:accepted.identity.calculationStart,before:scope.last+1,limit:scope.count};
    const value=await referenceRead(query,Math.max(1,deadline-Date.now()));
    return {query,value};
  }
  async function pushFreshPrice(index,deadline){
    const price=await referenceRead({instrument:'OANDA:AUD_JPY',series_kind:'provider',
      timeframe:index?'H4':'H1',limit:2000},Math.max(1,deadline-Date.now()));
    const subscription=await frame.evaluate(index=>{
      const chart=widget.chart(index),sub=[...subscriptions.values()].find(s=>s.symbol===chart.symbol()&&
        s.res===chart.resolution()&&!s.marketPaused&&!s.historical&&!s.needsHistoryReload);
      if(!sub)throw Error('active market subscription missing');
      return {listener:sub.marketListener,generation:sub.marketGeneration,
        sequence:sub.marketSequence+1,result_epoch:sub.marketResultEpoch};
    },index);
    await page.evaluate(({price,subscription,origin})=>{
      document.querySelector('iframe').contentWindow.postMessage({channel:'mw-chart-v1',type:'market-event',
        event:{...price,...subscription,type:'bars'}},origin);
    },{price,subscription,origin:CHART});
    report.stages.push({name:'price-update-transport',index,seam:'real API price page → parent postMessage → existing market-event/acceptMarketBars',
      credential:credentialRef(price.provider_snapshot_id),revision:price.input_revision??price.cache_revision,
      listener:credentialRef(subscription.listener),generation:subscription.generation,sequence:subscription.sequence,
      tail:price.bars.slice(-2).map(b=>({start:b.start,chart_time:b.chart_time,close:b.close,complete:b.complete}))});
    return price;
  }
  try{
    execFileSync('docker',['cp','scripts/issue89_acceptance_fixture.py',TASK+'-api-1:/tmp/issue89_acceptance_fixture.py']);
    fixture('seed','H1',['--rollover-ready']);
    observer=startFixtureObserver();await observer.ready;
    const secret=JSON.parse(fs.readFileSync(path.join(process.env.HOME,
      '.local/share/market-watch-docker/previews',TASK,'credentials.json')));
    const login=await context.request.post(APP+'/api/login',{data:{password:secret.login_password}});
    assert.ok(login.ok());const {csrf}=await login.json();
    async function api(p,data,timeout=45000){const r=await context.request.post(APP+'/api/'+p,
      {headers:{'X-CSRF-Token':csrf},data,timeout});assert.ok(r.ok(),p+' '+r.status());return r.json();}
    referenceRead=(data,timeout)=>api('charts/data',data,timeout);
    const w=await api('advanced-charts/workspaces',{name:'Issue89 native acceptance'});
    await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,
      document:{engine:'tv31',schemaVersion:1,symbol:'MWP:OANDA:AUD_JPY',series_kind:'provider',interval:'60'}});
    await page.goto(APP+'/advanced-charts/'+w.id);
    await page.frameLocator('iframe').locator('#chart').waitFor({timeout:30000});
    frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));assert.ok(frame);
    await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:45000});
    await frame.evaluate(()=>{
      globalThis.issue89Trace=[];globalThis.issue89Reloads=[];globalThis.issue89Events=[];
      let eventSequence=0;
      const event=details=>issue89Events.push({sequence:++eventSequence,at:Date.now(),...details});
      const owners=new WeakMap(),latest=new WeakMap(),engines=new WeakMap();
      const attach=MWNativeIndicatorResults.attach,startNative=MWNativeIndicatorResults.start;
      MWNativeIndicatorResults.start=function(engine,symbol,res,body,session,source,turn,parent,...rest){
        let records=engines.get(engine);if(!records){records=new Map();engines.set(engine,records);}
        const key=session+'|'+source,previous=records.get(key);
        const before=previous?.chart?MWNativeIndicatorResults.scope(previous.chart,previous.id):null;
        const accepted=startNative.call(this,engine,symbol,res,body,session,source,turn,parent,...rest);
        if(accepted){
          event({event:'start',source,session,resolution:res,parent,turnaround:turn,
            previousGeneration:before?.generation??previous?.generation??null,
            previousCoverage:before?.coverage??previous?.coverage??null});
          records.set(key,{...previous,source,session,parent});
        }
        return accepted;
      };
      MWNativeIndicatorResults.attach=function(chart,id,...args){
        const owner=chart._chartWidget||chart;
        let studies=latest.get(owner);if(!studies){studies=new Map();latest.set(owner,studies);}
        const previous=studies.get(id),handle=attach.call(this,chart,id,...args);
        const originOnly=previous&&previous.generation!==handle.generation&&previous.identity.calculationStart===0&&
          handle.identity.calculationStart>0&&['main','fixedRevision','paramsFingerprint','algorithmVersion','period']
            .every(key=>previous.identity[key]===handle.identity[key]);
        owners.set(handle,{chart,id,establishedOriginFrom:originOnly?previous.generation:null});
        studies.set(id,handle);
        const study=chart._chartWidget.model().model().dataSourceForId(id),api=study._chartApi;
        const engine=api.chartApi()._studyEngine,key=api.sessionId()+'|'+study.sourceId();
        let records=engines.get(engine);if(!records){records=new Map();engines.set(engine,records);}
        records.set(key,{...records.get(key),chart,id,generation:handle.generation,
          coverage:MWNativeIndicatorResults.scope(chart,id)?.coverage});
        event({event:'attach',studyId:id,generation:handle.generation,previousGeneration:previous?.generation,
          identity:handle.identity,originOnly:!!originOnly});
        return handle;
      };
      const detach=MWNativeIndicatorResults.detach;
      MWNativeIndicatorResults.detach=function(handle,...args){
        const result=detach.call(this,handle,...args);
        event({event:'detach',studyId:owners.get(handle)?.id,generation:handle.generation});return result;
      };
      const original=MWNativeIndicatorResults.applyBatch;
      MWNativeIndicatorResults.applyBatch=async function(handle,batch){
        const owner=owners.get(handle);
        const start=Date.now(),accepted=await original.call(this,handle,batch),acceptedAt=Date.now();
        const digest=batch.displaySnapshot?await crypto.subtle.digest('SHA-256',new TextEncoder().encode(batch.displaySnapshot)):null;
        const credential=digest?Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('').slice(0,16):null;
        issue89Trace.push({start,acceptedAt,elapsed:acceptedAt-start,accepted,generation:batch.generation,
          studyId:owner?.id,name:owner?MWNativeIndicatorResults.scope(owner.chart,owner.id)?.name:null,
          chartIndex:owner?Array.from({length:widget.chartsCount()},(_,i)=>i).find(i=>
            (widget.chart(i)._chartWidget||widget.chart(i))===(owner.chart._chartWidget||owner.chart)):null,
          establishedOriginFrom:owner?.establishedOriginFrom??null,
          identity:batch.identity,coverage:batch.coverage,revision:String(batch.inputRevision),credential,
          rows:batch.rows.length,valid:batch.rows.reduce((n,r)=>n+r.valid.filter(Boolean).length,0)});
        event({event:'applyBatch',studyId:owner?.id,accepted,generation:batch.generation,
          observedGeneration:owner?MWNativeIndicatorResults.scope(owner.chart,owner.id)?.generation:null,
          identity:batch.identity,revision:String(batch.inputRevision),credential,coverage:batch.coverage});
        return accepted;
      };
      const reload=reloadHistory;
      reloadHistory=async function(symbol,res,...args){issue89Reloads.push({symbol,res,at:Date.now()});return reload(symbol,res,...args);};
      widget.dateRangeSync().setValue(false);widget.symbolSync().setValue(false);
      widget.intervalSync().setValue(false);widget.setLayout('2h');
    });
    await frame.waitForFunction(()=>widget.chartsCount()===2);
    await frame.evaluate(async()=>{
      for(let i=0;i<2;i++){
        const c=widget.chart(i);await c.setSymbol('MWP:OANDA:AUD_JPY',{doNotActivateChart:true});
        await c.setResolution(i?'240':'60',{doNotActivateChart:true});
      }
    });
    await frame.waitForFunction(()=>widget.chart(0).dataReady()&&widget.chart(1).dataReady(),null,{timeout:45000});
    report.names=await frame.evaluate(()=>widget.getStudiesList().filter(n=>/Supertrend|Swing/i.test(n)));
    await frame.evaluate(async()=>{
      const names=widget.getStudiesList();
      for(let i=0;i<2;i++){
        const name=names.find(n=>n.startsWith('守望 Python')&&(i?/Swing/i:/Supertrend/i).test(n));
        if(!name)throw Error('Python study missing');await widget.chart(i).createStudy(name,false,false);
      }
    });
    let before=await checkpoint('initial');
    if(SCENARIO==='full'){
      // Real expiry, unchanged prices: renewal may keep a content-addressed hash.
      let mark=before.accepted.length;const began=Date.now(),deadline=began+45000;
      fixture('expire');
      const studyId=before.charts[0].studies[0].id;
      const renewed=await withFrames('credential-renewal',async()=>{
        await frame.evaluate(()=>indicatorCoordinator.retry(0));
        return checkpoint('credential-renewal',{deadline,marks:{0:mark}});
      });
      await recoveryEvidence('credential-renewal',began,mark,'60',studyId);
      assert.equal(renewed.reloads.length,before.reloads.length);
      assert.equal(renewed.charts[0].mainFingerprint,before.charts[0].mainFingerprint);
      assert.equal(renewed.charts[0].studies[0].scope.generation,before.charts[0].studies[0].scope.generation);
      otherStable(before,renewed,0);before=renewed;
      for(const index of [0,1]){
        const name='equivalent-'+(index?'H4':'H1'),deadline=Date.now()+45000;
        mark=before.accepted.length;
        const original=await boundReference(before,index,deadline);
        fixture('equivalent',index?'H4':'H1');
        const retained=await referenceRead(original.query,Math.max(1,deadline-Date.now()));
        assert.deepEqual(retained.bars,original.value.bars,'equivalent write preserves old price credential');
        await frame.evaluate(index=>indicatorCoordinator.retry(index),index);
        const equivalent=await checkpoint(name,{deadline,marks:{[index]:mark}});
        assert.equal(equivalent.charts[index].mainFingerprint,before.charts[index].mainFingerprint);
        assert.equal(equivalent.reloads.length,before.reloads.length);
        assert.equal(equivalent.charts[index].studies[0].scope.generation,before.charts[index].studies[0].scope.generation);
        otherStable(before,equivalent,index);before=equivalent;
      }
    }
    for(const index of [0,1]){
      const name='real-correction-'+(index?'H4':'H1'),mark=before.accepted.length;
      const began=Date.now(),deadline=began+45000,studyId=before.charts[index].studies[0].id;
      const corrected=await withFrames(name,async()=>{
        fixture('correct',index?'H4':'H1');
        await frame.evaluate(index=>indicatorCoordinator.retry(index),index);
        return checkpoint(name,{deadline,marks:{[index]:mark}});
      });
      await recoveryEvidence(name,began,mark,index?'240':'60',studyId);
      assert.notEqual(corrected.charts[index].mainFingerprint,before.charts[index].mainFingerprint);
      assert.equal(corrected.charts[index].studies[0].id,studyId);
      visibleRetained(before,corrected,index);otherStable(before,corrected,index);
      report.stages.push({name:name+'-elapsed',elapsed:Date.now()-began});before=corrected;
    }
    if(SCENARIO==='full'){
      for(const index of [0,1])for(const operation of ['tail','rollover']){
        const name=operation+'-'+(index?'H4':'H1'),mark=before.accepted.length,deadline=Date.now()+45000;
        const original=await boundReference(before,index,deadline);
        const previousTail=original.value.bars.at(-1);
        assert.equal(previousTail.complete,false,'update begins from an unconfirmed tail');
        const updated=await withFrames(name,async()=>{
          fixture(operation,index?'H4':'H1');
          const retained=await referenceRead(original.query,Math.max(1,deadline-Date.now()));
          assert.deepEqual(retained.bars,original.value.bars,'old snapshot retains its accepted prices');
          assert.deepEqual(retained.indicators.map(i=>i.series),original.value.indicators.map(i=>i.series),
            'old snapshot retains its accepted indicator values');
          const fresh=await pushFreshPrice(index,deadline),tail=fresh.bars.at(-1);
          assert.equal(tail.complete,false);
          assert.equal(tail.chart_time,tail.start,'native intraday source label');
          if(operation==='tail'){
            assert.equal(tail.start,previousTail.start);assert.notEqual(tail.close,previousTail.close);
          }else{
            assert.ok(tail.start>previousTail.start&&tail.start<=Date.now(),'legal already-started next candle');
            const completed=fresh.bars.find(b=>b.start===previousTail.start);
            assert.equal(completed.complete,true);assert.equal(completed.source_confirmed,true);
          }
          return checkpoint(name,{deadline,marks:{[index]:mark}});
        });
        assert.notEqual(updated.charts[index].mainFingerprint,before.charts[index].mainFingerprint);
        assert.equal(updated.charts[index].studies[0].id,before.charts[index].studies[0].id);
        assert.equal(updated.charts[index].studies[0].scope.generation,before.charts[index].studies[0].scope.generation);
        assert.equal(updated.reloads.length,before.reloads.length,'tail updates must use the existing update seam');
        otherStable(before,updated,index);before=updated;
        report.stages.push({name:name+'-old-binding-preserved',credential:credentialRef(original.query.provider_snapshot_id),
          rows:original.value.bars.length,last:previousTail.start});
      }
      const fault={started:Date.now(),requests:[],inflight:0};report.fault=fault;
      const pattern=/\/api\/charts\/(?:data|history-loads)$/;
      const inject=async route=>{
        const request=route.request(),data=request.postDataJSON(),q=data?.query??data;
        if(q?.instrument!=='OANDA:AUD_JPY'||q.timeframe!=='H1'||q.provider_snapshot_id||q.indicators?.length){
          await route.continue();return;
        }
        const attempt={at:Date.now(),path:new URL(request.url()).pathname,
          kind:q.native_history?'native-history':'price-comparison'};
        fault.requests.push(attempt);fault.inflight++;
        try{await route.abort('failed');}finally{attempt.ended=Date.now();fault.inflight--;}
      };
      const mark=before.accepted.length,studyId=before.charts[0].studies[0].id;
      let failureState;
      await page.route(pattern,inject);
      try{
        fixture('expire');
        await withFrames('budget-exhaustion',async()=>{
          await frame.evaluate(()=>indicatorCoordinator.retry(0));
          await frame.waitForFunction(()=>[...displayRecoveries.values()].some(r=>r.state==='error'),null,{timeout:45000});
          await page.getByRole('complementary',{name:'图格指标状态'}).getByRole('button',{name:'重试指标'}).first().waitFor();
        });
        await Promise.all(pending);failureState=await state();
        const rejected=report.http.filter(h=>h.started>=fault.started&&h.frame==='H1'&&h.status===422&&h.code==='DISPLAY_SNAPSHOT_EXPIRED');
        assert.ok(rejected.length>0,'failure must begin with actual TTL 422');
        assert.equal(failureState.reloads.length-before.reloads.length,3,'three logical reload attempts');
        assert.ok(fault.requests.some(x=>x.kind==='price-comparison'));
        assert.ok(fault.requests.some(x=>x.kind==='native-history'));
        assert.equal(fault.inflight,0);
        const count=fault.requests.length,quietStarted=Date.now();
        await page.screenshot({path:path.join(OUT,'budget-exhaustion-error.png')});
        await page.waitForTimeout(11000);
        assert.equal(fault.requests.length,count,'automatic failed recovery must stop after work ends');
        assert.equal((await state()).reloads.length,failureState.reloads.length,'no further automatic logical reload');
        otherStable(before,await state(),0);
        report.stages.push({name:'budget-exhaustion',logicalReloads:3,
          comparisonHttp:fault.requests.filter(r=>r.kind==='price-comparison').length,
          historyHttp:fault.requests.filter(r=>r.kind==='native-history').length,
          indicatorHttp:report.http.filter(h=>h.started>=fault.started&&h.frame==='H1'&&h.indicators.length).length,
          quietStarted,quietMilliseconds:Date.now()-quietStarted,automaticRequestsBefore:count,automaticRequestsAfter:fault.requests.length,
          actualUiRetryVisible:true});
      }finally{await page.unroute(pattern,inject);fault.removed=Date.now();}
      const retryStarted=Date.now(),deadline=retryStarted+45000;
      const recovered=await withFrames('manual-ui-retry',async()=>{
        await page.getByRole('complementary',{name:'图格指标状态'}).getByRole('button',{name:'重试指标'}).first().click();
        return checkpoint('manual-ui-retry',{deadline,marks:{0:mark}});
      });
      await recoveryEvidence('manual-ui-retry',fault.started,mark,'60',studyId);
      otherStable(before,recovered,0);
      assert.equal(await page.getByRole('complementary',{name:'图格指标状态'}).getByRole('button',{name:'重试指标'}).count(),0);
      report.stages.push({name:'manual-ui-retry-elapsed',elapsed:Date.now()-retryStarted,
        seam:'React button → retry-chart-indicators message → existing recovery/coordinator'});
      before=recovered;
    }
    await Promise.all(pending);
    assert.ok(report.http.filter(x=>x.status===422).every(x=>x.code==='DISPLAY_SNAPSHOT_EXPIRED'));
    assert.deepEqual(report.errors,[]);
    report.lifecycle=await frame.evaluate(()=>globalThis.issue89Events);
    report.passed=true;
  }catch(e){report.failure=e.stack;
    if(frame){
      report.bootstrap=await frame.evaluate(()=>({ready:typeof ready==='undefined'?null:ready,
        loading:typeof loading==='undefined'?null:loading,widget:typeof widget!=='undefined'&&!!widget,
        pending:typeof pending==='undefined'?null:pending.size,messages:globalThis.issue89Messages,
        charts:typeof widget!=='undefined'&&widget?Array.from({length:widget.chartsCount()},(_,i)=>{
          const chart=widget.chart(i);return {symbol:chart.symbol(),resolution:chart.resolution(),ready:chart.dataReady()};
        }):null})).catch(()=>null);
      report.failureState=await state().then(s=>({...s,charts:s.charts.map(({mainFingerprint,...c})=>c)})).catch(()=>null);
      report.lifecycle=await frame.evaluate(()=>globalThis.issue89Events).catch(()=>null);
    }
    if(frame)report.debug=await frame.evaluate(()=>({ready:typeof ready==='undefined'?null:ready,
      trace:globalThis.issue89Trace,recoveries:typeof displayRecoveries==='undefined'?null:
        [...displayRecoveries.values()].map(x=>({state:x.state}))})).catch(()=>null);
    await page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw e;
  }finally{
    await browser.close();
    if(observer)await observer.stop();
    await Promise.allSettled(pending);save();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
