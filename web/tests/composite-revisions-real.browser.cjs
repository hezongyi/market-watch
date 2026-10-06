// Real Ubuntu supplier preparation and explicit UI activation; no delivery/trade.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),artifacts=path.join(root,'artifacts/data-integration');
const base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[];
 let pauseRule;
 page.on('pageerror',error=>errors.push(error.message));
 try {
  await page.goto(base+'/market-data');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect.poll(async()=>{const r=await page.request.get(base+'/api/session');return r.status();}).toBe(200);
  const read=async(url)=>{const r=await page.request.get(base+url);if(!r.ok())throw Error(url+' '+r.status());return r.json();};
  const session=await read('/api/session'),headers={'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  const post=async(url,data)=>{const r=await page.request.post(base+url,{headers,data});if(!r.ok())throw Error(url+' '+r.status()+' '+await r.text());return r.json();};
  const listing=await read('/api/market-data/center/composites');
  const priorRules=await read('/api/chart-alerts');
  const composite=listing.items.find(row=>row.historical_source==='oanda'&&row.calendar==='ny17'&&
    priorRules.some(rule=>rule.config.instrument===row.id));expect(composite).toBeTruthy();
  const original=composite.active_revision_id;
  const old=await read('/api/market-data/composites/'+composite.id+'/chart?timeframe=M1&count=20&revision_id='+original+'&input_revision='+composite.preparation.input_revision);
  const options=await read('/api/market-data/composites/'+composite.id+'/revision-options');
  const baseline=options.items.find(row=>row.version_id===composite.revision.history_version_id);expect(baseline).toBeTruthy();
  const pausedRules=(await read('/api/chart-alerts')).filter(row=>row.config.series_kind==='composite'&&row.config.instrument===composite.id);
  const runningRule=await post('/api/chart-alerts',{request_id:crypto.randomUUID(),config:{...pausedRules[0].config,
    name:'修订验收持久EMA '+Date.now(),association:null,composite_revision_id:original,seam_policy:'accept_raw',
    condition:{relation:'cross_up',left:{kind:'indicator',indicator:{name:'EMA',version:'1',params:{period:19},output:'value'}},
      right:{kind:'constant',value:'2'}}}});
  pauseRule=async()=>{const row=await read('/api/chart-alerts/'+runningRule.id);
    if(row.status==='active')await post('/api/chart-alerts/'+row.id+'/lifecycle',{
      version:row.version,control_revision:row.control_revision,request_id:crypto.randomUUID(),action:'pause'});};
  await expect.poll(async()=>(await read('/api/chart-alerts/'+runningRule.id)).health,{timeout:150000}).toBe('ready');
  await page.goto(base+'/market-data/composites/'+composite.id+'?section=seam');
  const panel=page.getByRole('region',{name:'显式组合修订'});
  await panel.getByLabel('新历史基线').selectOption(baseline.version_id);
  await panel.getByLabel('实时映射版本').selectOption(composite.mapping.id);
  // Keep supplier prices/calendar intact; explicitly move the seam by one M1.
  const seam=composite.revision.seam+60000;
  await panel.getByLabel('拼接时刻（UTC）').fill(new Date(seam).toISOString().slice(0,16));
  await panel.getByLabel('明确使用非日界分钟拼接规则').check();
  await panel.getByLabel('修订原因').fill('真实实例验收：明确一分钟新拼接规则，原规则保留固定输入');
  for(const width of [1024,1440,1920]) {
    await page.setViewportSize({width,height:1000});
    const button=panel.getByRole('button',{name:'提交修订准备'});await button.scrollIntoViewIfNeeded();
    const box=await button.boundingBox();expect(box.x>=0&&box.x+box.width<=width).toBeTruthy();
    await page.screenshot({path:path.join(artifacts,'composite-revisions-form-'+width+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await panel.getByLabel('修订原因').focus();await page.keyboard.press('Tab');
  expect(await panel.evaluate(el=>el.contains(document.activeElement))).toBeTruthy();
  await panel.evaluate(el=>{el.style.zoom='2'});
  await panel.getByRole('button',{name:'提交修订准备'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifacts,'composite-revisions-form-zoom.png'),fullPage:true});
  await panel.evaluate(el=>{el.style.zoom=''});
  const created=page.waitForResponse(r=>r.url().endsWith('/revisions')&&r.request().method()==='POST');
  await panel.getByRole('button',{name:'提交修订准备'}).click();
  const response=await created;expect(response.status()).toBe(201);
  const revision=await response.json();
  expect(revision.change.affected_rules.some(row=>row.id===runningRule.id)).toBeTruthy();
  expect((await read('/api/market-data/composites/'+composite.id)).active_revision_id).toBe(original);
  checks.push('desktop form submits independent exact revision; old chart stays active during preparation');
  await expect.poll(async()=>{const rows=await read('/api/market-data/composites/'+composite.id+'/revisions');
    return rows.items.find(row=>row.id===revision.id)?.preparation.ready;},{timeout:240000}).toBeTruthy();
  const attempts=await read('/api/market-data/composites/'+composite.id+'/requests');
  // API list remains the active old revision; candidate evidence is checked via
  // its returned preparation and later actual activation, never injected inputs.
  const article=panel.locator('#composite-revision-'+revision.id);
  await expect(article.getByRole('button',{name:'启用此修订'})).toBeEnabled({timeout:30000});
  const activated=page.waitForResponse(r=>r.url().endsWith('/'+revision.id+'/activate'));
  await article.getByRole('button',{name:'启用此修订'}).click();
  const activationResponse=await activated;expect(activationResponse.status()).toBe(200);
  const activation=await activationResponse.json();
  expect(activation.activation.previous_revision_id).toBe(original);
  expect(activation.activation.event_boundary%60000).toBe(0);
  const current=await read('/api/market-data/composites/'+composite.id);
  expect(current.active_revision_id).toBe(revision.id);expect(current.revision.seam).toBe(seam);
  const oldAgain=await read('/api/market-data/composites/'+composite.id+'/chart?timeframe=M1&count=20&revision_id='+original+'&input_revision='+composite.preparation.input_revision);
  expect(oldAgain.bars).toEqual(old.bars);
  for(const rule of pausedRules){const saved=await read('/api/chart-alerts/'+rule.id);
    expect(saved.market_identity).toEqual(rule.market_identity);expect(saved.status).toBe(rule.status);}
  expect((await read('/api/chart-alerts/'+runningRule.id)).market_identity).toEqual(runningRule.market_identity);
  const status=await read('/api/market-data/composites/'+composite.id+'/revisions');
  const result=status.items.find(row=>row.id===revision.id);
  expect(result.preparation.indicators.some(row=>row.spec.name==='EMA'&&row.status==='complete')).toBeTruthy();
  checks.push('actual supplier-backed preparation completed; explicit event-boundary activation; old input/rules remain unchanged');
  await page.screenshot({path:path.join(artifacts,'composite-revisions-activated.png'),fullPage:true});
  expect(errors).toEqual([]);
  await pauseRule();
  fs.writeFileSync(path.join(artifacts,'composite-revisions-browser-real.json'),JSON.stringify({passed:true,
    environment:'Ubuntu market-watch-three-layer',checks,composite_id:composite.id,old_revision_id:original,
    new_revision_id:revision.id,activation:activation.activation,retained_rule_count:pausedRules.length+1,
    prepared_indicators:result.preparation.indicators,
    old_request_count:attempts.total,external_delivery:false},null,2));
  console.log(JSON.stringify({passed:true,checks}));
 }catch(error){if(pauseRule)await pauseRule().catch(cleanup=>errors.push('rule cleanup: '+String(cleanup)));
  await page.screenshot({path:path.join(artifacts,'composite-revisions-failed.png'),fullPage:true}).catch(()=>{});
  fs.writeFileSync(path.join(artifacts,'composite-revisions-browser-failed.json'),JSON.stringify({error:String(error),errors},null,2));throw error;
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
