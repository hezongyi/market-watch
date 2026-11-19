// Real licensed chart + production price controller; synthetic data and writes only.
const {chromium,expect}=require('@playwright/test');
const {execFileSync}=require('node:child_process');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),library=process.env.MW_PROBE_LIBRARY,out=process.env.MW_PROBE_OUTPUT;
if(!library||!out)throw Error('MW_PROBE_LIBRARY and MW_PROBE_OUTPUT required');
fs.mkdirSync(out,{recursive:true});
const assets=path.join(out,'ui-assets');
execFileSync(process.execPath,['scripts/build-alert-ui.mjs',assets],{cwd:path.join(root,'web')});
const controller=buildSync({entryPoints:[path.join(root,'web/src/advanced/chartPriceAlertRuntime.ts')],bundle:true,write:false,format:'iife',globalName:'MWPriceAlerts'}).outputFiles[0].text;
const instrument='a'.repeat(64),ticker='MWC:'+instrument;
const feed=fs.readFileSync(path.join(__dirname,'native-alert-shell.probe.cjs'),'utf8').match(/const fixture = `([\s\S]*?)`;/)[1]
 .replaceAll("['60']","['5','60']").replaceAll("'EURUSD'",JSON.stringify(ticker))
 .replace("container:'chart',","container:'chart',context_menu:{items_processor:(items,factory,params)=>bridge.menu(items,factory,params)},");
