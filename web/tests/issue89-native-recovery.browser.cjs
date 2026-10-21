// Real React/RPC/backend/PG/native adapter/canvas; synthetic, offline OANDA input.
// Run only against the task-owned preview described in the verification record.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const APP='https://localhost:18389',CHART='https://localhost:18390';
const TASK='mw-issue89-20261021';
const OUT=process.env.ISSUE89_OUTPUT||'/tmp/issue89-native';
fs.mkdirSync(OUT,{recursive:true});
const report={app:APP,chart:CHART,task:TASK,input:'synthetic offline OANDA; no real upstream',
  source:execFileSync('git',['rev-parse','HEAD']).toString().trim(),http:[],stages:[],errors:[]};
const credentialRef=value=>value?createHash('sha256').update(value).digest('hex').slice(0,16):null;
const sameConsumer=(http,accepted,id)=>http.consumer?.some(c=>c.id.endsWith('|'+id)&&
  (c.generation===accepted.generation||c.generation===accepted.establishedOriginFrom&&
    http.origin===accepted.identity.calculationStart));
// Raw response values/credentials stay in memory, never in the evidence file.
const observations=[];
function fixture(operation,frame='H1'){
  const result=execFileSync('docker',['exec',TASK+'-api-1','python',
    '/tmp/issue89_acceptance_fixture.py',operation,'--frame',frame],{timeout:30000}).toString();
  report.stages.push({fixture:operation,frame,result:JSON.parse(result)});
}
const save=()=>fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:960}});
  const page=await context.newPage();let frame,referenceRead;
  const pending=[];
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('response',r=>{
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
  async function acceptedSince(mark,res,studyId){
    await frame.waitForFunction(({mark,res,studyId})=>issue89Trace.slice(mark).some(x=>
      x.accepted&&x.identity.period===res&&(!studyId||x.studyId===studyId)&&x.valid>0),
      {mark,res,studyId},{timeout:45000});
    await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
  }
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
  async function verifyNative(){
    await Promise.all(pending);
    const checks=[];
    for(const c of await frame.evaluate(()=>Array.from({length:widget.chartsCount()},(_,index)=>{
      const chart=widget.chart(index);return {index,inputs:chart.getAllStudies().map(s=>
        ({id:s.id,values:Object.fromEntries(chart.getStudyById(s.id).getInputValues().map(x=>[x.id,x.value]))}))};
    }))){
      for(const input of c.inputs){
        const accepted=await frame.evaluate(({id,index})=>issue89Trace.findLast(x=>x.chartIndex===index&&
          x.studyId===id&&x.accepted&&x.valid>0),{id:input.id,index:c.index});
        assert.ok(accepted,'study has no accepted result');
        const pages=observations.filter(({summary:h})=>h.status===200&&h.credential===accepted.credential&&
          h.revision===accepted.revision&&sameConsumer(h,accepted,input.id));
        assert.ok(pages.length,'accepted batch must match an observed HTTP result');
        const scope=await frame.evaluate(({index,id})=>MWNativeIndicatorResults.scope(widget.chart(index),id),{index:c.index,id:input.id});
        assert.ok(scope.count<=2000,'reference read must cover the complete native range');
        // A retry can append only one tail row. Independently read the complete
        // accepted credential so stale native values outside that batch fail too.
        const {q,b}=pages.at(-1);
        const reference=await referenceRead({instrument:q.instrument,series_kind:'provider',published:false,
          timeframe:q.timeframe,indicators:q.indicators,provider_snapshot_id:b.provider_snapshot_id,
          calculation_origin:accepted.identity.calculationStart,
          before:scope.last+1,limit:scope.count});
        assert.equal(credentialRef(reference.provider_snapshot_id),accepted.credential);
        assert.equal(String(reference.input_revision??reference.cache_revision??reference.revision),accepted.revision);
        assert.equal(reference.calculation_origin??reference.origin,accepted.identity.calculationStart);
        const expected=new Map();
        const result=reference.indicators?.find(x=>x.name===accepted.name);
        assert.ok(result,'reference calculation must include the accepted study');
        const series=new Map(result.series.map(s=>[s.key,new Map(s.values.map(p=>[p.time,p]))]));
        for(const bar of reference.bars){
          const point=key=>{const p=series.get(key)?.get(bar.start);return p?.value??null;};
          let values;
          if(/supertrend/i.test(accepted.name)){
            const broken=key=>series.get(key)?.get(bar.start)?.break_before?null:point(key);
            const up=broken('up'),down=broken('down'),fill=broken('fill_reference');
            values=[up,down,fill,input.values.highlighting?up:null,input.values.highlighting?down:null,
              point('buy_price'),point('sell_price'),input.values.showsignals?point('buy_price'):null,input.values.showsignals?point('sell_price'):null];
          }else values=result.series.map(s=>point(s.key));
          expected.set(bar.chart_time??bar.start,values);
        }
        const comparison=await frame.evaluate(({index,id,expected})=>{
          const chart=widget.chart(index),model=chart._chartWidget.model().model();
          const main=new Set();model.mainSeries().data().each((_,row)=>{main.add(Math.round(row[0]*1000));});
          const actual=new Map();model.dataSourceForId(id).data().each((_,row)=>{actual.set(Math.round(row[0]*1000),row.slice(1));});
          let rows=0,valid=0,mismatches=0;
          for(const [time,values] of expected){if(!main.has(time))continue;rows++;
            const row=actual.get(time);values.forEach((v,i)=>{
              if(Number.isFinite(v))valid++;
              if(!row||v!==row[i])mismatches++;
            });
          }
          const scope=MWNativeIndicatorResults.scope(chart,id);
          return {rows,valid,mismatches,generation:scope?.generation,coverage:scope?.coverage,
            first:scope?.first,last:scope?.last,count:scope?.count};
        },{index:c.index,id:input.id,expected:[...expected]});
        assert.equal(comparison.rows,scope.count,'reference calculation must cover every native main row');
        assert.ok(comparison.valid>0,'reference/native comparison must contain valid values');
        assert.equal(comparison.mismatches,0,'native values must equal the accepted HTTP calculation');
        assert.equal(comparison.generation,accepted.generation);
        for(const key of ['first','last','count'])assert.equal(comparison.coverage[key],comparison[key],'native coverage '+key);
        checks.push({index:c.index,studyId:input.id,...comparison});
      }
    }
    return checks;
  }
  async function state(){return frame.evaluate(()=>({
    accepted:issue89Trace, reloads:issue89Reloads,
    charts:Array.from({length:widget.chartsCount()},(_,i)=>{
      const c=widget.chart(i),model=c._chartWidget.model().model(),data=model.mainSeries().data();
      const rows=[];data.each((_,row)=>{rows.push(row.slice(0,6));});
      return {index:i,symbol:c.symbol(),resolution:c.resolution(),ready:c.dataReady(),
        mainRows:rows.length,mainFingerprint:JSON.stringify(rows),studies:c.getAllStudies().map(s=>{
          const source=model.dataSourceForId(s.id),d=source.data(),values=[];
          d.each((_,row)=>{values.push(row);});
          return {id:s.id,name:s.name,scope:MWNativeIndicatorResults.scope(c,s.id),
            rows:values.length,valid:values.reduce((n,row)=>n+row.slice(1).filter(Number.isFinite).length,0)};
        })};
    })}));}
  async function checkpoint(name){
    const s=await state();
    for(const c of s.charts){assert.ok(c.ready&&c.mainRows>0);assert.ok(c.studies.some(x=>x.valid>0));}
    const nativeChecks=await verifyNative();
    // The full fingerprint is used in-process only; evidence keeps bounded summaries.
    report.stages.push({name,at:Date.now(),...s,nativeChecks,charts:s.charts.map(({mainFingerprint,...c})=>c)});
    await page.screenshot({path:path.join(OUT,name+'.png')});save();return s;
  }
  try{
    const secret=JSON.parse(fs.readFileSync(path.join(process.env.HOME,
      '.local/share/market-watch-docker/previews',TASK,'credentials.json')));
    const login=await context.request.post(APP+'/api/login',{data:{password:secret.login_password}});
    assert.ok(login.ok());const {csrf}=await login.json();
    async function api(p,data){const r=await context.request.post(APP+'/api/'+p,
      {headers:{'X-CSRF-Token':csrf},data});assert.ok(r.ok(),p+' '+r.status());return r.json();}
    referenceRead=data=>api('charts/data',data);
    const w=await api('advanced-charts/workspaces',{name:'Issue89 native acceptance'});
    await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,
      document:{engine:'tv31',schemaVersion:1,symbol:'MWP:OANDA:AUD_JPY',series_kind:'provider',interval:'60'}});
    await page.goto(APP+'/advanced-charts');
    await page.frameLocator('iframe').locator('#chart').waitFor({timeout:30000});
    frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));assert.ok(frame);
    await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:45000});
    await frame.evaluate(()=>{
      globalThis.issue89Trace=[];globalThis.issue89Reloads=[];
      const owners=new WeakMap(),latest=new WeakMap(),attach=MWNativeIndicatorResults.attach;
      MWNativeIndicatorResults.attach=function(chart,id,...args){
        const owner=chart._chartWidget||chart;
        let studies=latest.get(owner);if(!studies){studies=new Map();latest.set(owner,studies);}
        const previous=studies.get(id),handle=attach.call(this,chart,id,...args);
        const originOnly=previous&&previous.generation!==handle.generation&&previous.identity.calculationStart===0&&
          handle.identity.calculationStart>0&&['main','fixedRevision','paramsFingerprint','algorithmVersion','period']
            .every(key=>previous.identity[key]===handle.identity[key]);
        owners.set(handle,{chart,id,establishedOriginFrom:originOnly?previous.generation:null});
        studies.set(id,handle);return handle;
      };
      const original=MWNativeIndicatorResults.applyBatch;
      MWNativeIndicatorResults.applyBatch=async function(handle,batch){
        const owner=owners.get(handle);
        const start=Date.now(),accepted=await original.call(this,handle,batch);
        const digest=batch.displaySnapshot?await crypto.subtle.digest('SHA-256',new TextEncoder().encode(batch.displaySnapshot)):null;
        const credential=digest?Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('').slice(0,16):null;
        issue89Trace.push({start,elapsed:Date.now()-start,accepted,generation:batch.generation,
          studyId:owner?.id,name:owner?MWNativeIndicatorResults.scope(owner.chart,owner.id)?.name:null,
          chartIndex:owner?Array.from({length:widget.chartsCount()},(_,i)=>i).find(i=>
            (widget.chart(i)._chartWidget||widget.chart(i))===(owner.chart._chartWidget||owner.chart)):null,
          establishedOriginFrom:owner?.establishedOriginFrom??null,
          identity:batch.identity,coverage:batch.coverage,revision:String(batch.inputRevision),credential,
          rows:batch.rows.length,valid:batch.rows.reduce((n,r)=>n+r.valid.filter(Boolean).length,0)});
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
    await acceptedSince(0,'60');await acceptedSince(0,'240');
    let before=await checkpoint('initial');
    let mark=before.accepted.length;
    fixture('equivalent');
    await frame.evaluate(()=>indicatorCoordinator.retry(0));await acceptedSince(mark,'60');
    const equivalent=await checkpoint('equivalent');
    assert.equal(equivalent.charts[0].mainFingerprint,before.charts[0].mainFingerprint);
    assert.equal(equivalent.reloads.length,before.reloads.length);
    // Actual DB TTL expiry, unchanged prices: real 422 and credential-only renewal.
    fixture('expire');mark=equivalent.accepted.length;const renewalStart=Date.now();
    const studyId=equivalent.charts[0].studies[0].id;
    await frame.evaluate(()=>indicatorCoordinator.retry(0));await acceptedSince(mark,'60',studyId);
    await recoveryEvidence('credential-renewal',renewalStart,mark,'60',studyId);
    const renewed=await checkpoint('credential-renewal');
    assert.equal(renewed.reloads.length,equivalent.reloads.length);
    assert.equal(renewed.charts[0].mainFingerprint,equivalent.charts[0].mainFingerprint);
    assert.equal(renewed.charts[0].studies[0].scope.generation,equivalent.charts[0].studies[0].scope.generation);
    assert.equal(renewed.charts[1].mainFingerprint,before.charts[1].mainFingerprint);
    // Genuine persisted early OHLC correction: old token must fail, then native acceptance.
    fixture('correct');mark=renewed.accepted.length;const began=Date.now();
    await frame.evaluate(()=>indicatorCoordinator.retry(0));await acceptedSince(mark,'60',studyId);
    await recoveryEvidence('real-correction',began,mark,'60',studyId);
    const corrected=await checkpoint('real-correction');
    assert.notEqual(corrected.charts[0].mainFingerprint,renewed.charts[0].mainFingerprint);
    assert.equal(corrected.charts[0].studies[0].id,renewed.charts[0].studies[0].id);
    assert.equal(corrected.charts[1].mainFingerprint,renewed.charts[1].mainFingerprint);
    assert.equal(corrected.charts[1].studies[0].scope.generation,renewed.charts[1].studies[0].scope.generation);
    report.correctionRecoveryMs=Date.now()-began;
    await Promise.all(pending);
    assert.ok(report.http.filter(x=>x.status===422).every(x=>x.code==='DISPLAY_SNAPSHOT_EXPIRED'));
    assert.deepEqual(report.errors,[]);
    report.passed=true;
  }catch(e){report.failure=e.stack;
    if(frame)report.debug=await frame.evaluate(()=>({ready:typeof ready==='undefined'?null:ready,
      trace:globalThis.issue89Trace,recoveries:typeof displayRecoveries==='undefined'?null:
        [...displayRecoveries.values()].map(x=>({state:x.state}))})).catch(()=>null);
    await page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw e;
  }finally{await Promise.allSettled(pending);save();await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
