const {chromium,expect}=require('@playwright/test'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 const old={id:'a'.repeat(64),instrument_id:'MD:old:EURUSD',logical_symbol:'EURUSD',precision:6,asset_class:'forex',aggregation_calendar:'ny17',identity:{source:'dukascopy',channel:'python',environment:'historical',basis:'bid',calendar_version:'old'}};
 const datasets=[old],versions=[{id:'original',dataset_id:old.id,start:0,end:120000,cursor:120000,status:'published',error:null}];
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;let result=[];
  if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:'event: heartbeat\ndata: {}\n\n'});
  if(path==='/api/session')result={csrf:'fixture'};
  if(path==='/api/market-data/datasets'){
   if(req.method()==='POST'){const body=req.postDataJSON();requests.push({path,body});result={...old,...body,id:'b'.repeat(64)};datasets.push(result);}else result=datasets;
  }
  if(path==='/api/market-data/versions')result=versions;
  if(path.endsWith('/aggregation')){const body=req.postDataJSON();requests.push({path,body});const dataset={...old,id:'c'.repeat(64),aggregation_calendar:body.aggregation_calendar};datasets.push(dataset);result={dataset,version:{...versions[0],id:'derived',dataset_id:dataset.id,status:'deriving'}};}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 try{
  await page.goto('http://127.0.0.1:16619/market-data');
  await expect(page.getByRole('heading',{name:'行情来源与历史版本'})).toBeVisible();
  await page.getByText('添加历史品种',{exact:true}).click();
  for(const [asset,calendar] of [['crypto','utc0'],['metal','ny17'],['forex','ny17'],['index','']]){
   await page.getByRole('combobox',{name:/^资产类别/}).selectOption(asset);
   await expect(page.getByRole('combobox',{name:/^聚合日界/})).toHaveValue(calendar);
  }
  await expect(page.getByRole('button',{name:'注册历史品种'})).toBeDisabled();
  await page.getByRole('combobox',{name:/^资产类别/}).selectOption('crypto');
  await page.getByLabel('显示代码',{exact:true}).fill('BTCUSD');
  await page.getByLabel('Dukascopy 品种代码',{exact:true}).fill('BTC/USD');
  await page.getByRole('button',{name:'注册历史品种'}).click();
  await expect(page.getByRole('combobox',{name:/^历史品种/})).toHaveValue('b'.repeat(64));
  await page.getByRole('combobox',{name:/^历史品种/}).selectOption(old.id);
  await page.getByRole('combobox',{name:/^H4 \/ D1 聚合日界/}).selectOption('utc0');
  await page.getByRole('combobox',{name:/^复用已有M1版本/}).selectOption('original');
  await page.getByRole('button',{name:'保存新日界并复用M1'}).click();
  await expect(page.getByRole('combobox',{name:/^历史品种/})).toHaveValue('c'.repeat(64));
  await expect(page.getByRole('combobox',{name:/^H4 \/ D1 聚合日界/})).toHaveValue('utc0');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();expect(errors).toEqual([]);
  const result={host:'Ubuntu local Chromium, built web at 127.0.0.1:16619',scope:'UI fixture API; backend separately verified with actual API/SQLite and isolated PostgreSQL',passed:true,checks:['defaults','index requires choice','registration','select phase','reuse original M1 request','new dataset selected','mobile overflow','page errors'],requests};
  fs.writeFileSync('../artifacts/data-integration/configurable-aggregation-browser.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:result.checks}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
