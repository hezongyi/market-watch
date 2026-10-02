// Real source data and native library. Operates on an isolated acceptance origin.
const {chromium}=require('@playwright/test'),fs=require('node:fs'),assert=require('node:assert/strict');
const APP=process.env.VOLUME_APP||'https://localhost:15553',CHART=process.env.VOLUME_CHART||'https://127.0.0.1:15554';
const OUT=process.env.VOLUME_OUTPUT||require('node:path').resolve(__dirname,'../../docs/verification/volume/native-provider.json');
const frames=['1','5','15','30','60','240','1D','1W','1M'];
const cases=JSON.parse(process.env.VOLUME_CASES||JSON.stringify(['MWP:BTCUSDT','MWP:OANDA:CAD_CHF'].flatMap(symbol=>frames.map(resolution=>({symbol,resolution})))));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1500,height:950}});
 const errors=[],requests=[],results=[],pending=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{
  if(r.url().endsWith('/api/charts/data'))pending.push((async()=>{
   const data=await r.json().catch(()=>({}));requests.push({query:r.request().postDataJSON(),status:r.status(),data});
  })());
 });
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error(path+' '+r.status);return r.json();
 },{path,body});}
 function save(){fs.writeFileSync(OUT,JSON.stringify({passed:false,results,errors},null,2));}
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname,'../../../market-watch/artifacts/local-credentials.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const workspace=await api('advanced-charts/workspaces',{name:'Volume real acceptance'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,document:{engine:'tv31',schemaVersion:1,symbol:cases[0].symbol,interval:cases[0].resolution}});
  await page.goto(APP+'/advanced-charts');
  await page.frameLocator('iframe').locator('#chart').waitFor({timeout:60000});
  const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof widget!=='undefined'&&widget&&ready,null,{timeout:60000});
  let studyId;
  for(const sample of cases){
   const started=Date.now(),offset=requests.length;
   await frame.evaluate(s=>new Promise(ok=>widget.activeChart().setSymbol(s,ok)),sample.symbol);
   await frame.evaluate(r=>new Promise(ok=>widget.activeChart().setResolution(r,ok)),sample.resolution);
   await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
   await Promise.all(pending);
   if(!studyId||!(await frame.evaluate(id=>widget.activeChart().getAllStudies().some(s=>s.id===id),studyId))){
    studyId=await frame.evaluate(()=>widget.activeChart().createStudy('Volume',false,false,{}, {'volume.color.0':'#ff00ff','volume.color.1':'#00ffff','volume.transparency':0,'volume ma.visible':false}));
   }
   await page.waitForTimeout(600);
   const state=await frame.evaluate(id=>({symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),range:widget.activeChart().getVisibleRange(),study:widget.activeChart().getAllStudies().find(s=>s.id===id),styles:widget.activeChart().getStudyById(id).getStyleValues(),visible:widget.activeChart().getStudyById(id).isVisible()}),studyId);
   const ui=frame.childFrames().find(f=>f.url().includes('charting_library'))||frame.childFrames()[0];
   let valueCheck;
   if(process.env.VOLUME_VALUES==='1'){
    await frame.evaluate(()=>{globalThis.volumeSelected=null;widget.activeChart().crossHairMoved().subscribe(null,e=>{globalThis.volumeSelected=e.time;globalThis.volumeEvent=e;});});
    const button=ui.getByRole('button',{name:/数据窗口/});
    if(await button.getAttribute('aria-pressed')!=='true')await button.click();
    const box=await ui.locator('.chart-container').first().boundingBox();
    let selected,lines,expected;
    for(const fraction of [.55,.65,.45,.75,.35,.85,.25,.95]){
     await page.mouse.move(box.x+box.width*fraction,box.y+box.height*.4,{steps:3});await page.waitForTimeout(450);
     selected=await frame.evaluate(()=>globalThis.volumeSelected);
     await Promise.all(pending);
     const identity=sample.symbol.startsWith('MWP:')?sample.symbol.slice(4):sample.symbol;
     const period={'1':'M1','5':'M5','15':'M15','30':'M30','60':'H1','240':'H4','1D':'D1','1W':'W1','1M':'MN'}[sample.resolution];
     const kind=sample.symbol.startsWith('MWP:')?'provider':'managed';
     const pages=requests.filter(r=>r.query.instrument===identity&&r.query.series_kind===kind&&r.query.timeframe===period&&r.data.bars?.length);
     for(const source of pages){
      const mapped=await frame.evaluate(({data,res,symbol})=>barsOf(data,res,symbol),{data:source.data,res:sample.resolution,symbol:sample.symbol});
      const bar=mapped.find(b=>b.time===selected*1000);
      if(bar){expected=bar.volume;break;}
     }
     if(expected!==undefined){lines=(await ui.locator('body').innerText()).split('\n').map(s=>s.trim());break;}
    }
    const event=await frame.evaluate(()=>globalThis.volumeEvent);
    const nativeValue=Object.values(event?.entityValues||{}).flatMap(entity=>entity.values||[]).find(value=>value.title==='Volume')?.value;
    const displayed=Number((nativeValue||"NaN").replaceAll(",",""));
    valueCheck={selected,expected,displayed,lines,event};
    fs.writeFileSync(OUT,JSON.stringify({passed:false,results,errors,checking:{sample,valueCheck},requests},null,2));
    assert.ok(Number.isFinite(expected), "Selected real candle must have quantity");
    assert.equal(displayed,Number(expected.toFixed(sample.symbol.includes('BTCUSDT')?8:0)), "Native data window must display the API quantity");
   }
   const text=await ui.locator('body').innerText();
   const painted=await ui.evaluate(()=>Array.from(document.querySelectorAll('canvas')).map(c=>{
    try{const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let colored=0;
     for(let i=0;i<a.length;i+=4)if((a[i]>200&&a[i+1]<70&&a[i+2]>200)||(a[i]<70&&a[i+1]>200&&a[i+2]>200))colored++;
     return {width:c.width,height:c.height,colored};}catch{return {colored:0};}
   }));
   const identity=sample.symbol.startsWith('MWP:')?sample.symbol.slice(4):sample.symbol;
   const kind=sample.symbol.startsWith('MWP:')?'provider':'managed';
   const period={'1':'M1','5':'M5','15':'M15','30':'M30','60':'H1','240':'H4','1D':'D1','1W':'W1','1M':'MN'}[sample.resolution];
   const matching=requests.slice(offset).filter(r=>r.query.instrument===identity&&r.query.series_kind===kind&&r.query.timeframe===period&&r.data.bars?.length);
   const source=matching.at(-1)||requests.filter(r=>r.query.instrument===identity&&r.query.series_kind===kind&&r.query.timeframe===period&&r.data.bars?.length).at(-1);
   const positive=source?.data.bars.findLast(b=>b.complete&&b.volume_complete&&Number(b.volume)>0);
   const record={...sample,valueCheck,elapsed_ms:Date.now()-started,state,painted,volume_legend:text.split('\n').filter(t=>/volume|vol|成交量|报价量|数据|错误/i.test(t)),api:positive,bar_count:source?.data.bars.length,volume_kind:source?.data.volume_kind};
   results.push(record);save();console.log(sample.symbol,sample.resolution,'pixels',painted.reduce((n,c)=>n+c.colored,0),'positive',positive?.volume);
   assert.ok(positive,'Must receive a confirmed positive real source quantity');
   assert.ok(state.study&&state.visible,'Native Volume study must be visible');
   assert.ok(painted.some(c=>c.colored>50),'Histogram pixels must be painted in configured Volume colors');
   await page.screenshot({path:OUT.replace(/\.json$/,`-${kind}-${identity.replaceAll(':','_')}-${period}.png`)});
  }
  await frame.waitForFunction(()=>!loading&&!nativeSaving&&!rangeGuard?.busy()&&!edgeGuard?.busy(),null,{timeout:30000});
  await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));
  await page.reload();await page.frameLocator('iframe').locator('#chart').waitFor({timeout:60000});
  const restored=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await restored.waitForFunction(()=>typeof widget!=='undefined'&&widget&&ready,null,{timeout:60000});
  const studies=await restored.evaluate(()=>widget.activeChart().getAllStudies());
  assert.ok(studies.some(s=>/volume/i.test(s.name)),'Saved native Volume reopens');
  fs.writeFileSync(OUT,JSON.stringify({passed:true,results,errors,saved_reopened:studies},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
