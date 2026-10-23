// Actual Ubuntu application screenshots for manual visual review.
// Supplier I/O stays synthetic. No persisted workspace or external delivery.
const {product}=require('./pro-charts-support.cjs');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const directory='docs/verification/pro-charts-20261011/visual-acceptance';fs.mkdirSync(directory,{recursive:true});
const report={environment:'Ubuntu quant-server / mw-pro-charts-20261011',url:'http://localhost:19997/advanced-charts',supply:'Task synthetic provider I/O; real API, PostgreSQL and licensed chart engine',screenshots:[],errors:[],visualReview:'pending'};
const composite='MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a';
async function capture(p,name,requirement,notes=''){
 await p.page.mouse.move(3,3);await p.page.waitForTimeout(300);
 const file=name+'.png';await p.page.screenshot({path:path.join(directory,file),fullPage:true});
 report.screenshots.push({file,requirement,notes,viewport:p.page.viewportSize(),capturedAtUtc:new Date().toISOString(),review:'pending'});
 fs.writeFileSync(path.join(directory,'capture.json'),JSON.stringify(report,null,2)+'\n');console.log('CAPTURE',file);
}
async function closeCenter(p){
 if(await p.center.count()){
  await p.center.getByRole('button',{name:'关闭数据中心',exact:true}).click();
  const discard=p.center.getByRole('button',{name:'放弃修改',exact:true});if(await discard.count())await discard.click();
  await p.expect(p.center).toHaveCount(0);
 }
}
async function openCenter(p,route){await closeCenter(p);await p.host.evaluate(r=>dataCenter.open(r),route);await p.expect(p.center).toBeVisible();await p.page.waitForTimeout(500);}
async function series(p,symbol,resolution){
 await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('s');});
 await p.host.waitForFunction(()=>widget.chartsCount()===1);
 await p.host.evaluate(async({symbol,resolution})=>{const c=widget.activeChart();c.removeAllStudies();c.removeAllShapes();if(!MWSeries.same(c.symbol(),symbol))await c.setSymbol(symbol,{doNotActivateChart:true});if(c.resolution()!==resolution)await c.setResolution(resolution,{doNotActivateChart:true});},{symbol,resolution});
 await p.host.waitForFunction(()=>!loading&&widget.activeChart().dataReady()&&!pending.size&&!requests.length,null,{timeout:90000});
}
async function choosePython(p){
 await p.expect(p.ui.locator('.mw-native-indicator-content')).toBeVisible();
 const button=p.ui.getByRole('button',{name:'我的 Python',exact:true});
 if(await button.isVisible())await button.click();
 else {await p.ui.getByRole('button',{name:'指标分类',exact:true}).click();await p.ui.getByRole('option',{name:'我的 Python',exact:true}).click();}
 await p.expect(p.ui.locator('.mw-native-study-row')).toHaveCount(8);
}
async function calendarBottom(p){
 await p.center.locator('.dc-window-content').evaluate(n=>n.scrollTop=n.scrollHeight);
 await p.page.waitForTimeout(200);
}
async function menu(p){
 const point=await p.host.evaluate(()=>{const pane=widget.activeChart()._chartWidget.paneWidgets().find(p=>p.containsMainSeries()),r=pane.canvasElement().getBoundingClientRect();for(let y=80;y<r.height-20;y+=20)for(let x=100;x<r.width-20;x+=20)if(pane._dataSourceAtPoint(x,y)===null)return{x:r.x+x,y:r.y+y};throw Error('No blank chart point');});
 const frame=await(await p.ui.frameElement()).boundingBox();await p.page.mouse.click(frame.x+point.x,frame.y+point.y,{button:'right'});await p.expect(p.ui.getByText(/^在 .+ 创建价格告警…$/).first()).toBeVisible();
}
function progress(mode,id){
 const args=['python','-',mode];if(id){assert.match(id,/^[a-f0-9-]{36}$/);args.push(id);}
 const out=cp.execFileSync('sg',['docker','-c','docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml exec -T api '+args.join(' ')],{input:fs.readFileSync('docs/verification/pro-charts-20261011/derive-progress-runtime.py'),encoding:'utf8',timeout:60000});return JSON.parse(out.trim().split('\n').at(-1));
}
(async()=>{
 const p=await product();let seeded;
 try {
  seeded=progress('seed');report.progressFixture=seeded.version;
  for(const theme of ['Dark','Light']) {
   const prefix=theme.toLowerCase();await p.page.setViewportSize({width:1600,height:1000});await p.host.evaluate(t=>widget.changeTheme(t),theme);
   await series(p,composite,'60');
   const watch=p.ui.getByRole('button',{name:'观察清单和详情',exact:true});if(await watch.getAttribute('aria-pressed')==='true')await watch.click();
   await p.host.evaluate(()=>widget.setLayout('2-3'));await p.host.waitForFunction(()=>widget.chartsCount()===5);
   for(let i=0;i<5;i++)await p.host.evaluate(async i=>{const c=widget.chart(i),r=['60','5','1W','1D','240'][i];c.removeAllStudies();c.removeAllShapes();if(!MWSeries.same(c.symbol(),'MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a'))await c.setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a',{doNotActivateChart:true});if(c.resolution()!==r)await c.setResolution(r,{doNotActivateChart:true});},i);
   await p.host.waitForFunction(()=>Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:90000});
   await capture(p,prefix+'-01-five-charts','F1/U6','Five real native panes: H1/M5/W1/D1/H4, current fixed composite revision.');
   await series(p,composite,'60');await watch.click();await p.expect(p.ui.locator('[data-test-id-widget-type="detail"]')).toBeVisible();await p.expect(p.ui.locator('[data-name="mw-quote-details-time"]')).toHaveCount(0);
   await capture(p,prefix+'-02-symbol-details','U3/U4','Native TradingView quote details; no host-injected status/time extension.');
   await p.ui.getByRole('button',{name:'警报',exact:true}).click();await p.expect(p.ui.getByRole('tab',{name:'警报',exact:true})).toBeVisible();
   await p.ui.getByRole('tab',{name:'警报',exact:true}).click();
   await capture(p,prefix+'-03-alert-sidebar','F3/U2/U8');
   await p.ui.locator('.chart-alert-card .alert-row-summary').first().click();await capture(p,prefix+'-03-alert-expanded','F3/U8','Keyboard/pointer disclosure exposes full condition, source, status and health.');await p.ui.locator('.chart-alert-card .alert-row-summary').first().click();
   await p.ui.getByRole('tab',{name:'日志',exact:true}).click();await capture(p,prefix+'-04-alert-log','F3/U8');
   await p.ui.locator('.chart-alert-card .alert-row-summary').first().click();await capture(p,prefix+'-04-alert-log-expanded','F3/U8','Actual stored event values and times; no external delivery.');await p.ui.locator('.chart-alert-card .alert-row-summary').first().click();
   await p.ui.getByRole('button',{name:'警报',exact:true}).click();
   await menu(p);await capture(p,prefix+'-05-price-menu','F3/U8');await p.ui.getByText(/^在 .+ 创建价格告警…$/).first().click();
   await p.expect(p.ui.getByLabel('比较值',{exact:true})).toBeVisible();await capture(p,prefix+'-06-price-alert-dialog','F3/U8','Current initiating chart identity and formatter; draft only.');
   await p.ui.getByRole('button',{name:'取消（保留草稿）',exact:true}).click();
   await p.ui.getByRole('button',{name:'指标',exact:true}).click();await choosePython(p);
   await capture(p,prefix+'-07-python-indicators','F6/U5');
   await p.ui.locator('.mw-native-study-row[data-native-study-id="MWPythonMACD@market-watch"]').getByRole('button',{name:/查看.*详情/}).click();
   await capture(p,prefix+'-08-python-indicator-detail','F6/U5');await p.ui.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
   const shape=await p.host.evaluate(()=>widget.activeChart().createShape({time:widget.activeChart().getVisibleRange().to-600,price:1.12},{shape:'horizontal_line'}));
   await p.host.evaluate(id=>widget.activeChart().showPropertiesDialog(id),shape);await p.ui.getByText('可见范围',{exact:true}).click();
   for(const name of ['M1','M5','M15','M30','H1','H4','D1','W1','MN'])await p.expect(p.ui.getByLabel(name,{exact:true})).toBeVisible();
   await capture(p,prefix+'-09-drawing-nine-periods','U7');await p.ui.getByRole('button',{name:'取消',exact:true}).click();
   for(const [tab,label] of [['calendar','交易日历'],['tasks','任务与记录'],['managed','自建行情'],['sources','来源状态'],['composite','组合行情'],['platform','平台行情']]) {
    await openCenter(p,'/market-data?tab='+tab);await capture(p,prefix+'-10-center-'+tab,'F4/F5/U1/U5/DC1',label+' live API state');
    if(tab==='calendar') {await p.center.getByLabel('品种搜索').fill('EURUSD');await p.center.locator('.dc-calendar-row summary').first().click();await capture(p,prefix+'-11-calendar-expanded','F5/U1');await calendarBottom(p);await capture(p,prefix+'-11-calendar-bottom','U5','Actual content scroll to rule evidence and bottom rows.');}
   }
   await openCenter(p,'/market-data/composites/'+composite.slice(4)+'?section=seam');
   const baseline=p.center.getByRole('button',{name:'新历史基线',exact:true});await p.expect(baseline).toBeVisible();await baseline.click();await capture(p,prefix+'-12-baseline-dropdown','DC1');
   await p.ui.getByRole('option').filter({hasText:/NY17/}).first().click();await p.center.getByRole('button',{name:'实时映射版本',exact:true}).click();await capture(p,prefix+'-13-mapping-dropdown','DC1');await p.page.keyboard.press('Escape');
   const data=JSON.parse(fs.readFileSync('docs/verification/pro-charts-20261011/browser-data-center.json','utf8'));
   await openCenter(p,'/market-data/datasets/'+data.mapping.dataset_id+'/mapping');
   await p.expect(p.center.getByRole('button',{name:/^(选择品种|更换)$/})).toBeVisible();await p.center.getByRole('button',{name:/^(选择品种|更换)$/}).click();await capture(p,prefix+'-14-native-symbol-picker','DC1');await p.page.keyboard.press('Escape');
   progress('advance',seeded.version);
   await openCenter(p,'/market-data?tab=tasks&status=all&dataset_id='+seeded.dataset);
   const row=p.center.locator('#task-'+seeded.version);await p.expect(row).toBeVisible();await row.getByRole('button',{name:'查看任务详情',exact:true}).click();await capture(p,prefix+'-15-task-progress','F4','Real committed progress from a new task-only synthetic AUDUSD import.');
   await p.center.locator('.dc-detail-body').evaluate(n=>n.scrollTop=n.scrollHeight);await capture(p,prefix+'-15-task-bottom','F4/U5','Task detail body scrolled to time records and final fields.');
   await closeCenter(p);
   for(const width of [768,375]){
    await p.page.setViewportSize({width,height:800});await openCenter(p,'/market-data?tab=calendar');await p.center.getByLabel('品种搜索').fill('EURUSD');await p.center.locator('.dc-calendar-row summary').first().click();await capture(p,prefix+'-16-calendar-'+width,'F5/U1/U5','Narrow desktop pointer viewport, not phone emulation.');await calendarBottom(p);await capture(p,prefix+'-16-calendar-bottom-'+width,'U5','Actual scroll to the bottom; narrow desktop pointer viewport.');
    await openCenter(p,'/market-data?tab=platform');await capture(p,prefix+'-17-platform-'+width,'U5/DC1');await closeCenter(p);
    await p.ui.getByRole('button',{name:'指标',exact:true}).click();await choosePython(p);await capture(p,prefix+'-18-indicators-'+width,'F6/U5');
    await p.ui.locator('.mw-native-study-row[data-native-study-id="MWPythonMACD@market-watch"]').getByRole('button',{name:/查看.*详情/}).click();await capture(p,prefix+'-19-indicator-detail-'+width,'F6/U5','Responsive indicator detail; full panel at narrow width.');await p.ui.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
   }
  }
  progress('finish',seeded.version);report.progressFixtureFinished=true;assert.deepEqual(p.errors,[]);
 }catch(e){report.failure=e.stack;await p.page.screenshot({path:path.join(directory,'capture-failure.png'),fullPage:true}).catch(()=>{});throw e;}
 finally {
  if(seeded&&!report.progressFixtureFinished)try{progress('finish',seeded.version);report.progressFixtureFinished=true;}catch(e){report.progressCleanupFailure=e.stack;}
  report.errors=p.errors;fs.writeFileSync(path.join(directory,'capture.json'),JSON.stringify(report,null,2)+'\n');await p.browser.close();
 }
 for(const viewport of [{width:375,height:812},{width:915,height:412}]){
  const mobile=await product({viewport,isMobile:true,hasTouch:true});
  try {await capture(mobile,'mobile-readonly-'+viewport.width,'F7','Chromium touch simulation; physical-device validation belongs to user.');report.errors.push(...mobile.errors);assert.deepEqual(mobile.errors,[]);}
  catch(e){report.failure=e.stack;fs.writeFileSync(path.join(directory,'capture.json'),JSON.stringify(report,null,2)+'\n');throw e;}
  finally {await mobile.browser.close();}
 }
 report.capturePassed=true;fs.writeFileSync(path.join(directory,'capture.json'),JSON.stringify(report,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1});