const fixture=feed+`
globalThis.writes=[];globalThis.notes=[];globalThis.rows=[];globalThis.messages=[];globalThis.capable=true;globalThis.phone=true;globalThis.loseEdit=false;
const copy=x=>structuredClone(x);
const call=async(p,b)=>{
 if(p==='/chart-alerts/capabilities')return {composite_revision_id:'fixture-revision',phone:{available:phone},sources:[{source:'composite',series_kind:'composite',available:true,price_modes:{intrabar:{available:capable,reason:capable?null:'请先开启实时'}},atr_frames:['H1','M5']}]};
 if(b)writes.push({path:p,body:copy(b)});
 if(p==='/chart-alerts'&&b){let row=rows.find(r=>r.id===b.request_id);if(row)return copy(row);const c=b.config;row={id:b.request_id,name:c.name,config:c,version:1,control_revision:1,run:1,status:'active',health:'ready',count:0,max_triggers:1,display_identity:{code:'EURUSD',source:'composite'},created_at:Date.now(),updated_at:Date.now(),effective_at:Date.now(),condition_summary:c.name,runtime:{}};rows.push(row);return copy(row);}
 if(p.endsWith('/events'))return [];
 if(p.startsWith('/chart-alerts?')||p==='/chart-alerts')return copy(rows);
 const match=p.match(/^\\/chart-alerts\\/([^/]+)(?:\\/(edit|lifecycle))?$/);
 if(match){const row=rows.find(r=>r.id===match[1]);if(!row)throw Error('fixture missing row');if(b){if(row.version!==b.version||row.control_revision!==b.control_revision)throw Object.assign(Error('conflict'),{status:409});if(match[2]==='edit'){row.config=copy(b.config);row.name=b.config.name;row.version++;row.control_revision++;if(loseEdit){loseEdit=false;throw Error('lost successful response');}}else{row.status={pause:'paused',resume:'active',archive:'archived'}[b.action];row.control_revision++;}}return copy(row);}
 throw Error('Unexpected API '+p);
};
widget.onChartReady(async()=>{
 globalThis.bridge=chartAlertBridge({getWidget:()=>widget,getWorkspace:()=>({id:'fixture'}),getEpoch:()=>1,isLoading:()=>false,readonly:false,metadata:t=>({source:t.startsWith('MWC:')?'composite':'fxcm',basis:'bid',display_symbol:'EURUSD'}),frames:{60:'H1',5:'M5'},movePrice:()=>{throw Error('fixed prices must use narrow controller')},rpc:q=>MWPriceAlerts.chartPriceAlertRequest(q,call,()=>true),send:m=>{messages.push(m);if(m.type==='chart-alert-context')ui.context(m.context);if(m.type==='chart-alert-price-saved')ui.saved(m.row);if(m.type==='chart-alert-rule-open')ui.rule(m.alert_id);},fail:e=>notes.push(String(e))});bridge.attach();
 globalThis.ui=await MWNativeAlerts.attach({widget,scope:{workspace_id:'fixture',session:'fixture'},readonly:false,request:q=>call(q.path,q.body),bridge,report:e=>notes.push(String(e))});ui.theme('dark');globalThis.testReady=true;
});`;
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),report={scope:'licensed widget + production bridge/controller; synthetic API; no persistent writes',cases:[],errors:[],passed:false};
 page.on('pageerror',e=>report.errors.push(String(e)));
 await page.route('https://price-alert.invalid/**',route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>html,body,#chart{height:100%;margin:0}</style><div id="chart"></div>'+['/charting_library/charting_library.js','/series.js','/price-format.js','/native-alert-price-lines.js','/chart-alerts.js','/native-alert-shell.js','/alert-ui.js','/controller.js','/fixture.js'].map(s=>'<script src="'+s+'"></script>').join('')});
  if(p==='/fixture.js'||p==='/controller.js')return route.fulfill({contentType:'application/javascript',body:p==='/fixture.js'?fixture:controller});
  const file=p.startsWith('/charting_library/')?path.resolve(library,p.slice(18)):path.join(/^\/alert-ui\.(js|css)$/.test(p)?assets:path.join(root,'advanced-host'),path.basename(p));
  return fs.existsSync(file)?route.fulfill({path:file,...(file.endsWith('.js')?{contentType:'application/javascript'}:file.endsWith('.css')?{contentType:'text/css'}:{})}):route.fulfill({status:404});
 });
 try{
  await page.goto('https://price-alert.invalid/');await page.waitForFunction(()=>globalThis.testReady&&widget.activeChart().dataReady());
  const chart=page.frames().find(f=>f!==page.mainFrame());
  const labels=chart.locator('[data-name="mw-alert-price-label"]');
  async function plus(ratio=.52){const b=await page.evaluate(()=>widget.activeChart()._chartWidget.paneWidgets().find(p=>p.containsMainSeries()).canvasElement().getBoundingClientRect().toJSON());await page.mouse.move(b.left+50,b.y+b.height*ratio);await page.waitForTimeout(150);await page.mouse.move(b.right-60,b.y+b.height*ratio);await page.mouse.move(b.right-9,b.y+b.height*ratio);await page.waitForTimeout(200);await page.mouse.click(b.right-9,b.y+b.height*ratio);}
  await plus();const create=chart.getByText(/^价格穿越 .* 时提醒$/,{exact:true});await create.waitFor();
  assert.equal(await page.evaluate(()=>writes.length),0);await page.screenshot({path:path.join(out,'menu-dark.png')});await page.keyboard.press('Escape');await create.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>writes.length),0);
  await page.waitForTimeout(700);await plus(.62);await create.click();await expect(labels).toHaveCount(1);await expect(labels).toBeVisible();
  const posted=await page.evaluate(()=>writes.filter(q=>q.path==='/chart-alerts'));
  assert.equal(posted.length,1);assert.equal(posted[0].body.config.mode,'intrabar');assert.equal(posted[0].body.config.condition.relation,'cross');assert.equal(posted[0].body.config.notify_ntfy,true);assert.equal(posted[0].body.config.association,null);
  assert.equal(await chart.locator('[data-name="mw-native-alert-dialog"]').count(),0);
  await page.screenshot({path:path.join(out,'created-dark.png')});report.cases.push('Real native plus opens menu; Escape writes nothing; selection creates one cross/intrabar/once/phone rule and visible order line without editor/layout save');
  const old=await page.evaluate(()=>rows[0].config.condition.right.value),b=await labels.boundingBox();
  await page.evaluate(()=>loseEdit=true);await page.mouse.move(b.x+20,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+20,b.y+b.height/2+32,{steps:8});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>rows[0].version)).toBe(2);await expect(labels).not.toContainText(/待核实|未保存|保存中/);assert.notEqual(await page.evaluate(()=>rows[0].config.condition.right.value),old);assert.equal(await page.evaluate(()=>writes.filter(q=>q.path.endsWith('/edit')).length),1);report.cases.push('Actual pointer drag commits once, aligns native precision and recovers a successful write whose response was lost');
  await labels.click();await chart.getByRole('button',{name:'暂停',exact:true}).click();await expect(labels).toContainText('Ⅱ');await chart.getByRole('button',{name:'恢复',exact:true}).click();await expect(labels).not.toContainText('Ⅱ');await chart.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>widget.activeChart().setResolution('5'));await page.waitForFunction(()=>widget.activeChart().dataReady()&&widget.activeChart().resolution()==='5');await expect(labels).toHaveCount(1);await expect(labels).toBeVisible();report.cases.push('Pause/resume is same backend rule; fixed price remains visible after H1 to M5');
  await plus(.4);await chart.getByText('更多设置…',{exact:true}).click();await expect(chart.locator('[data-name="mw-native-alert-dialog"]')).toBeVisible();await page.screenshot({path:path.join(out,'more-settings.png')});await page.keyboard.press('Escape');
  await page.evaluate(async()=>{widget.closePopupsAndDialogs();await widget.setLayout('2h');});await page.waitForFunction(()=>widget.chartsCount()===2);await page.evaluate(async t=>{await widget.chart(1).setSymbol(t);bridge.refresh();bridge.setRows(rows);},ticker);await page.waitForFunction(()=>widget.chart(1).dataReady());await expect(labels).toHaveCount(2);report.cases.push('One rule renders in both matching chart panes; more settings opens complete native editor');
  await page.screenshot({path:path.join(out,'two-panes-dark.png')});await page.evaluate(()=>widget.changeTheme('Light'));await page.screenshot({path:path.join(out,'two-panes-light.png')});
  await page.evaluate(async()=>{await widget.setLayout('s');await widget.activeChart().setSymbol('MWP:FXCM:EURUSD');bridge.refresh();bridge.setRows(rows);});await page.waitForFunction(()=>widget.activeChart().dataReady()&&widget.chartsCount()===1);await expect(labels).toHaveCount(0);await plus();await expect(chart.getByText('原生行情暂不支持价格告警',{exact:true})).toBeVisible();await page.keyboard.press('Escape');report.cases.push('Native/provider identity never reuses same-code composite rules and cannot create alerts');
  await page.evaluate(async t=>{await widget.activeChart().setSymbol(t);capable=false;},ticker);await page.waitForFunction(()=>widget.activeChart().dataReady());await page.waitForTimeout(400);await plus();await expect(chart.getByText('请先开启实时',{exact:true})).toBeVisible();assert.equal(await create.count(),0);await page.keyboard.press('Escape');
  await page.evaluate(()=>{capable=true;phone=false;});await page.waitForTimeout(500);await plus();await expect(chart.getByText('盘中 · 一次 · 仅站内记录（手机推送未启用）',{exact:true})).toBeVisible();await create.click();await expect.poll(()=>page.evaluate(()=>rows.length)).toBe(2);assert.equal(await page.evaluate(()=>rows[1].config.notify_ntfy),false);report.cases.push('Disabled realtime is an explicit unavailable menu; unavailable phone transport falls back to stated in-app recording only');
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.failure=String(error);report.state=await page.evaluate(()=>({notes:globalThis.notes,messages:globalThis.messages?.map(m=>m.type),diagnostics:globalThis.bridge?.diagnostics(),writes:globalThis.writes?.map(q=>q.path)}));await page.screenshot({path:path.join(out,'failure.png')});process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})();
