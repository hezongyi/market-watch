// Disposable browser against an explicitly authorized mwa update. No market-data mocks.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, expect} = require('@playwright/test');
const {readOnlyAcceptance} = require('./helpers/readOnlyAcceptance.cjs');
const required = name => {if(!process.env[name]) throw Error('Required: '+name);return process.env[name];};
const base = new URL(required('MW_ACCEPTANCE_BASE_URL')).origin;
const chartOrigin = new URL(required('MW_ACCEPTANCE_CHART_ORIGIN')).origin;
const auth = JSON.parse(fs.readFileSync(required('MW_ACCEPTANCE_AUTH_FILE'), 'utf8'));
const out = path.resolve(required('MW_ACCEPTANCE_OUTPUT'));
const privateOut = path.resolve(required('MW_ACCEPTANCE_PRIVATE_OUTPUT'));
fs.mkdirSync(out,{recursive:true});
const params = {k:10,lookback:252,low_pct:5,confirm_on_close:true};
const report = {started_at:new Date().toISOString(),passed:false,errors:[],http_errors:[],cases:[]};
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({ignoreHTTPSErrors:false,viewport:{width:1600,height:1000}});
 await readOnlyAcceptance(context,report);
 const page=await context.newPage();
 const captures=[],pending=new Set(),loads=new Map();
 const stage=value=>{report.stage=value;console.log(new Date().toISOString(),value);};
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('response',response=>{
  const u=new URL(response.url());
  if(u.pathname.startsWith('/api/') && response.status()>=400)
   report.http_errors.push({path:u.pathname,status:response.status()});
  if(!['/api/charts/data','/api/charts/history-loads'].includes(u.pathname) &&
     !/^\/api\/charts\/history-loads\/[^/]+\/result$/.test(u.pathname))return;
  const promise=(async()=>{try{
   const body=await response.json();
   let query;
   if(response.request().method()==='POST'){
    const sent=response.request().postDataJSON();query=sent.query || sent;
    if(body.load?.id)loads.set(body.load.id,query);
   }else query=loads.get(u.pathname.split('/').at(-2));
   const result=body.result || (u.pathname==='/api/charts/data'?body:null);
   if(query && result && query.indicators?.some(i=>i.name==='ROLLING_RANGE_SQUEEZE'))
    captures.push({query,status:response.status(),body:result});
  }catch{}})();
  pending.add(promise);promise.finally(()=>pending.delete(promise));
 });
 let host;
 const latest = timeframe => captures.filter(c=>c.query.timeframe===timeframe&&c.status===200).at(-1);
 const readState = async () => host.evaluate(p=>{
  const c=widget.activeChart(),r=squeezeStore().get(c.symbol(),c.resolution(),p);
  return {symbol:c.symbol(),resolution:c.resolution(),ready:c.dataReady(),bars:r?.bars.length,
   boxes:r?.presentation?.boxes.length,labels:r?.presentation?.labels.length,
   history_complete:r?.presentation?.history_complete,
   rectangles:c.getAllShapes().filter(s=>s.name==='rectangle').length,
   balloons:c.getAllShapes().filter(s=>s.name==='balloon').length};
 },params);
 const waitResult=async(resolution,timeframe)=>{
  await host.waitForFunction(res=>widget.activeChart().resolution()===res&&widget.activeChart().dataReady(),resolution,{timeout:120000});
  await expect.poll(()=>host.evaluate(p=>!!squeezeStore().get(widget.activeChart().symbol(),widget.activeChart().resolution(),p)?.presentation?.history_complete,params),{timeout:120000}).toBe(true);
  await expect.poll(()=>host.evaluate(()=>widget.activeChart().getAllShapes().filter(s=>s.name==='rectangle').length),{timeout:30000}).toBeGreaterThan(0);
  await Promise.allSettled([...pending]);
  const capture=latest(timeframe);assert(capture,'Actual RRS chart API response required');
  const value=capture.body.indicators.find(i=>i.name==='ROLLING_RANGE_SQUEEZE');
  assert(value);
  const threshold=value.series.find(s=>s.key==='threshold');
  assert(threshold.values.some(v=>v.value!==null),'RRS threshold must finish warmup');
  const state=await readState();
  assert(state.boxes>0&&state.labels>0&&state.rectangles>0&&state.balloons>0);
  return {...state,timeframe,outputs:Object.fromEntries(value.series.map(s=>[s.key,{rows:s.values.length,non_null:s.values.filter(v=>v.value!==null).length,positive:s.values.filter(v=>v.value>0).length}]))};
 };
 try{
  stage('login');
  const login=await page.request.post(base+'/api/login',{data:auth});
  assert(login.ok(),'Login HTTP '+login.status());
  await page.goto(base+'/advanced-charts/mw75-real');
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith(chartOrigin+'/?')),{timeout:90000}).toBe(true);
  stage('initial-chart');
  host=page.frames().find(f=>f.url().startsWith(chartOrigin+'/?'));
  await host.waitForFunction(()=>typeof widget!=='undefined'&&ready&&widget.activeChart().dataReady(),null,{timeout:120000});
  await host.evaluate(async()=>{if(typeof autoSave!=='undefined')await autoSave.select(false);});
  report.initial=await host.evaluate(()=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution()}));
  stage('select-EURUSD');
  await host.evaluate(()=>{const c=widget.activeChart();for(const study of c.getAllStudies())c.removeEntity(study.id);void c.setSymbol('MWP:EURUSD',{doNotActivateChart:true});});
  await host.waitForFunction(()=>widget.activeChart().symbol()==='MWP:EURUSD',null,{timeout:30000});
  stage('EURUSD-historical-timeframe');
  await host.evaluate(()=>widget.activeChart().setTimeFrame({val:{from:Date.UTC(2025,0,1)/1000,to:Date.UTC(2026,9,23)/1000},res:'1D'}));
  await host.waitForFunction(()=>widget.activeChart().resolution()==='1D'&&widget.activeChart().dataReady(),null,{timeout:90000});
  stage('create-RRS');
  await host.evaluate(p=>widget.activeChart().createStudy('守望 Python ROLLING_RANGE_SQUEEZE',false,false,p),params);
  stage('daily-RRS');
  const daily=await waitResult('1D','D1');
  report.cases.push(daily);
  const original=await host.evaluate(p=>squeezeStore().get(widget.activeChart().symbol(),widget.activeChart().resolution(),p).presentation,params);
  await page.screenshot({path:path.join(out,'d1-initial.png')});
  await host.evaluate(()=>widget.activeChart().setVisibleRange({from:Date.UTC(2022,0,1)/1000,to:Date.UTC(2026,9,26)/1000}));
  stage('daily-expanded');
  const expanded=await waitResult('1D','D1');
  const after=await host.evaluate(p=>squeezeStore().get(widget.activeChart().symbol(),widget.activeChart().resolution(),p).presentation,params);
  const ids=new Set(after.boxes.map(b=>b.id));
  assert(original.boxes.every(b=>ids.has(b.id)),'Existing drawing history must survive range expansion');
  report.pagination={passed:true,previous_boxes:original.boxes.length,expanded_boxes:after.boxes.length,state:expanded};
  await page.screenshot({path:path.join(out,'d1-expanded.png')});
  await host.evaluate(()=>widget.activeChart().setVisibleRange({from:Date.UTC(2026,0,1)/1000,to:Date.UTC(2026,9,26)/1000}));
  await waitResult('1D','D1');
  report.visible_daily_boxes=await host.evaluate(p=>{const c=widget.activeChart(),r=squeezeStore().get(c.symbol(),c.resolution(),p),range=c.getVisibleRange();return r.presentation.boxes.filter(b=>b.right_chart_time/1000>=range.from&&b.left_chart_time/1000<=range.to).length;},params);
  assert(report.visible_daily_boxes>0,'Current daily viewport must contain native boxes');
  await page.screenshot({path:path.join(out,'d1-recent.png')});
  for(const [resolution,timeframe] of [['60','H1'],['240','H4']]){
   stage(timeframe+'-RRS');
   await host.evaluate(res=>{void widget.activeChart().setResolution(res,{doNotActivateChart:true});},resolution);
   report.cases.push(await waitResult(resolution,timeframe));
   await page.screenshot({path:path.join(out,timeframe.toLowerCase()+'.png')});
  }
  assert.deepEqual(report.errors,[]);
  report.passed=true;
 }catch(error){report.failure=String(error);report.stack=error.stack;process.exitCode=1;await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
 finally{
  await Promise.allSettled([...pending]);
  fs.writeFileSync(path.join(privateOut,'browser-captures-private.json'),JSON.stringify(captures,null,2),{mode:0o600});
  report.finished_at=new Date().toISOString();
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await context.close();await browser.close();
  console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,failure:report.failure,http_errors:report.http_errors.length,output:out}));
 }
})();
