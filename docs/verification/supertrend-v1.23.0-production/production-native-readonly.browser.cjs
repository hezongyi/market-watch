const {chromium,expect}=require('/home/quant/repos/market-watch/web/node_modules/@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const ROOT='/tmp/mw-v1230-production-20261012',APP='https://trade.kookvv.com:8443',CHART='https://charts.kookvv.com:8443';
(async()=>{
const browser=await chromium.launch({executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1600,height:1000}});const page=await context.newPage();page.setDefaultTimeout(30000);
const report={scope:'Unraid formal production; Ubuntu browser; existing workspace, read-only UI and market subscriptions; preference migration and native preference saves suppressed',passed:false,cases:[],errors:[],http_errors:[],credential_leaks:[],unexpected_writes:[],blocked_preference_saves:[]};let phase='login';let logged=false;const debug=setInterval(async()=>{const f=page.frames().find(f=>f.url().startsWith(CHART+'/?'));if(f){const v=await f.evaluate(()=>typeof widget==='undefined'?{}:{chartCount:widget.chartsCount(),symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),dataReady:widget.activeChart().dataReady(),pending:pending.size,queue:requests.length,loading}).catch(()=>({}));console.log('Chart diagnostic',JSON.stringify(v));}},20000);
await page.route('**/api/**',async route=>{
 const r=route.request(),p=new URL(r.url()).pathname;
 const readPosts=['/api/login','/api/logout','/api/charts/history-loads','/api/charts/data','/api/charts/reserve','/api/charts/snapshot','/api/charts/provider/subscribe','/api/charts/provider/unsubscribe','/api/charts/stream/subscribe','/api/charts/stream/unsubscribe','/api/market-data/history','/api/market-data/activity','/api/market-data/viewport-session','/api/market-data/quotes','/api/market-data/resolve','/api/market-data/dataset','/api/market-data/history/cache','/api/chart-alerts/capabilities'];
 if(!['GET','HEAD','OPTIONS'].includes(r.method()) && !(r.method()==='POST'&&(readPosts.includes(p)||/^\/api\/charts\/history-loads\/[^/]+\/(touch|cancel)$/.test(p)))){
  if(p==='/api/advanced-charts/preferences/migrate')return route.fulfill({status:200,contentType:'application/json',body:'{"migrated":0}'});
  if(p==='/api/advanced-charts/preferences/save'||p==='/api/advanced-charts/native-charts/save'){
    const body=r.postDataJSON();fs.appendFileSync(ROOT+'/blocked-preferences.private.jsonl',JSON.stringify(body)+'\n',{mode:0o600});report.blocked_preference_saves.push({path:p,kind:body.kind,name:body.name});return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:body.id||'production-session-verification',name:body.name||'production session',revision:body.revision||0,document:{engine:'tv31',schemaVersion:1,symbol:body.symbol,interval:body.resolution,state:typeof body.content==='string'?JSON.parse(body.content):(body.content||{})}})});
  }
  report.unexpected_writes.push(p);return route.abort('blockedbyclient');
 }
 return route.continue();
});
await page.addInitScript(()=>{
 const Original=window.EventSource;window.__marketEvents=[];
 window.EventSource=class extends Original{constructor(url,options){super(url,options);if(String(url).startsWith('/api/charts/stream/events'))this.addEventListener('message',e=>{const v=JSON.parse(e.data);window.__marketEvents.push({type:v.type,sequence:v.sequence});});}};
});
page.on('pageerror',e=>report.errors.push({phase,message:e.stack||String(e)}));report.started_at=new Date().toISOString();
page.on('response',r=>{const p=new URL(r.url()).pathname;if(!logged&&p==='/api/session'&&r.status()===401)return;if(r.status()>=400)report.http_errors.push({path:p,status:r.status()});});
page.on('request',r=>{if(r.url().startsWith(CHART+'/')&&(r.headers().cookie||r.headers().authorization))report.credential_leaks.push(new URL(r.url()).pathname);});
try{
 await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(process.env.MW_PRODUCTION_LOGIN_FILE)).password);
 const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));await page.getByRole('button',{name:'登录工作台'}).click();assert.equal((await login).status(),200);logged=true;
 const cookie=(await context.cookies()).find(c=>c.name==='session');assert(cookie.secure&&cookie.httpOnly);report.cases.push('HTTPS administrator login and Secure/HttpOnly session');
 const workspaces=await page.evaluate(async()=>{const r=await fetch('/api/advanced-charts/workspaces');if(!r.ok)throw Error('Workspace read '+r.status);return(await r.json()).map(w=>({id:w.id,revision:w.revision}));});assert(workspaces.length>0);report.existing_workspaces=workspaces;
 const calendar=await context.request.get(APP+'/api/market-data/center/calendars');assert.equal(calendar.status(),200);const cal=await calendar.json();const rowids=cal.items.filter(v=>v.row_id).map(v=>v.row_id);assert.equal(new Set(rowids).size,rowids.length);report.calendar_rows=cal.items.length;
 const health=await context.request.get(APP+'/api/health');assert.equal(health.status(),200);report.health=await health.json();
 await page.goto(APP+'/advanced-charts');await expect.poll(()=>page.frames().some(f=>f.url().startsWith(CHART+'/?')),{timeout:30000}).toBe(true);
 let host=page.frames().find(f=>f.url().startsWith(CHART+'/?'));await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&alertUI&&dataCenter&&widget.activeChart().dataReady(),null,{timeout:90000});
 report.chart_count=await host.evaluate(()=>widget.chartsCount());assert.equal(report.chart_count,5);console.log('Existing production five-chart layout and alertUI ready');let native=host.childFrames()[0];await expect(host.locator('[data-name="mw-alert-state"]')).toHaveCount(1);
 await expect.poll(()=>page.evaluate(()=>window.__marketEvents.filter(e=>['bars','quotes'].includes(e.type)).length),{timeout:60000}).toBeGreaterThan(0);report.cases.push('Existing production chart ready, one alert business root, actual bars/quotes through authenticated SSE');
 const catalog=await (await context.request.get(APP+'/api/advanced-charts/catalog')).json();assert(catalog.SUPERTREND_PINE_V1&&catalog.SWING_SR_V1);
 const legacy=await (await context.request.get(APP+'/api/charts/catalog')).json();assert.deepEqual(Object.keys(legacy.indicators).sort(),['SMA','EMA','LWMA','BBANDS','RSI','MACD','ATR','STOCH'].sort());
 console.log('Production catalogs and SSE verified');
 const original=await host.evaluate(()=>new Promise(resolve=>widget.save(resolve)));
 phase='single-chart-native-verification';const fixture=JSON.parse(fs.readFileSync(ROOT+'/single-chart-fixture.private.json'));await host.evaluate(fixture=>{void widget.load(fixture).catch(e=>globalThis.productionFixtureLoadError=String(e))},fixture);
 await host.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:120000});
 assert.equal(await host.evaluate(()=>widget.activeChart().symbol()),'MWP:EURUSD');assert.equal(await host.evaluate(()=>widget.chartsCount()),1);console.log('Production OANDA daily candles ready');
 await host.evaluate(()=>widget.activeChart().removeAllStudies());
 const ids=await host.evaluate(async()=>[await widget.activeChart().createStudy('守望 Python SUPERTREND_PINE_V1',false,false),await widget.activeChart().createStudy('守望 Python SUPERTREND_PINE_V1',false,false,{period:7,source:'ohlc4',multiplier:2,changeATR:false}),await widget.activeChart().createStudy('守望 Python SWING_SR_V1',false,false,{high_strength:3,low_strength:7})]);assert(ids.every(Boolean));
 await host.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:120000});
 await host.evaluate(()=>{globalThis.samples=[];widget.activeChart().crossHairMoved().subscribe(null,s=>samples.push(s))});
 console.log('Three native studies calculated');
 const box=await native.locator('.chart-container').first().boundingBox();
 await expect.poll(async()=>{await host.evaluate(()=>samples=[]);for(let i=0;i<12;i++){await page.mouse.move(box.x+box.width*(0.2+i*0.055),box.y+box.height*0.4);await page.waitForTimeout(40)}return host.evaluate(ids=>ids.every(id=>samples.some(s=>s.entityValues?.[id]?.values.some(v=>typeof v.value==='string'&&Number.isFinite(Number(v.value.replace(/,/g,'')))))),ids)},{timeout:90000}).toBe(true);
 await host.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale()?.setAutoScale(true));await page.waitForTimeout(1000);
 await page.screenshot({path:ROOT+'/production-supertrend-dark.png'});
 await host.evaluate(id=>widget.activeChart().showPropertiesDialog(id),ids[0]);await native.getByText('输入',{exact:true}).click();await native.getByText('ATR Period',{exact:true}).waitFor();assert((await native.locator('input[type=checkbox]').count())>=3);await page.screenshot({path:ROOT+'/production-supertrend-settings.png'});await page.keyboard.press('Escape');
 await host.evaluate(async ids=>{await widget.activeChart().getStudyById(ids[0]).setInputValues([{id:'showsignals',value:false},{id:'highlighting',value:false}]);await widget.activeChart().getStudyById(ids[2]).setInputValues([{id:'show_average_spacing',value:false},{id:'statistics_position',value:'bottom_left'}]);await widget.activeChart().getStudyById(ids[1]).applyOverrides({'Up Trend.color':'#9c27b0','Down Trend.linewidth':3})},ids);
 await page.waitForTimeout(1000);
 const template=await host.evaluate(()=>widget.activeChart().createStudyTemplate({saveSymbol:true,saveInterval:true}));await host.evaluate(template=>widget.activeChart().applyStudyTemplate(template),template);
 await host.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:120000});
 const values=await host.evaluate(()=>widget.activeChart().getAllStudies().filter(s=>s.name.includes('SUPERTREND_PINE_V1')||s.name.includes('SWING_SR_V1')).map(s=>({name:s.name,inputs:widget.activeChart().getStudyById(s.id).getInputValues()})));
 assert.equal(values.filter(s=>s.name.includes('SUPERTREND_PINE_V1')).length,2);assert(values.some(s=>s.inputs.some(i=>i.id==='showsignals'&&i.value===false)));assert(values.some(s=>s.inputs.some(i=>i.id==='low_strength'&&i.value===7)));assert(values.some(s=>s.inputs.some(i=>i.id==='statistics_position'&&i.value==='bottom_left')));report.native_study_inputs=values;
 await host.evaluate(()=>widget.changeTheme('Light'));await page.waitForTimeout(1500);await page.screenshot({path:ROOT+'/production-supertrend-light.png'});
 phase='server-workspace-reload';await page.reload();await expect.poll(()=>page.frames().some(f=>f.url().startsWith(CHART+'/?')),{timeout:30000}).toBe(true);host=page.frames().find(f=>f.url().startsWith(CHART+'/?'));await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&alertUI&&dataCenter&&widget.activeChart().dataReady(),null,{timeout:120000});native=host.childFrames()[0];assert.equal(await host.evaluate(()=>widget.chartsCount()),5);report.cases.push('Production server reload restores original five-chart layout; verification studies were never saved');
 report.cases.push('Production native Supertrend x2 and Swing: finite crosshair values, Boolean settings, independent inputs/styles, study-template restoration, dark/light screenshots; session-only changes');
 await host.evaluate(()=>alertUI.open());await expect(native.locator('.chart-alert-panel')).toBeVisible();
 await host.evaluate(()=>alertBridge.create());const dialog=native.locator('[data-name="mw-native-alert-dialog"]');await expect(dialog).toBeVisible();
 await dialog.getByRole('button',{name:'消息',exact:true}).click();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog.getByRole('button',{name:'消息',exact:true})).toBeFocused();
 await dialog.getByRole('button',{name:'通知',exact:true}).click();await page.keyboard.press('Escape');await expect(dialog.getByRole('button',{name:'通知',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 report.cases.push('Deployed native alert sidebar/dialog, message cancel and notification Escape restore entry focus; no alert saved');
 await native.getByRole('button',{name:'数据中心',exact:true}).click();const center=native.locator('.dc-window');await expect(center).toBeVisible();
 for(const name of ['自建行情','平台行情','组合行情','任务与记录','来源状态','交易日历'])await expect(center.locator('.dc-window-nav').getByRole('button',{name,exact:true})).toBeVisible();
 const status=page.waitForResponse(r=>r.url().endsWith('/api/market-data/live/status'));await center.getByRole('button',{name:'来源状态',exact:true}).click();assert.equal((await status).status(),200);await native.getByRole('button',{name:'关闭数据中心',exact:true}).click();report.cases.push('Production data center retains six sections and source-status actual read');
 await native.getByRole('button',{name:'指标',exact:true}).click();await expect(native.locator('.mw-native-indicator-content')).toBeVisible();await native.getByRole('button',{name:'关闭指标窗口',exact:true}).click();report.cases.push('Native indicator window coexists with alerts');
 await page.screenshot({path:ROOT+'/production-native-alert.png'});report.market_events=await page.evaluate(()=>window.__marketEvents);
 await page.goto(APP+'/');await page.setViewportSize({width:390,height:844});await page.screenshot({path:ROOT+'/production-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);report.cases.push('390px production home has no horizontal overflow');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.http_errors,[]);assert.deepEqual(report.credential_leaks,[]);assert.deepEqual(report.unexpected_writes,[]);report.passed=true;
}catch(e){report.failure=String(e);const host=page.frames().find(f=>f.url().startsWith(CHART+'/?'));report.diagnostic=await host?.evaluate(()=>({pending:pending.size,queue:requests.map(v=>({symbol:v.query?.symbol,indicators:v.query?.indicators})),subscriptions:[...subscriptions.values()].map(s=>({symbol:s.symbol,needsHistoryReload:s.needsHistoryReload})),ready:widget.activeChart().dataReady()})).catch(()=>({}));process.exitCode=1;await page.screenshot({path:ROOT+'/production-browser-failure.png'}).catch(()=>{});}
finally{
 clearInterval(debug);if(logged){try{const session=await context.request.get(APP+'/api/session');const s=await session.json();assert.equal((await context.request.post(APP+'/api/logout',{headers:{'X-CSRF-Token':s.csrf}})).status(),200);report.logout_verified=true;}catch(e){report.passed=false;report.logout_error=String(e);process.exitCode=1;}}
 fs.writeFileSync(ROOT+'/production-browser.json',JSON.stringify(report,null,2)+'\n');report.completed_at=new Date().toISOString();console.log(JSON.stringify({passed:report.passed,cases:report.cases,failure:report.failure,errors:report.errors,http_errors:report.http_errors,unexpected_writes:report.unexpected_writes,market_events:report.market_events?.length}));await browser.close();
}
})();
