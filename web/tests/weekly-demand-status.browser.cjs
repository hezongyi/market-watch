const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.MARKET_WATCH_TEST_URL||'http://127.0.0.1:5190';
 await page.goto(base);
 await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../..//market-watch/artifacts/local-credentials.json')).password);
 const login=page.waitForResponse(r=>r.url().endsWith('/api/login')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'登录工作台'}).click();
 assert.equal((await login).status(),200);
 await page.goto(base+'/replay');
 const section=page.locator('section').filter({has:page.getByRole('heading',{name:'周线后台需求'})});
 await section.waitFor();
 assert.match(await section.innerText(),/EURUSD/);
 assert.match(await section.innerText(),/已完成/);
 await section.screenshot({path:'/tmp/mw-weekly-status-real.png'});
 // Empty-history status fixture changes only this HTTP response, never the DB.
 await page.route('**/api/imports-summary',async route=>{
  const response=await route.fetch(),body=await response.json();
  body.weekly_requests=[{id:'review-fixture',instrument_id:'EURUSD',before:1790622000000,cursor:1790622000000,remaining:13,status:'needs_review'}];
  await route.fulfill({response,json:body});
 });
 await page.reload();
 await section.waitFor();
 assert.match(await section.innerText(),/待核查/);
 assert.match(await section.innerText(),/尚需 13 根周线/);
 assert.match(await section.innerText(),/尚未确认历史起点/);
 await section.screenshot({path:'/tmp/mw-weekly-status-review.png'});
 assert.deepEqual(errors,[]);
 console.log('Real completed demand and injected review demand render with zero page errors');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
