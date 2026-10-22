const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium,expect}=require(process.cwd()+'/web/node_modules/@playwright/test');
const base='https://192.168.7.232:18280',origin='https://192.168.7.232:18281',workspace='7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:950}});const page=await context.newPage();
 const report={started:new Date().toISOString(),errors:[],checks:[],blockedWrites:[],blockedNoticeWrites:[]};page.on('pageerror',e=>report.errors.push(e.message));
 const mock=await require(process.cwd()+'/web/tests/helpers/readOnlyAcceptance.cjs').readOnlyAcceptance(context,report);
 const noticeUntil=Date.parse('2026-10-22T11:24:24.420Z');
 const get=async path=>{if(path.startsWith('/notification-center/events?'))path+='&until='+noticeUntil;const r=await context.request.get(base+'/api'+path);assert.equal(r.status(),200);return r.json()};
 let original,prefs,remote,shadow,forced=false,host;
 await context.addInitScript(()=>{window.acceptanceMessages=[];addEventListener('message',e=>{if(e.data?.type?.includes('preference')||['preferences','result'].includes(e.data?.type))window.acceptanceMessages.push({type:e.data.type,op:e.data.query?.op,id:e.data.id,error:e.data.error});});});
 const connect=async()=>{await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/')),{timeout:90000}).toBe(true);host=page.frames().find(f=>f.url().startsWith(origin+'/'));await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&activePreferences,null,{timeout:90000});await host.evaluate(()=>autoSave?.dispose());};
 try{
  await page.goto(base+'/advanced-charts/'+workspace);await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('/home/quant/repos/.mwa-composite-mapping-20261021/browser-login.json')).password);await page.locator('button.auth-submit').click();await connect();
  original=await get('/advanced-charts/workspaces/'+workspace);prefs=await get('/advanced-charts/preferences');
  for(const symbol of ['EURUSD','XAUUSD','USDCAD']){
   const list=await get('/notification-center/events?source_kind=market&q='+symbol+'&limit=100');
   report.checks.push({name:'legacy-name-search',symbol,count:list.events?.length,examples:list.events?.slice(0,3).map(e=>({id:e.id,instrument:e.instrument,display:e.instrument_display}))});
   assert.ok(list.events?.length>0,'old name search '+symbol);
   assert.ok(list.events.some(e=>e.instrument_display?.symbol===symbol),'resolved '+symbol);
  }
  const a=await get('/notification-center/events?source_kind=market&q=EUR%2FUSD&limit=100');const b=await get('/notification-center/events?source_kind=market&q=eurusd&limit=100');
  assert.deepEqual(a.events.map(e=>e.id),b.events.map(e=>e.id));report.checks.push({name:'normalized-name-search',count:a.events.length});
  // Real UI + iframe adapter, server settings replaced only within this context.
  remote={id:'a'.repeat(64),kind:'setting',name:'mw.acceptance-draft',tool:'',revision:3,content:{value:'server-3'}};
  const settingKey=JSON.stringify([remote.kind,remote.name,remote.tool]);mock.rows.set(settingKey,remote);
  await context.route('**/api/advanced-charts/preferences/save',async route=>{
   const body=route.request().postDataJSON();if(body.name!==remote.name)return route.fallback();assert.equal(body.revision,remote.revision);remote={...remote,...body,revision:remote.revision+1};mock.rows.set(settingKey,remote);return route.fulfill({json:remote});
  });
  const seed=async value=>page.evaluate(({value,base})=>{
   const key=JSON.stringify(['setting','mw.acceptance-draft','']);localStorage.setItem('mw-preference-draft:v1:admin:acceptance:'+encodeURIComponent(key),JSON.stringify({key,version:crypto.randomUUID(),kind:'setting',name:'mw.acceptance-draft',tool:'',value,base,operation:'save',at:Date.now()}));
  },{value,base:remote});
  await seed('local-choice');await page.reload();await connect();
  await page.getByRole('button',{name:'处理设置草稿',exact:true}).click();const dialog=page.getByRole('dialog',{name:'处理设置草稿'});await expect(dialog).toBeVisible();
  const chooseSeed=async()=>{const option=dialog.locator('option').filter({hasText:'mw.acceptance-draft ·'});await expect(option).toHaveCount(1);await dialog.getByLabel('未保存的设置').selectOption(await option.getAttribute('value'));};await chooseSeed();
  await expect(dialog.getByLabel('服务器设置')).toHaveValue('server-3');remote={...remote,revision:4,content:{value:'server-4'}};mock.rows.set(settingKey,remote);
  await dialog.getByRole('button',{name:'提交本地修改',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('再次变化',{timeout:45000});
  await expect(dialog.getByLabel('服务器设置')).toHaveValue('server-4');
  await dialog.getByRole('button',{name:'提交本地修改',exact:true}).click();await expect(dialog.locator('option').filter({hasText:'mw.acceptance-draft ·'})).toHaveCount(0);assert.equal(remote.content.value,'local-choice');
  await host.evaluate(()=>activePreferences.settings.setValue('mw.acceptance-draft','stale-widget'));await page.waitForTimeout(250);assert.equal(remote.content.value,'local-choice');
  await dialog.getByRole('button',{name:/^(关闭|稍后处理)$/,exact:true}).click();await expect(page.getByRole('button',{name:'重新打开图表',exact:true})).toBeVisible();
  report.checks.push({name:'local-draft-native-ui',conflictRefreshed:true,selectedValuePreserved:true,staleWidgetBlocked:true});
  await seed('discard-choice');await page.reload();await connect();await page.getByRole('button',{name:'处理设置草稿',exact:true}).click();await chooseSeed();await expect(dialog.getByLabel('服务器设置')).toHaveValue('local-choice');
  await dialog.getByRole('button',{name:'采用服务器设置',exact:true}).click();await expect(dialog.locator('option').filter({hasText:'mw.acceptance-draft ·'})).toHaveCount(0);await host.evaluate(()=>activePreferences.settings.setValue('mw.acceptance-draft','stale-after-discard'));await page.waitForTimeout(250);assert.equal(remote.content.value,'local-choice');
  report.checks.push({name:'remote-draft-native-ui',staleWidgetBlocked:true});await dialog.getByRole('button',{name:/^(关闭|稍后处理)$/,exact:true}).click();
  // Reload discovers no remaining draft; ongoing cross-tab handled hint stays visible until reopen.
  await page.screenshot({path:'/tmp/mwa-notice-reliability-20261022/draft-reopen-desktop.png'});
  await page.setViewportSize({width:390,height:850});await page.screenshot({path:'/tmp/mwa-notice-reliability-20261022/draft-reopen-mobile.png'});
  const current=await get('/advanced-charts/workspaces/'+workspace);report.workspaceCheck={beforeRevision:original.revision,afterRevision:current.revision,changed:Object.keys(original).filter(k=>JSON.stringify(original[k])!==JSON.stringify(current[k]))};report.externalWorkspaceChange=JSON.stringify(current)!==JSON.stringify(original);report.browserWorkspaceWrites=report.blockedWrites.filter(r=>!/preferences/.test(r.path));assert.deepEqual(await get('/advanced-charts/preferences'),prefs);report.preferencesUnchanged=true;
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(e){report.failure=e.stack;report.parentMessages=await page.evaluate(()=>window.acceptanceMessages);report.hostMessages=await host.evaluate(()=>window.acceptanceMessages);report.bridge=await host.evaluate(()=>({pending:[...pending.entries()].map(([id,v])=>({id,management:v.management})),requests:requests.map(r=>({type:r.type,op:r.query.op})),url:location.href})).catch(()=>null);report.shadow=remote;report.dialogText=await page.getByRole('dialog',{name:'处理设置草稿'}).innerText().catch(()=>null);process.exitCode=1;await page.screenshot({path:'/tmp/mwa-notice-reliability-20261022/notice-browser-failure.png'}).catch(()=>{});}
 finally{fs.writeFileSync('/tmp/mwa-notice-reliability-20261022/notice-browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failure:report.failure,checks:report.checks,errors:report.errors}));await browser.close();}
})();
