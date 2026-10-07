// Real native bridge receives saved/sample composite prices and audit labels.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const artifacts=path.resolve(__dirname,'../../artifacts/data-integration');
const base='http://127.0.0.1:16629';
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],checks=[];let owned;
 const get=async p=>{const r=await page.request.get(base+'/api/'+p);expect(r.ok(),p).toBe(true);return r.json()};
 const post=async(p,data)=>{const {csrf}=await get('session');const r=await page.request.post(base+'/api/'+p,{data,headers:{'X-CSRF-Token':csrf}});expect(r.ok(),p+' '+await r.text()).toBe(true);return r.json()};
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/market-data');
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('heading',{name:'数据中心',exact:true})).toBeVisible();
  const before=await get('market-data/center/composites');
  const composite=before.items.find(r=>r.logical_symbol==='EURUSD');expect(composite).toBeTruthy();
  const ticker='MWC:'+composite.id;
  const stored=(await post('market-data/quotes',{symbols:[ticker]}))[0];
  expect(stored.v.price_type).toBe('confirmed_m1_close');
  expect(stored.v.description).toContain('保存的确认M1收盘');expect(stored.v.description).toContain('UTC');
  expect((await get('market-data/center/composites')).items.map(r=>[r.id,r.usage])).toEqual(before.items.map(r=>[r.id,r.usage]));
  checks.push('stored watchlist price and date without chart or live demand');
  owned=await post('advanced-charts/workspaces',{name:'组合报价验收 '+Date.now()});
  owned=await post(`advanced-charts/workspaces/${owned.id}/save`,{name:owned.name,revision:owned.revision,
   document:{...owned.document,symbol:ticker,series_kind:'composite',interval:'1'}});
  await page.goto(base+'/advanced-charts');
  await page.locator('iframe[title="专业图表工作区"]').waitFor();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith('http://127.0.0.1:16630/'))).toBe(true);
  const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
  await frame.waitForFunction(t=>typeof ready!=='undefined'&&ready&&MWSeries.same(widget.activeChart().symbol(),t)&&widget.activeChart().dataReady(),ticker,{timeout:120000});
  await expect.poll(async()=>{const r=await get(`market-data/composites/${composite.id}/quote`);return r.quote_ready},{timeout:120000}).toBe(true);
  const rows=await frame.evaluate(t=>new Promise((resolve,reject)=>feed.getQuotes([t.toUpperCase()],resolve,reject)),ticker);
  expect(rows[0].s).toBe('ok');expect(rows[0].v.price_type).toBe('sampled_bid');
  expect(rows[0].v.lp).toBeGreaterThan(0);expect(rows[0].v.bid).toBe(rows[0].v.lp);
  expect(rows[0].v.description).toContain('抽样Bid');expect(rows[0].v.description).toContain('UTC');
  expect(rows[0].v.short_name).toBe('EURUSD');expect(rows[0].v.ch).toBeUndefined();expect(rows[0].v.chp).toBeUndefined();
  checks.push('actual licensed native bridge resolves uppercased composite and receives sampled Bid with no invented change');
  await page.screenshot({path:path.join(artifacts,'composite-quotes-native-real.png'),fullPage:true});
  expect(errors).toEqual([]);
  fs.writeFileSync(path.join(artifacts,'composite-quotes-browser-real.json'),JSON.stringify({environment:'Ubuntu isolated market-watch-three-layer',base,checks,quote:rows[0],errors,passed:true},null,2)+'\n');
  console.log(JSON.stringify({passed:true,checks}));
 }finally{
  await page.goto(base+'/market-data');
  if(owned){const row=(await get('advanced-charts/workspaces')).find(r=>r.id===owned.id);
   if(row)await post(`advanced-charts/workspaces/${owned.id}/delete`,{revision:row.revision});}
  await browser.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1});
