const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
// Opt-in acceptance against the task-owned real instance, with no market mocks.
const base=process.env.MW_BASE,chart=process.env.MW_CHART;
assert(base&&chart&&process.env.MW_OUTPUT&&process.env.MW_CREDENTIALS,'provide private real-instance configuration');
const out=process.env.MW_OUTPUT;fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
 const page=await context.newPage(),errors=[],runs=[];let outer,native,originalTheme,originalSymbol,originalActive,tempId;
 page.on('pageerror',error=>errors.push(error.message));
 const wait=async()=>{
  await outer.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:90000});
  await native.waitForFunction(()=>{
   const rows=[...document.querySelectorAll('[data-test-id-widget-type="watchlist"] [data-symbol-full]')];
   return rows.length>0&&rows.some(row=>row.querySelector('[data-mw-price-digit]'));
  },null,{timeout:90000});
 };
 const capture=async(label)=>{
  await wait();
  const state=await outer.evaluate(()=>({symbol:widget.activeChart().symbol(),
   quotes:[...quoteSnapshotRows].map(([ticker,row])=>({ticker,price:row.v?.lp,previous:row.v?.prev_close_price,
    change:row.v?.ch,percent:row.v?.chp,description:row.v?.description,priceType:row.v?.price_type}))}));
  const ui=await native.evaluate(()=>({dark:document.documentElement.classList.contains('theme-dark'),
   detail:document.querySelector('[data-test-id-widget-type="detail"]')?.innerText,
   rows:[...document.querySelectorAll('[data-test-id-widget-type="watchlist"] [data-symbol-full]')].map(row=>{
    const cell=row.querySelector('[data-mw-price-digit]'),name=row.querySelector('[class*="symbolNameText-"]');
    return {ticker:row.dataset.symbolFull,text:row.innerText,name:name?.innerText,
     raw:cell?.dataset.mwRawPrice,textPrice:cell?.textContent,digit:cell?.dataset.mwPriceDigit,
     aria:cell?.getAttribute('aria-label'),nodeCount:cell?.querySelectorAll('sup').length,
     overlay:cell&&getComputedStyle(cell,'::after').content,
     overlayBackground:cell?.style.getPropertyValue('--mw-digit-background')};
   })}));
  for(const row of ui.rows){
   if(!row.raw)continue; // Upstream unavailable observations stay empty; never invent them.
   assert.equal(row.raw,row.textPrice,'decorative glyph must not alter native price text');
   assert.equal(row.raw,row.aria);assert.equal(row.nodeCount,0);assert(row.raw.match(/[0-9]/));
   assert.equal(row.digit,[...row.raw.matchAll(/[0-9]/g)].at(-1)[0]);
   assert(!/MW[CPH]:|\b[a-f0-9]{32,64}\b/i.test(row.text),'routing identity visible');
  }
  assert(!ui.detail?.includes('平台原生行情'),'old provider wording');
  const composite=state.quotes.find(q=>q.ticker.startsWith('MWC:'));
  if(composite)assert(Number.isFinite(composite.price));
  if(Number.isFinite(composite?.previous))assert(Math.abs(composite.price-composite.previous-composite.change)<1e-10);
  await page.screenshot({path:out+'/'+label+'.png'});
  runs.push({label,state,ui});console.log('Capture '+label+' '+ui.rows.length+' real rows');
 };
 try{
  await page.goto(base);
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(process.env.MW_CREDENTIALS)).login_password);
  const login=page.waitForResponse(r=>r.url().endsWith('/api/login')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'登录工作台'}).click();assert.equal((await login).status(),200);
  await page.goto(base+'/advanced-charts');
  for(let i=0;i<300;i++){
   outer=page.frames().find(frame=>frame.url().startsWith(chart));
   if(outer&&outer.childFrames().length){native=outer.childFrames()[0];break}
   await page.waitForTimeout(100);
  }
  assert(outer&&native);await wait();
  originalTheme=await native.evaluate(()=>document.documentElement.classList.contains('theme-dark')?'Dark':'Light');
  originalSymbol=await outer.evaluate(()=>widget.activeChart().symbol());
  await capture('01-current');
  for(const [symbol,label] of [['MWP:EURUSD','02-eurusd'],['MWP:XAUUSD','03-gold']]){
   await native.locator('[data-test-id-widget-type="watchlist"] [data-symbol-full="'+symbol+'"]').click();
   await native.locator('[data-test-id-widget-type="detail"]').filter({hasText:symbol.split(':').at(-1)}).waitFor();
   await page.waitForTimeout(1000);await capture(label);
  }
  originalActive=await outer.evaluate(async()=>(await widget.watchList()).getActiveListId());
  const catalogResponse=await page.request.get(base+'/api/market-data/series/page',{params:{kind:'provider',source:'binance',page_size:20}});
  assert.equal(catalogResponse.status(),200);
  const catalog=await catalogResponse.json(),sample=catalog.items.find(item=>item.display_symbol==='BTCUSDT')||catalog.items[0];
  assert(sample,'actual Binance catalog sample required');tempId='review-crypto-'+Date.now();
  await outer.evaluate(async({id,ticker})=>{const lists=await widget.watchList();
   lists.saveList({id,title:'审查复验（真实行情）',symbols:[ticker]});lists.setActiveList(id);
  },{id:tempId,ticker:sample.ticker});
  await page.waitForTimeout(1000);await capture('07-live-crypto');
  await outer.evaluate(async original=>{await widget.changeTheme(original==='Dark'?'Light':'Dark')},originalTheme);
  await page.waitForTimeout(1500);
  await native.locator('[data-test-id-widget-type="watchlist"] [data-symbol-full]').first().hover();
  await page.waitForTimeout(300);await capture('04-theme-hover');
  await page.mouse.move(0,0);await page.waitForTimeout(300);
  await capture('05-theme-rest');
 }finally{
  let cleanupError;
  try {
  if(outer&&tempId){
   await outer.evaluate(async({id,active})=>{const lists=await widget.watchList();lists.setActiveList(active);
    await new Promise(resolve=>setTimeout(resolve,0));lists.deleteList(id);
    await new Promise(resolve=>setTimeout(resolve,0));},{id:tempId,active:originalActive});
   let restored=false;
   for(let i=0;i<60;i++){
    const response=await page.request.get(base+'/api/advanced-charts/preferences');
    const values=await response.json(),value=values.find(row=>row.kind==='setting'&&row.name==='mw.watchlists.v1')?.content?.value;
    if(value?.active===originalActive&&!value.lists.some(list=>list.id===tempId)){restored=true;break;}
    await page.waitForTimeout(1000);
   }
   assert(restored,'native list cleanup must persist before closing browser');
  }
  if(outer&&originalTheme)await outer.evaluate(async theme=>{await widget.changeTheme(theme)},originalTheme).catch(()=>{});
  if(native&&originalSymbol){
   const row=native.locator('[data-test-id-widget-type="watchlist"] [data-symbol-full="'+originalSymbol+'"]');
   if(await row.count())await row.click();
   await page.waitForTimeout(2000);await capture('06-restored');
  }
  } catch(error) { cleanupError=error; errors.push('restore: '+error.message); }
  const files=fs.readdirSync(out).filter(file=>file.endsWith('.png')).map(file=>({file,
   sha256:crypto.createHash('sha256').update(fs.readFileSync(out+'/'+file)).digest('hex')}));
  fs.writeFileSync(out+'/evidence.json',JSON.stringify({at:new Date().toISOString(),base,chart,originalTheme,
   originalSymbol,runs,errors,files,market:'Weekend: actual stored supplier observations, no fabricated prices or tick-progress claims'},null,2));
  await browser.close();
  if(cleanupError)throw cleanupError;
 }
 assert.deepEqual(errors,[]);assert.equal(runs.length,7);console.log('PASS real prices, native text, details, theme, hover and restoration');
})().catch(error=>{console.error(error);process.exitCode=1});
