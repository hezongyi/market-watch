// Licensed v31.1.0 + shipped shell, React/CSS and price geometry. Synthetic fixtures only.
const {chromium}=require('@playwright/test');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),library=process.env.MW_PROBE_LIBRARY;
const output=process.env.MW_PROBE_OUTPUT;
if(!library||!output)throw Error('Set MW_PROBE_LIBRARY and MW_PROBE_OUTPUT');
const probe=fs.readFileSync(path.join(root,'web/tests/native-alert-shell.probe.cjs'),'utf8');
const feed=probe.match(/const fixture = `([\s\S]*?)`;/)[1].replace("supported_resolutions:['60']","supported_resolutions:['60','240']");
const fixture=feed+`
let epoch=1;globalThis.failArchive=false;globalThis.writes=[];globalThis.notes=[];
const identity={code:'EURUSD',series_kind:'managed',source:'fixture',basis:'bid',timeframe:'H1'};
const config={name:'EURUSD 穿过 1.11935',instrument:'EURUSD',series_kind:'managed',source:'fixture',timeframe:'H1',mode:'close',condition:{relation:'cross',left:{kind:'price'},right:{kind:'constant',value:'1.11935'}},max_triggers:1,expires_at:1795289640000,message:'EURUSD 穿过 1.11935',notify_web:true,notify_ntfy:false,late_delivery:'log_only',association:null,calculation_version:'chart-python-v1',calculation_origin:null,published:true};
const row=(i,price,status='active')=>({id:'r'+i,name:'EURUSD 穿过 '+price,display_identity:identity,display_label:'EURUSD · 自建行情 · bid · H1 · FIXTURE',version:1,control_revision:1,run:1,status,health:'ready',health_reason:null,count:status==='completed'?1:0,max_triggers:1,created_at:1791182743000-(i===3?5:i)*1000,updated_at:1791182743000-(i===3?5:i)*1000,effective_at:1,condition_summary:'价格 穿过 '+price,runtime:{},config:{...config,name:'EURUSD 穿过 '+price,condition:{...config.condition,right:{kind:'constant',value:price}}}});
globalThis.rows=[row(1,'1.11935'),row(2,'1.11951'),row(3,'1.12522','completed'),row(4,'1.12061','completed')];
globalThis.events=[3,6].map((i)=>({id:'e'+i,alert_id:'r3',display_identity:identity,display_label:rows[0].display_label,occurred_at:1791196871000-(i-3)*86400000,detected_at:1791196871000-(i-3)*86400000,price:'1.12061',threshold:'1.12061',evidence:{config:rows[i%2+2].config,ordinal:1,rule_version:1,left:'1.12061',observation:{},alert_created_at:1791182743000},message:'fixture',notification_id:'n'+i,notification_status:'pending',ack_at:null,delivery_status:'pending',notice:{id:'s:e'+i,first_seq:i,viewed_at:null,handled_at:null}}));
const request=async q=>{if(q.body){writes.push(q);if(q.path.endsWith('capabilities'))return {sources:[{source:'fixture',series_kind:'managed',available:true,atr_frames:['H1']}]};if(q.path.endsWith('lifecycle')){if(failArchive)throw Error('fixture archive failure');const r=rows.find(r=>q.path.includes('/'+r.id+'/'));r.status=q.body.action==='archive'?'archived':'paused';r.control_revision++;return structuredClone(r);}return structuredClone(rows[0]);}return structuredClone(q.path.endsWith('events')?events:rows.filter(r=>r.status!=='archived'));};
widget.onChartReady(async()=>{
 globalThis.bridge=chartAlertBridge({getWidget:()=>widget,getWorkspace:()=>({id:'fixture'}),getEpoch:()=>epoch,isLoading:()=>false,readonly:false,metadata:()=>({source:'fixture',basis:'bid'}),frames:{60:'H1',240:'H4'},rpc:async q=>{writes.push(q);if(failArchive)throw Error('fixture archive failure');const r=rows.find(r=>r.id===q.alert_id);r.status='archived';return structuredClone(r);},send:m=>{if(m.type==='chart-alert-context')ui.context(m.context)},fail:e=>notes.push(String(e))});bridge.attach();
 const chart=widget.activeChart();const assoc={workspace_id:'fixture',chart_id:bridge.diagnostics().charts[0],chart_index:0,generation:'1:0',object_id:null,object_kind:null,native_object_id:null};
 rows.forEach(r=>r.config.association={...assoc});
 globalThis.ui=await MWNativeAlerts.attach({widget,scope:{workspace_id:'fixture',session:'fixture'},readonly:false,request,bridge,noticeRequest:async q=>{writes.push(q);return {ok:true}},noticeState:{alertUnread:1},report:e=>notes.push(String(e))});ui.theme('dark');ui.noticeState({alertUnread:1});ui.open();globalThis.testReady=true;
});
`;
(async()=>{
 fs.mkdirSync(output,{recursive:true});const assets=path.join(output,'ui-assets');
 execFileSync(process.execPath,['scripts/build-alert-ui.mjs',assets],{cwd:path.join(root,'web')});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1,timezoneId:'Etc/UTC',reducedMotion:'reduce'});
 const report={scope:'Actual licensed chart with deterministic synthetic feed/API, shipped React/CSS and adapters; no real database writes',cases:[],geometry:[],errors:[],passed:false};
 page.on('pageerror',e=>report.errors.push(String(e)));
 await page.clock.setFixedTime(new Date('2026-10-05T15:30:00Z'));
 await page.route('https://alert-reference.invalid/**',r=>{
  const p=new URL(r.request().url()).pathname;
  if(p==='/')return r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>html,body,#chart{height:100%;margin:0}</style><div id="chart"></div>'+['/charting_library/charting_library.js','/series.js','/price-format.js','/native-alert-price-lines.js','/chart-alerts.js','/native-alert-shell.js','/alert-ui.js','/fixture.js'].map(s=>'<script src="'+s+'"></script>').join('')});
  if(p==='/fixture.js')return r.fulfill({contentType:'text/javascript',body:fixture});
  const file=p.startsWith('/charting_library/')?path.resolve(library,p.slice(18)):path.join(/^\/alert-ui\.(js|css)$/.test(p)?assets:path.join(root,'advanced-host'),path.basename(p));
  if(!fs.existsSync(file))return r.fulfill({status:404,body:'absent'});
  return r.fulfill({path:file,...(file.endsWith('.js')?{contentType:'text/javascript'}:file.endsWith('.css')?{contentType:'text/css'}:{})});
 });
 const raf=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 let chart;
 async function setWidth(width){
  const box=await chart.locator('.chart-alert-panel').boundingBox();const handle=await chart.locator('.widgetbar-handle').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+20);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+box.width-width,handle.y+20,{steps:6});await page.mouse.up();await raf();
 }
 async function metric(name){
  const result=await page.evaluate(()=>{
   const chart=widget.activeChart(),w=chart._chartWidget,m=w.model().model(),s=m.mainSeries(),pane=w.paneWidgets().find(p=>p.containsMainSeries()),canvas=pane.canvasElement(),b=canvas.getBoundingClientRect(),doc=canvas.ownerDocument;
   const p=Number(rows[1].config.condition.right.value),y=s.priceScale().priceToCoordinate(p,s.firstValue()),label=doc.querySelector('[data-name="mw-alert-price-label"][data-alert-id="r2"]'),dot=doc.querySelector('[data-name="mw-alert-price-dot"][data-alert-id="r2"]');
   const l=label?.getBoundingClientRect();return {expectedY:b.top+y,label:l?.toJSON(),canvas:b.toJSON(),mode:s.priceScale().mode(),notes,entries:bridge.diagnostics().priceLines,delta:l?Math.abs(l.y+l.height/2-b.top-y):null,dot:dot?.getBoundingClientRect().toJSON()};
  });report.geometry.push({name,...result});assert.ok(result.dot&&Math.abs(result.dot.y+result.dot.height/2-result.expectedY)<=1,name+': paired dot follows the native price coordinate');assert.ok(result.label&&result.delta<=1,name+': label tracks actual main-series priceToCoordinate: '+JSON.stringify(result));
 }
 async function capture(name,selector){await raf();await chart.locator(selector).screenshot({path:path.join(output,name+'.png')});}
 try{
  await page.goto('https://alert-reference.invalid/');await page.waitForFunction(()=>globalThis.testReady&&widget.activeChart().dataReady());
  chart=page.frames().find(f=>f!==page.mainFrame());
  await chart.locator('.chart-alert-card').first().waitFor();await setWidth(380);
  await capture('state-1-list','.chart-alert-panel');
  report.panel=await chart.locator('.chart-alert-panel').evaluate(n=>({box:n.getBoundingClientRect().toJSON(),tabs:n.querySelector('.alert-panel-tabs').getBoundingClientRect().toJSON(),rows:[...n.querySelectorAll('.chart-alert-card')].map(x=>x.getBoundingClientRect().toJSON()),background:getComputedStyle(n).backgroundColor}));
  await capture('state-2-toolbar','.chart-alert-panel');
  await chart.locator('.chart-alert-card').first().locator('.alert-row-summary').hover();await chart.getByRole('tooltip').waitFor();
  await page.screenshot({path:path.join(output,'state-3-hover.png')});
  await chart.getByRole('tooltip').screenshot({path:path.join(output,'state-3-tooltip.png')});
  report.tooltip=await chart.getByRole('tooltip').boundingBox();await page.keyboard.press('Escape');
  await chart.getByRole('tab',{name:/日志/}).click();await chart.locator('[data-signal-id]').first().waitFor();
  await capture('state-4-logs','.chart-alert-panel');
  await chart.locator('[data-signal-id]').first().locator('.alert-row-summary').click();
  await chart.locator('[data-signal-id]').first().locator('.alert-row-summary').hover();await chart.getByRole('tooltip').waitFor();
  await page.screenshot({path:path.join(output,'state-4-log-tooltip.png')});await page.keyboard.press('Escape');
  await chart.getByRole('tab',{name:'警报',exact:true}).click();
  await chart.locator('.chart-alert-card').filter({hasText:'EURUSD 穿过 1.11935'}).getByRole('button',{name:'编辑',exact:true}).click();
  const dialog=chart.locator('[data-name="mw-native-alert-dialog"]');await dialog.waitFor();await capture('state-5-editor','[data-name="mw-native-alert-dialog"]');
  report.editor=await dialog.boundingBox();await dialog.getByLabel('行情与高级选项',{exact:true}).click();await dialog.getByRole('button',{name:'突破阈值',exact:true}).waitFor();await dialog.getByLabel('行情与高级选项',{exact:true}).click();
  await dialog.getByLabel('比较值',{exact:true}).click();await dialog.getByLabel('比较值',{exact:true}).fill('1.123456789012345678');await chart.waitForFunction(()=>document.querySelector('[aria-label="比较值"]')?.value==='1.123456789012345678');assert.equal(await dialog.getByLabel('比较值',{exact:true}).inputValue(),'1.123456789012345678');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await metric('linear');
  await page.setViewportSize({width:1707,height:900});await page.evaluate(()=>bridge.setRows([rows[1]]));await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r1"]').waitFor({state:'detached'});await raf();await page.mouse.move(1650,15);
  report.priceStrip=await page.evaluate(()=>{const c=widget.activeChart(),s=c._chartWidget.model().model().mainSeries(),b=c._chartWidget.paneWidgets().find(p=>p.containsMainSeries()).canvasElement().getBoundingClientRect();return {x:b.left,y:b.top+s.priceScale().priceToCoordinate(1.11951,s.firstValue())-15,width:1221,height:30}});
  await page.screenshot({path:path.join(output,'state-6-price-line.png')});await page.screenshot({path:path.join(output,'state-6-line-strip.png'),clip:report.priceStrip});
  await page.setViewportSize({width:1600,height:900});await page.evaluate(()=>bridge.setRows(rows));await raf();
  for(const mode of [1,2,3,0]){
   await page.evaluate(mode=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().setMode(mode),mode);await raf();await metric('scale-mode-'+mode);
  }
  await page.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().setInverted(true));await raf();await page.waitForTimeout(200);await metric('inverted');
  await page.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().setInverted(false));
  for(const width of [320,480,380]){await setWidth(width);await metric('panel-width-'+width);const p=await chart.locator('.chart-alert-panel').boundingBox();assert.ok(Math.abs(p.width-width)<3);}
  for(const width of [1440,1920,1600]){await page.setViewportSize({width,height:900});await raf();await metric('viewport-'+width);}
  await page.evaluate(()=>{const c=widget.activeChart(),r=c.getVisibleRange();return c.setVisibleRange({from:r.from-3600*10,to:r.to-3600*10});});await raf();await metric('time-scroll');
  await page.evaluate(()=>{const c=widget.activeChart(),r=c.getVisibleRange();return c.setVisibleRange({from:r.from+(r.to-r.from)/4,to:r.to});});await raf();await metric('time-zoom');
  await page.evaluate(()=>widget.activeChart().createStudy('Relative Strength Index',false,false,{length:14}));await raf();await metric('indicator-pane');
  await page.evaluate(()=>widget.setLayout('2h'));await page.waitForFunction(()=>widget.chartsCount()===2&&widget.chart(0).dataReady()&&widget.chart(1).dataReady());
  await page.evaluate(()=>bridge.setRows(rows));await raf();await metric('two-charts');
  const count=await chart.locator('[data-name="mw-alert-price-label"]').count();assert.equal(count,2,'only active associated rules appear, no duplicate on second chart');
  await page.evaluate(()=>{rows[1].config.timeframe='H4';bridge.setRows(rows)});await raf();assert.equal(await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r2"]').count(),0,'wrong timeframe hidden');
  await page.evaluate(()=>{rows[1].config.timeframe='H1';bridge.setRows(rows)});await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r2"]').waitFor();
  await page.evaluate(()=>failArchive=true);await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r2"] button').click();await page.waitForFunction(()=>notes.some(x=>x.includes('failure'))||writes.some(x=>x.op==='lifecycle'));assert.equal(await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r2"]').count(),1);
  await page.evaluate(()=>failArchive=false);await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r2"] button').click();await chart.locator('[data-name="mw-alert-price-label"][data-alert-id="r2"]').waitFor({state:'detached'});
  report.cases.push('Six reference states, real shell/editor/SVG, exact input precision, real mode 0/1/2/3 and inversion coordinates, resize/scroll/zoom/multiple panes/multiple charts, wrong timeframe, archive failure retention and success');
  await page.evaluate(()=>widget.setLayout('s'));await page.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady());
  await page.evaluate(async()=>{await widget.changeTheme('Light');ui.theme('light');ui.open()});await raf();await capture('light-list','.chart-alert-panel');
  const mobilePanel=chart.locator('.chart-alert-panel');
  await mobilePanel.locator('.chart-alert-card').first().getByRole('button',{name:'编辑',exact:true}).click();await dialog.waitFor();
  await page.setViewportSize({width:375,height:650});await raf();const mobileDialog=await dialog.boundingBox();assert.ok(mobileDialog.x>=0&&mobileDialog.x+mobileDialog.width<=375,'375px editor remains inside viewport');
  report.mobile={dialog:mobileDialog,nativePanelHidden:!await mobilePanel.isVisible(),limitation:'Native library hides the sidebar at 375px; an already opened editor remains usable. Mobile sidebar entry is not proven.'};
  await page.screenshot({path:path.join(output,'mobile-375.png')});await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.setViewportSize({width:1600,height:900});await page.evaluate(()=>ui.open());await mobilePanel.waitFor({state:'visible'});
  await chart.evaluate(()=>{const root=document.querySelector('.chart-alert-panel');const nodes=[root,...root.querySelectorAll('*')];const sizes=nodes.map(n=>parseFloat(getComputedStyle(n).fontSize));nodes.forEach((n,i)=>{if(sizes[i])n.style.setProperty('font-size',sizes[i]*2+'px','important')});});
  report.text200=await mobilePanel.evaluate(n=>({box:n.getBoundingClientRect().toJSON(),scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,subtitleLineHeight:getComputedStyle(n.querySelector('.alert-row-subtitle')).lineHeight,subtitleHeight:n.querySelector('.alert-row-subtitle').getBoundingClientRect().height}));assert.ok(report.text200.scrollWidth<=report.text200.clientWidth+1,'200% text has no panel horizontal overflow');
  assert.ok(report.text200.subtitleHeight+0.05>=parseFloat(report.text200.subtitleLineHeight),'200% secondary text is not clipped by a fixed row height');
  await page.screenshot({path:path.join(output,'text-200.png')});
  report.cases.push('375px editor bounded; native sidebar hidden at that width. True 200% computed text sizes: no panel horizontal overflow and secondary text has room to grow.');
  await page.evaluate(()=>{bridge.destroy();ui.destroy()});assert.equal(await chart.locator('[data-name="mw-alert-price-label"]').count(),0);assert.equal(await chart.locator('[data-name="mw-alert-price-dot"]').count(),0);
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(e){report.failure=String(e);await page.screenshot({path:path.join(output,'failure.png')});process.exitCode=1;}
 finally{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})();
