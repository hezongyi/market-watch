// Licensed native runtime + Python fixture output. No live account/rule writes.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),host=path.join(root,'advanced-host'),origin='https://mw-paio.invalid';
const input=JSON.parse(fs.readFileSync(process.env.PAIO_NATIVE_INPUT || '/evidence/native-input.json','utf8'));
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PAIO_CHROMIUM,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const html=fs.readFileSync(path.join(__dirname,'fixtures/native-history.html'),'utf8')
   .replace('<script>','<script src="/indicators.js"></script><script src="/native-indicator-results.js"></script><script src="/indicator-coordinator.js"></script><script src="/paio-display.js"></script><script>')
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
  await page.goto(origin+'/?initialCount='+input.bars.length);await page.waitForFunction(()=>ready&&widget.activeChart().dataReady());
  await page.evaluate(async input=>{
   const chart=widget.activeChart();window.ids=[];window.renderErrors=[];
   for(let i=0;i<2;i++)ids.push(await chart.createStudy('守望 Python PAIO_V1',false,false));
   window.display=chartPAIODisplay({report:error=>renderErrors.push(String(error))});
   window.coordinator=chartIndicatorCoordinator(widget,input.catalog,{
    drawings:display,identity:{binding:()=>({revision:'fixture',inputRevision:1,calculationStart:input.bars[0].start}),chartTime:bar=>bar.start},
    read:async(_symbol,_resolution,args)=>({bars:input.bars,indicators:args.indicators.map(spec=>input.results[spec.params.pvLineDraw===false?'plot':'default']),input_revision:1,has_more:false}),
    report:error=>{if(error.code!=='HISTORY_CANCELLED')renderErrors.push(String(error));}});
   await coordinator.sync();
  },input);
  const count=input.results.default.presentation.objects.filter(obj=>obj.kind!=='label'||obj.location!=='price'||obj.price!==null).length;
  try{await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().length),{timeout:30000}).toBe(count*2);}
  catch(error){console.error(await page.evaluate(()=>({errors:renderErrors,display:display.diagnostics(),coordinator:coordinator.diagnostics(),scopes:ids.map(id=>MWNativeIndicatorResults.scope(widget.activeChart(),id))})));throw error;}
  assert.deepEqual(await page.evaluate(()=>renderErrors),[]);
  const styles=await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).getStyleValues());
  assert.equal(styles.styles.plot0.color,'#ff9800');assert.equal(styles.styles.plot1.plottype,3);
  const settings=await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).getInputValues());
  assert.equal(settings.length,Object.keys(input.catalog.PAIO_V1.params).length+input.catalog.PAIO_V1.display_inputs.length);
  const saved=await page.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
  assert.ok(!JSON.stringify(saved).includes('LineToolText'),'ephemeral labels do not enter permanent drawings');
  await page.evaluate(saved=>widget.load(saved),saved);
  await page.waitForFunction(()=>widget.activeChart().dataReady()&&widget.activeChart().getAllStudies().length===2&&widget.activeChart().getAllStudies().every(s=>MWNativeIndicatorResults.scope(widget.activeChart(),s.id)));
  await page.evaluate(async()=>{ids=widget.activeChart().getAllStudies().map(s=>s.id);await coordinator.sync();});
  await expect.poll(()=>page.evaluate(()=>display.diagnostics().objects),{timeout:30000}).toBe(count*2);
  await page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'pvLineDraw',value:false},{id:'pv1stColor',value:'#336699'},{id:'ma_1_offset',value:2}]));
  await page.waitForFunction(()=>widget.activeChart().getStudyById(ids[0]).getInputValues().find(p=>p.id==='pv1stColor')?.value==='#336699');
  await page.evaluate(()=>coordinator.sync());
  try{await expect.poll(()=>page.evaluate(()=>widget.activeChart().getStudyById(ids[0]).getStyleValues().styles.plot3.color),{timeout:10000}).toBe('#336699');}
  catch(error){console.error(await page.evaluate(()=>({inputs:widget.activeChart().getStudyById(ids[0]).getInputValues(),styles:widget.activeChart().getStudyById(ids[0]).getStyleValues(),errors:renderErrors,diag:coordinator.diagnostics()})));throw error;}
  await page.evaluate(()=>widget.activeChart().showPropertiesDialog(ids[0]));
  let dialog;
  for(const frame of page.frames()){
   const candidate=frame.getByRole('dialog');
   if(await candidate.count()){dialog=candidate;break;}
  }
  assert.ok(dialog,'Native PAIO settings dialog opens');
  const text=await dialog.innerText();
  for(const group of ['Gap Series','Bar Index','Moving Average','Previous Values','I & O Bar','H & L Count'])assert.ok(text.includes(group),group);
  await page.setViewportSize({width:375,height:915});
  for(const frame of page.frames())await frame.addStyleTag({content:'[role="dialog"]{font-size:150%}'});
  await page.screenshot({path:'/evidence/paio-settings-375-150.png'});
  await page.keyboard.press('Escape');
  for(const width of [375,412])for(const theme of ['Light','Dark']){
   await page.setViewportSize({width,height:915});await page.evaluate(theme=>widget.changeTheme(theme),theme);
   await page.screenshot({path:`/evidence/paio-${width}-${theme.toLowerCase()}.png`});
  }
  await page.evaluate(()=>{for(const study of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(study.id);});
  await page.evaluate(()=>coordinator.sync());
  await expect.poll(()=>page.evaluate(()=>widget.activeChart().getAllShapes().length)).toBe(0);
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>renderErrors),[]);
  console.log('PASS PAIO native two instances, all inputs, six plots, restore, style, offset, disposable objects and 375/412 themes');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
