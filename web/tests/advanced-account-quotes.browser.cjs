const {chromium}=require('@playwright/test');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const APP=process.env.APP_ORIGIN||'https://192.168.7.232:15653';
const CHART=process.env.CHART_ORIGIN||'https://192.168.7.232:15654';
const credentials=process.env.MARKET_WATCH_TEST_CREDENTIALS||'/home/quant/repos/market-watch/artifacts/local-credentials.json';
const output=process.env.UI_OUTPUT||'/tmp/mw-account-quotes.json';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const report={passed:false,errors:[]};
 page.on('pageerror',e=>report.errors.push(e.message));
 let workspace;
 const api=async(route,body)=>page.evaluate(async({route,body})=>{const {csrf}=await(await fetch('/api/session')).json();const r=await fetch('/api/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(route+' '+r.status);return r.json();},{route,body});
 async function login(){await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(credentials)).password);await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));}
 try{
  await login();
  workspace=await api('advanced-charts/workspaces',{name:'账户与报价验证'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:BTCUSDT',series_kind:'provider',interval:'5'}});
  await page.goto(APP+'/advanced-charts');
  await page.frameLocator('iframe[title="专业图表工作区"]').locator('#chart').waitFor();
  const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready,null,{timeout:60000});
  const ui=frame.childFrames()[0];
  assert.equal(await ui.locator('button[data-column-type="short_name"]').innerText(),'商品');report.watchlist_header=true;
  for(const focus of ['native','host','parent']){
   await frame.evaluate(()=>widget.activeChart().getTimeScale().setBarSpacing(widget.activeChart().getTimeScale().barSpacing()+.1));
   if(focus==='native')await ui.locator('canvas').first().click({position:{x:150,y:150},force:true});
   else await (focus==='host'?frame:page).evaluate(()=>{const button=document.createElement('button');button.textContent='focus probe';document.body.appendChild(button);button.focus();});
   const saved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/native-charts/save'),{timeout:20000});
   await page.keyboard.press('Control+s');assert.equal((await saved).status(),200);
   await frame.waitForFunction(()=>!dirty);report['ctrl_s_'+focus]=true;
  }
  const quotes=await api('market-data/quotes',{symbols:['MWP:EURUSD','MWP:XAUUSD','MWP:BTCUSDT']});
  report.quotes=quotes;
  for(const row of quotes){assert.equal(row.s,'ok');for(const key of ['lp','ch','chp','prev_close_price'])assert.ok(Number.isFinite(row.v[key]),row.n+' '+key+' required');assert.ok(Math.abs(row.v.ch-(row.v.lp-row.v.prev_close_price))<1e-7);}
  report.quote_change_fields=true;
  const updates=await frame.evaluate(async()=>{const updates=[];const id='regression-observer';feed.subscribeQuotes(['MWP:BTCUSDT'],[],rows=>updates.push(rows),id);await new Promise(resolve=>setTimeout(resolve,16500));feed.unsubscribeQuotes(id);return updates;});
  assert.ok(updates.length,'native quote subscriber receives periodic refresh');report.periodic_quote_updates=updates.length;
  report.native_watchlist=await ui.locator('[data-symbol-full]').evaluateAll(es=>es.map(e=>({symbol:e.dataset.symbolFull,text:e.innerText})));
  assert.ok(report.native_watchlist.some(row=>row.text.includes('%')),'native percent cells show change');
  for(const row of quotes)assert.ok(!row.v.short_name.includes('_')&&!row.v.short_name.includes('/'));
  assert.equal(await ui.locator('[data-symbol-full="MWP:EURUSD"]').innerText().then(s=>s.includes('EURUSD')),true);
  assert.equal(await frame.evaluate(()=>widget.activeChart().symbol()),'MWP:BTCUSDT','display names preserve series routing');
  await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
  await ui.getByRole('button',{name:'修改密码',exact:true}).click();
  const dialog=ui.getByRole('dialog',{name:'修改密码',exact:true});await dialog.waitFor();
  await dialog.getByLabel('当前密码',{exact:true}).fill('wrong-password-for-test');
  const newPassword=dialog.getByLabel('新密码',{exact:true});
  let passwordRequests=0;
  page.on('request',request=>{if(request.url().endsWith('/account/password'))passwordRequests++;});
  await newPassword.fill('short');
  assert.equal(await newPassword.evaluate(e=>e.value.length),5);
  await dialog.getByLabel('确认新密码',{exact:true}).fill('short');
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await dialog.getByRole('alert').getByText('新密码须为 6–512 个字符',{exact:true}).waitFor();
  assert.equal(passwordRequests,0,'short password is rejected before the account API');
  report.password_minimum_six=true;
  await newPassword.fill('密码! 6x');
  await dialog.getByLabel('确认新密码',{exact:true}).fill('mismatched-password');
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.getByText('两次输入的新密码不一致',{exact:true}).waitFor();report.password_confirmation_validation=true;
  await dialog.getByLabel('确认新密码',{exact:true}).fill('密码! 6x');
  const rejected=page.waitForResponse(r=>r.url().endsWith('/account/password'));
  await dialog.getByRole('button',{name:'保存',exact:true}).click();assert.equal((await rejected).status(),400);await dialog.getByRole('alert').waitFor();report.password_wrong_current_rejected=true;
  await page.screenshot({path:output.replace(/\.json$/,'-password.png')});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
  const logout=page.waitForResponse(r=>r.url().endsWith('/logout'));
  await ui.getByRole('button',{name:'登出',exact:true}).click();assert.equal((await logout).status(),200);
  await page.getByLabel('管理员密码').waitFor();assert.equal(await page.evaluate(async()=> (await fetch('/api/session')).status),401);report.logout_revokes_session=true;
  await login();assert.ok(await api('session'));report.original_password_unchanged=true;
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(error){report.error=String(error);throw error;}
 finally{
  await page.goto(APP+'/').catch(()=>{});
  if(workspace){const rows=await api('advanced-charts/workspaces').catch(()=>[]);const row=rows.find(r=>r.id===workspace.id);if(row)await api('advanced-charts/workspaces/'+row.id+'/delete',{revision:row.revision});}
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
