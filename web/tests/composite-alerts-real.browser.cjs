// Actual Ubuntu fixed composite rule, native form and browser-independent monitor.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),artifacts=path.join(root,'artifacts/data-integration');
const base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const checks=[],errors=[],ids=[];
 page.on('pageerror',error=>errors.push(error.message));
 let pauseRules;
 try {
  await page.goto(base+'/market-data');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));
  await page.getByRole('button',{name:'登录工作台'}).click();expect((await login).status()).toBe(200);
  const session=await(await page.request.get(base+'/api/session')).json();
  const headers={'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  const post=async(url,data)=>{const r=await page.request.post(base+url,{headers,data});
    if(!r.ok())throw Error(url+' '+r.status()+' '+await r.text());return r.json();};
  const read=async(url)=>{const r=await page.request.get(base+url);if(!r.ok())throw Error(url+' '+r.status());return r.json();};
  pauseRules=async()=>{for(const id of ids){const row=await read('/api/chart-alerts/'+id);
    if(row.status==='active')await post('/api/chart-alerts/'+id+'/lifecycle',{
      version:row.version,control_revision:row.control_revision,request_id:crypto.randomUUID(),action:'pause'});}};
  const rows=await read('/api/market-data/series/search?query=EURUSD&kind=composite');
  const composite=rows.find(row=>row.historical_source==='oanda' && row.calendar==='ny17');expect(composite).toBeTruthy();
  await page.goto(base+'/advanced-charts');
  await page.locator('iframe[title="专业图表工作区"]').waitFor({timeout:30000});
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith('http://127.0.0.1:16630/'))).toBeTruthy();
  const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
  await frame.waitForFunction(()=>typeof ready!=='undefined' && ready && !loading && widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.evaluate(ticker=>widget.activeChart().setSymbol(ticker),composite.ticker);
  await frame.waitForFunction(ticker=>MWSeries.same(widget.activeChart().symbol(),ticker) && widget.activeChart().dataReady(),composite.ticker,{timeout:60000});
  await frame.evaluate(()=>widget.activeChart().setResolution('1'));
  await frame.waitForFunction(()=>widget.activeChart().resolution()==='1' && widget.activeChart().dataReady());
  await frame.waitForFunction(ticker=>alertCompositeRevisions.has(MWSeries.encode(MWSeries.decode(ticker).symbol,'composite')+'|1'),composite.ticker);
  await frame.evaluate(()=>alertBridge.create({chart:widget.activeChart(),price:2}));
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  expect(await dialog.getByLabel('指标依赖含原价接缝时').inputValue()).toBe('reject');
  for(const width of [1024,1440,1920]) {
    await page.setViewportSize({width,height:1000});
    const button=dialog.getByRole('button',{name:'创建告警',exact:true});
    await button.scrollIntoViewIfNeeded();
    const box=await button.boundingBox();expect(box.x>=0 && box.x+box.width<=width).toBeTruthy();
    await page.screenshot({path:path.join(artifacts,'composite-alerts-form-'+width+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>{document.querySelector('dialog').style.zoom='2';});
  await dialog.getByLabel('指标依赖含原价接缝时').focus();expect(await dialog.getByLabel('指标依赖含原价接缝时').evaluate(el=>el===document.activeElement)).toBeTruthy();
  await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBeTruthy();
  await page.screenshot({path:path.join(artifacts,'composite-alerts-form-zoom.png'),fullPage:true});
  await page.evaluate(()=>{document.querySelector('dialog').style.zoom='';});
  checks.push('native fixed composite context, explicit seam policy, three desktop widths and keyboard/zoom');
  const name='真实组合固定规则 '+Date.now();
  await dialog.getByLabel('名称',{exact:true}).fill(name);
  await dialog.getByLabel('比较值',{exact:true}).fill('2');
  const created=page.waitForResponse(r=>r.url().endsWith('/api/chart-alerts') && r.request().method()==='POST');
  await dialog.getByRole('button',{name:'创建告警',exact:true}).click();
  const response=await created;expect(response.status()).toBe(201);
  const priceRule=await response.json();ids.push(priceRule.id);
  expect(priceRule.config.series_kind).toBe('composite');expect(priceRule.market_identity.composite_revision_id).toBeTruthy();
  await dialog.waitFor({state:'hidden'});
  checks.push('native form persists exact composite revision and default confirmed-close mode');
  await page.goto(base+'/market-data'); // No native chart polling/quote demand remains.
  // A chart lease lasts two minutes after its last request. Wait for actual
  // zero leases before claiming the durable rule alone keeps collection alive.
  await expect.poll(async()=>{const row=await read('/api/market-data/composites/'+composite.id);
    return row.usage.charts;},{timeout:170000}).toBe(0);
  await expect.poll(async()=>{const row=await read('/api/chart-alerts/'+priceRule.id);return row.health;},
    {timeout:150000}).toBe('ready');
  const first=await read('/api/chart-alerts/'+priceRule.id),sequence=first.runtime.confirmed_end;
  await expect.poll(async()=>{const row=await read('/api/chart-alerts/'+priceRule.id);return row.runtime.confirmed_end>sequence;},
    {timeout:150000}).toBeTruthy();
  const judgments=await read('/api/chart-alerts/'+priceRule.id+'/judgments');
  expect(judgments.length).toBeGreaterThan(1);expect(judgments.every(row=>row.revision_id===priceRule.market_identity.composite_revision_id)).toBeTruthy();
  expect(judgments.every(row=>row.signal_id===null)).toBeTruthy();
  checks.push('browser closed chart; real confirmed M1 advances persistent fixed rule and immutable no-event evidence');
  // Explicit recursive seam policy via actual API, preserving the same fixed binding.
  const indicator={name:'EMA',version:'1',params:{period:19},output:'value'};
  for(const policy of ['reject','accept_raw']) {
    const rule=await post('/api/chart-alerts',{request_id:crypto.randomUUID(),config:{...priceRule.config,
      name:'真实组合 EMA '+policy,association:null,seam_policy:policy,
      condition:{relation:'cross_up',left:{kind:'indicator',indicator},right:{kind:'constant',value:'2'}}}});
    ids.push(rule.id);
    await expect.poll(async()=>{const r=await read('/api/chart-alerts/'+rule.id);return r.health==='ready' ||
      r.health==='blocked' && /接缝/.test(r.health_reason || '');},{timeout:150000}).toBeTruthy();
    const current=await read('/api/chart-alerts/'+rule.id);
    if(policy==='accept_raw')expect(current.health).toBe('ready');
    checks.push('actual fixed recursive EMA '+policy+' dependency gate: '+current.health);
  }
  await page.goto(base+'/market-data/composites/'+composite.id+'?section=usage');
  await page.getByRole('table').getByText(name,{exact:true}).waitFor();
  await page.screenshot({path:path.join(artifacts,'composite-alerts-usage-real.png'),fullPage:true});
  await pauseRules();
  expect(errors).toEqual([]);
  fs.writeFileSync(path.join(artifacts,'composite-alerts-browser-real.json'),JSON.stringify({passed:true,
    environment:'Ubuntu market-watch-three-layer',checks,rule_ids:ids,judgments:judgments.map(row=>({id:row.id,
      outcome:row.outcome,input_revision:row.input_revision,event_time:row.event_time})),external_delivery:false},null,2));
  console.log(JSON.stringify({passed:true,checks}));
 } catch(error) {
  if(pauseRules)await pauseRules().catch(cleanup=>errors.push('rule cleanup: '+String(cleanup)));
  await page.screenshot({path:path.join(artifacts,'composite-alerts-browser-failed.png'),fullPage:true}).catch(()=>{});
  fs.writeFileSync(path.join(artifacts,'composite-alerts-browser-failed.json'),JSON.stringify({error:String(error),errors,rule_ids:ids},null,2));
  throw error;
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
