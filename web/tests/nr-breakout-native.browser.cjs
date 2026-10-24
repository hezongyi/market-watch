// Actual licensed native API + Python batches. No running app/acceptance update.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),host=path.join(root,'advanced-host'),origin='https://mw-nr.invalid';
const input=JSON.parse(execFileSync(path.join(root,'.venv/bin/python'),['-c',`
import json,math
from alerts.chart_indicators import public_catalog,calculate
name='NR4_NR7_BREAKOUT_V1';end=1790640000000;step=86400000;bars=[]
for i in range(100):
 t=end-(100-i)*step;width=[8,7,9,6,7,8,4,7,8,9,3,6,9,10,3,8][i%16]
 close=[100,100,100,99,102,100,100,103,99,103,100,98,101,98,100,103][i%16]
 bars.append(dict(start=t,end=t+step,chart_time=t,open=100,high=100+width/2,low=100-width/2,close=close,complete=True))
print(json.dumps(dict(catalog={name:public_catalog()[name]},bars=bars,result=calculate(bars,{'name':name}),weekly=calculate(bars,{'name':name,'params':{'timeframe':'W'}}))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')}}));
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const html=fs.readFileSync(path.join(__dirname,'fixtures/native-history.html'),'utf8')
   .replace('<script>','<script src="/indicators.js"></script><script src="/native-indicator-results.js"></script><script src="/indicator-coordinator.js"></script><script src="/nr-breakout-display.js"></script><script>')
   .replace('const all=series(1000,DAY)',`const all=${JSON.stringify(input.bars.map(b=>({time:b.start,open:b.open,high:b.high,low:b.low,close:b.close})))}`)
   .replace('const widget=new TradingView.widget(',`MWNativeIndicatorResults.configure(${JSON.stringify(input.catalog)},{enable:true});const widget=new TradingView.widget(`)
   .replace("symbol:'TEST',interval:",`custom_indicators_getter:async PineJS=>pythonStudies(PineJS,${JSON.stringify(input.catalog)}),symbol:'TEST',interval:`);
  await page.route('**/*',r=>{
   const u=new URL(r.request().url());if(u.origin!==origin)return r.fulfill({status:204,body:''});
   if(u.pathname==='/')return r.fulfill({contentType:'text/html; charset=utf-8',body:html});
   const file=path.resolve(host,'.'+u.pathname);if(!file.startsWith(host+'/')||!fs.existsSync(file))return r.fulfill({status:404});
   let body=fs.readFileSync(file);
   if(file.endsWith('library.e2f8b3a016c9e1a0b7a5.js'))body=body.toString().replace(
    '_createStudy(e,t,i,s,r,o,a,l){this._studiesCache[s][r].completed=!1;',
    '_createStudy(e,t,i,s,r,o,a,l){if(globalThis.parent?.MWNativeIndicatorResults?.start(this,e,t,i,s,r,o,a,l))return;this._studiesCache[s][r].completed=!1;');
   return r.fulfill({contentType:file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'application/octet-stream',body});
  });
  await page.goto(origin+'/?initialCount=100');await page.waitForFunction(()=>ready&&widget.activeChart().dataReady());
  await page.evaluate(async input=>{
   const chart=widget.activeChart();window.ids=[];window.renderErrors=[];
   for(let i=0;i<2;i++)ids.push(await chart.createStudy('守望 Python NR4_NR7_BREAKOUT_V1',false,false));
   window.display=chartNRBreakoutDisplay({report:error=>renderErrors.push(String(error))});
   window.coordinator=chartIndicatorCoordinator(widget,input.catalog,{
    drawings:display,identity:{binding:()=>({revision:'fixture',inputRevision:1,calculationStart:input.bars[0].start}),chartTime:bar=>bar.start},
    read:async(_symbol,_resolution,args)=>({bars:input.bars,indicators:args.indicators.map(spec=>spec.params.timeframe==='W'?input.weekly:input.result),input_revision:1,has_more:false}),
    // Loading a saved layout intentionally cancels the retiring chart read.
    report:error=>{if(error.code!=='HISTORY_CANCELLED')renderErrors.push(String(error));}});
   await coordinator.sync();
  },input);
  try{await expect.poll(()=>page.evaluate(()=>display.diagnostics().objects)).toBeGreaterThan(10);}
  catch(error){console.error(await page.evaluate(()=>({errors:renderErrors,display:display.diagnostics(),coordinator:coordinator.diagnostics(),studies:widget.activeChart().getAllStudies(),scopes:ids.map(id=>MWNativeIndicatorResults.scope(widget.activeChart(),id))})));throw error;}
  await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().length)).toBe(await page.evaluate(()=>display.diagnostics().objects));
  const initial=await page.evaluate(()=>({errors:renderErrors,shapes:widget.activeChart().getAllShapes().map(s=>{
   const api=widget.activeChart().getShapeById(s.id);return {name:s.name,points:api.getPoints(),properties:api.getProperties()};})}));
  assert.deepEqual(initial.errors,[]);
  const styles=await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).getStyleValues());
  assert.equal(styles.styles.range_anchor.display,8,'anchor is a transparent status-line carrier');
  assert.ok(initial.shapes.some(s=>s.name==='rectangle'));
  assert.ok(initial.shapes.some(s=>s.properties.linestyle===2));
  const text=initial.shapes.filter(s=>s.name==='text');assert.ok(text.length>0);
  assert.ok(text.some(s=>s.properties.text==='\n▲'));assert.ok(text.some(s=>s.properties.text==='▼\n'));
  assert.ok(await page.evaluate(()=>widget.activeChart().getAllShapes().filter(s=>s.name==='text').every(s=>{
    const view=widget.activeChart()._chartWidget.model().model().dataSourceForId(s.id)._paneView;
    return view._horzAlign==='center'&&view._vertAlign==='middle'&&view._forceTextAlign;
  })),'signals center on the exact Python price/time anchor');
  assert.ok(initial.shapes.every(s=>s.points.every(p=>p.price>90&&p.price<110)),'timestamps never reach the price scale');
  const artifact=process.env.NR_SCREENSHOT||'/tmp/mw-nr4-nr7-native.png';
  await page.screenshot({path:artifact});
  const saved=await page.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  assert.ok(!JSON.stringify(saved).includes('LineToolText'),'disposable signal labels are excluded from saved layouts');
  await page.evaluate(saved=>widget.load(saved),saved);
  await page.waitForFunction(()=>widget.activeChart().dataReady()&&widget.activeChart().getAllStudies().length===2&&
    widget.activeChart().getAllStudies().every(s=>MWNativeIndicatorResults.scope(widget.activeChart(),s.id)));
  await page.evaluate(async()=>{ids=widget.activeChart().getAllStudies().map(s=>s.id);await coordinator.sync();});
  await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().length)).toBe(initial.shapes.length);
  await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'timeframe',value:'W'}]));
  await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().some(s=>{
    const p=widget.activeChart().getShapeById(s.id).getPoints();return s.name==='rectangle'&&p.length===2&&p[1].time-p[0].time>=5*86400;
  }))).toBe(true);
  await page.screenshot({path:artifact.replace('.png','-weekly.png')});
  await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'timeframe',value:'D'}]));
  await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().length)).toBe(initial.shapes.length);
  // Pine label sizes, rather than the numerically different table/box sizes.
  for(const [size,font] of [['Tiny',7],['Normal',12],['Large',18],['Huge',24],['Small',10]]){
    await page.evaluate(size=>widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'signal_size',value:size}]),size);
    await expect.poll(()=>page.evaluate(font=>widget.activeChart().getAllShapes().filter(s=>s.name==='text'&&
      widget.activeChart().getShapeById(s.id).getProperties().fontsize===font).length,font)).toBe(font===10?text.length:text.length/2);
  }
  await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'show_signals',value:false},{id:'range_color',value:'#ff0000'},{id:'signal_size',value:'Huge'}]));
  await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().filter(s=>s.name==='text').length)).toBe(text.length/2);
  assert.ok(await page.evaluate(()=>widget.activeChart().getAllShapes().some(s=>widget.activeChart().getShapeById(s.id).getProperties().linecolor==='#ff0000')));
  await page.evaluate(()=>widget.activeChart().getStudyById(ids[1]).setVisible(false));
  await expect.poll(()=>page.evaluate(()=>display.diagnostics().bindings)).toBe(1);
  await page.evaluate(()=>widget.activeChart().removeEntity(ids[0]));
  await expect.poll(()=>page.evaluate(()=>display.diagnostics().objects)).toBe(0);
  await page.evaluate(()=>coordinator.dispose());assert.deepEqual(await page.evaluate(()=>renderErrors),[]);assert.deepEqual(errors,[]);
  console.log('PASS Python NR4/NR7 native drawings, centered signals, all five Pine label sizes, colors/styles, two studies, saved layout, D/W parameter switch, hiding/removal; screenshot '+artifact);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
