// Real React/RPC/backend/PG/native adapter/canvas; synthetic, offline OANDA input.
// Run only against the task-owned preview described in the verification record.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const APP='https://localhost:18389',CHART='https://localhost:18390';
const TASK='mw-issue89-20261021';
const OUT=process.env.ISSUE89_OUTPUT||'/tmp/issue89-native';
fs.mkdirSync(OUT,{recursive:true});
const report={app:APP,chart:CHART,task:TASK,input:'synthetic offline OANDA; no real upstream',
  source:execFileSync('git',['rev-parse','HEAD']).toString().trim(),http:[],stages:[],errors:[]};
function fixture(operation,frame='H1'){
  const result=execFileSync('docker',['exec',TASK+'-api-1','python',
    '/tmp/issue89_acceptance_fixture.py',operation,'--frame',frame],{timeout:30000}).toString();
  report.stages.push({fixture:operation,frame,result:JSON.parse(result)});
}
const save=()=>fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(report,null,2));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1500,height:960}});
  const page=await context.newPage();let frame;
  const pending=[];
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('response',r=>{
    if(!r.url().includes('/api/charts/data'))return;
    pending.push((async()=>{
      const q=r.request().postDataJSON(),b=await r.json().catch(()=>({}));
      report.http.push({at:Date.now(),status:r.status(),frame:q.timeframe,
        indicators:q.indicators?.map(i=>i.name)||[],code:b.detail?.code,
        attempt:r.headers()['x-mw-attempt-ref'],bars:b.bars?.length,
        calculation:b.indicators?.map(i=>({name:i.name,coverage:i.calculation?.coverage,
          status:i.calculation?.status,valid:i.series.reduce((n,s)=>n+s.values.filter(p=>p.value!==null).length,0)}))});
    })());
  });
  async function acceptedSince(mark,res){
    await frame.waitForFunction(({mark,res})=>issue89Trace.slice(mark).some(x=>
      x.accepted&&x.identity.period===res&&x.valid>0),{mark,res},{timeout:45000});
    await frame.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
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
    // The full fingerprint is used in-process only; evidence keeps bounded summaries.
    report.stages.push({name,at:Date.now(),...s,charts:s.charts.map(({mainFingerprint,...c})=>c)});
    await page.screenshot({path:path.join(OUT,name+'.png')});save();return s;
  }
  try{
    const secret=JSON.parse(fs.readFileSync(path.join(process.env.HOME,
      '.local/share/market-watch-docker/previews',TASK,'credentials.json')));
    const login=await context.request.post(APP+'/api/login',{data:{password:secret.login_password}});
    assert.ok(login.ok());const {csrf}=await login.json();
    async function api(p,data){const r=await context.request.post(APP+'/api/'+p,
      {headers:{'X-CSRF-Token':csrf},data});assert.ok(r.ok(),p+' '+r.status());return r.json();}
    const w=await api('advanced-charts/workspaces',{name:'Issue89 native acceptance'});
    await api('advanced-charts/workspaces/'+w.id+'/save',{name:w.name,revision:w.revision,
      document:{engine:'tv31',schemaVersion:1,symbol:'MWP:OANDA:AUD_JPY',series_kind:'provider',interval:'60'}});
    await page.goto(APP+'/advanced-charts');
    await page.frameLocator('iframe').locator('#chart').waitFor({timeout:30000});
    frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));assert.ok(frame);
    await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:45000});
    await frame.evaluate(()=>{
      globalThis.issue89Trace=[];globalThis.issue89Reloads=[];
      const original=MWNativeIndicatorResults.applyBatch;
      MWNativeIndicatorResults.applyBatch=async function(handle,batch){
        const start=Date.now(),accepted=await original.call(this,handle,batch);
        issue89Trace.push({start,elapsed:Date.now()-start,accepted,generation:batch.generation,
          identity:batch.identity,coverage:batch.coverage,revision:batch.inputRevision,
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
    fixture('expire');mark=equivalent.accepted.length;
    await frame.evaluate(()=>indicatorCoordinator.retry(0));await acceptedSince(mark,'60');
    const renewed=await checkpoint('credential-renewal');
    assert.equal(renewed.reloads.length,equivalent.reloads.length);
    assert.equal(renewed.charts[0].mainFingerprint,equivalent.charts[0].mainFingerprint);
    assert.equal(renewed.charts[0].studies[0].scope.generation,equivalent.charts[0].studies[0].scope.generation);
    assert.equal(renewed.charts[1].mainFingerprint,before.charts[1].mainFingerprint);
    // Genuine persisted early OHLC correction: old token must fail, then native acceptance.
    fixture('correct');mark=renewed.accepted.length;const began=Date.now();
    await frame.evaluate(()=>indicatorCoordinator.retry(0));await acceptedSince(mark,'60');
    const corrected=await checkpoint('real-correction');
    assert.notEqual(corrected.charts[0].mainFingerprint,renewed.charts[0].mainFingerprint);
    assert.equal(corrected.charts[0].studies[0].id,renewed.charts[0].studies[0].id);
    assert.equal(corrected.charts[1].mainFingerprint,renewed.charts[1].mainFingerprint);
    assert.equal(corrected.charts[1].studies[0].scope.generation,renewed.charts[1].studies[0].scope.generation);
    report.correctionRecoveryMs=Date.now()-began;
    await Promise.all(pending);
    assert.ok(report.http.filter(x=>x.status===422).length>=2);
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
