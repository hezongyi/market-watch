// Supplementary native-only fixture probe. This is not live OANDA acceptance.
// Python generates every numeric value; the browser only maps synthetic feeds.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),origin='http://localhost:20188';
const out=path.join(repo,'artifacts/supertrend-profile');fs.mkdirSync(out,{recursive:true});
const generated=spawnSync(path.join(repo,'.venv/bin/python'),[path.join(__dirname,'fixtures/supertrend-profile-feed.py')],
  {cwd:repo,encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(repo,'backend')}});
assert.equal(generated.status,0,generated.stderr);
const fixture=JSON.parse(generated.stdout);
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
  executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'});
 const page=await browser.newPage({viewport:{width:1400,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='warning'||m.type()==='error'||m.text().includes('custom indicators'))console.log('PROFILE console',m.text());});
 try{
 const index=await(await page.request.get(origin)).text();
 const library=index.match(/\/charting_library_[a-f0-9]{16}\//)[0];
 const html=`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="chart" style="height:100vh"></div>
 <script src="${library}charting_library.js"></script><script>${fs.readFileSync(path.join(repo,'advanced-host/indicators.js'),'utf8')}</script>
 <script>
 const fixture=${JSON.stringify(fixture)},subscriptions=new Map();let phase=0;
 const decode=s=>s.startsWith('MWPY_')?JSON.parse(atob(s.slice(5))):{symbol:s};
 const data=s=>decode(s).symbol==='GAP'?fixture.gap:fixture.phases[phase];
 function bars(s){const d=data(s),key=decode(s).key,values=key && d.indicator.series.find(s=>s.key===key).values;
  return d.bars.map((b,i)=>{const v=values?.[i];return key?{time:b.start,open:v.value??0,high:v.value??0,low:v.value??0,close:v.value??0,volume:v.value==null?0:v.break_before?2:1}:
    {time:b.start,open:b.open,high:b.high,low:b.low,close:b.close,volume:100};});}
 const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['1']}),0),
 resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:s,type:'crypto',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,intraday_multipliers:['1'],supported_resolutions:['1'],visible_plots_set:'ohlcv',format:'price',exchange:'TEST',listed_exchange:'TEST'}),0),
 getBars:(s,r,p,cb)=>setTimeout(()=>{const all=bars(s.ticker);cb(all.filter(b=>b.time<p.to*1000).slice(-p.countBack),{noData:all[0].time>=p.from*1000});},0),
 subscribeBars:(s,r,cb,id)=>subscriptions.set(id,{symbol:s.ticker,cb}),unsubscribeBars:id=>subscriptions.delete(id)};
 const widget=new TradingView.widget({container:'chart',library_path:'${library}',symbol:'INTRABAR',interval:'1',datafeed:feed,autosize:true,theme:'Dark',locale:'zh',disabled_features:['use_localstorage_for_settings'],custom_indicators_getter:p=>Promise.resolve(pythonStudies(p,fixture.catalog))});
 let ready=false;widget.onChartReady(()=>{ready=true;});
 function publish(next){phase=next;for(const sub of subscriptions.values())sub.cb(bars(sub.symbol).at(-1));}
 </script></body></html>`;
 await page.route(origin+'/__supertrend-profile',r=>r.fulfill({body:html,contentType:'text/html'}));
 await page.goto(origin+'/__supertrend-profile');
 await page.waitForFunction(()=>ready && widget.activeChart().dataReady());
 await page.waitForTimeout(1000);
 const name='守望 Python SUPERTREND_PINE_V1';
 const id=await page.evaluate(name=>widget.activeChart().createStudy(name,false,false,{period:2,multiplier:1}),name);
 const ui=page.frames().find(f=>f!==page.mainFrame());
 const samples=async(id,target)=>{
  await page.evaluate(()=>{globalThis.samples=[];widget.activeChart().crossHairMoved().subscribe(null,s=>samples.push(s));});
  const box=await ui.locator('.chart-container').boundingBox();
  for(let attempt=0;attempt<10;attempt++){
   for(let x=box.x+box.width*0.4;x<box.x+box.width-75;x+=4){await page.mouse.move(x,box.y+200);await page.waitForTimeout(6);}
   const result=await page.evaluate(({id,target})=>samples.filter(s=>s.time===target&&s.entityValues?.[id]).at(-1),{id,target});
   if(result)return result;
   await page.waitForTimeout(200);
  }
  throw Error('Latest candle has no native rendered study sample');
 };
 const time=fixture.phases[0].bars.at(-1).start/1000;
 const get=(s,key)=>s.entityValues[id].values.find(v=>v.title===key||v.title===(key==='up'?'Up Trend':'Down Trend'))?.value;
 const report={kind:'native-only synthetic Python fixtures',phases:[],errors};
 for(const phase of [0,1,2]){
  await page.evaluate(phase=>publish(phase),phase);await page.waitForTimeout(250);
  const sample=await samples(id,time),key=phase===1?'up':'down';
  const value=Number(get(sample,key));
  const expected=fixture.phases[phase].indicator.series.find(s=>s.key===key).values.at(-1).value;
  assert.ok(Math.abs(value-expected)<=0.0051, 'Native precision=2 matches the Python value');
  assert.ok(!Number.isFinite(Number(get(sample,phase===1?'down':'up'))));
  await page.mouse.move(1390,10);await page.screenshot({path:path.join(out,'intrabar-'+phase+'.png')});
  report.phases.push({phase,key,value,time});
 }
 await page.evaluate(async()=>{widget.activeChart().removeAllStudies();await widget.activeChart().setSymbol('GAP');});
 await page.waitForFunction(()=>widget.activeChart().dataReady());
 const gapId=await page.evaluate(name=>widget.activeChart().createStudy(name,false,false,{period:1,multiplier:1}),name);
 const gapTime=fixture.gap.bars[70].start/1000;
 const before=await samples(gapId,gapTime-60),at=await samples(gapId,gapTime),after=await samples(gapId,gapTime+60);
 const gapValue=s=>s.entityValues[gapId].values.find(v=>['up','Up Trend'].includes(v.title))?.value;
 assert.equal(Number(gapValue(before)),8);assert.equal(Number(gapValue(after)),8);
 assert.ok(!Number.isFinite(Number(gapValue(at))));
 await page.mouse.move(1390,10);await page.screenshot({path:path.join(out,'gap-period-one.png')});
 report.gap={time:gapTime,backendValue:8,before:gapValue(before),at:gapValue(at),after:gapValue(after)};
 assert.deepEqual(errors,[]);report.passed=true;
 fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(e){console.log('PROFILE diagnostic',await page.evaluate(()=>({ready,studies:widget.getStudiesList(),errors:typeof fixture,catalogKeys:Object.keys(fixture.catalog),count:pythonStudies({Std:{}},fixture.catalog).length})).catch(()=>({})),errors);throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
