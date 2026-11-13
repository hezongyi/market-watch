const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium,expect}=require('/home/quant/repos/market-watch-android-personal-v205/web/node_modules/@playwright/test');
(async()=>{
 const base='https://192.168.7.232:18445';
 const password=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/credentials.json','utf8')).login_password;
 const browser=await chromium.launch({executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'});
 // CA validation is checked separately with Python's task CA. This browser context
 // accepts the dev certificate only for this smoke, and is never device evidence.
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:412,height:915},isMobile:true,hasTouch:true});
 const page=await context.newPage(),checks=[],bars=[],errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',async response=>{if(response.url().endsWith('/api/charts/data')&&response.status()===200){try{const value=await response.json();bars.push((value.bars||[]).length);}catch{}}});
 try{
  await page.goto(base+'/m/');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(2);checks.push('real HTTPS login and CSRF session; task-only D1 favorites');
  await page.locator('.mobile-watch-row').filter({hasText:'D1_BTCUSDT'}).click();
  await expect(page.getByRole('button',{name:'指标',exact:true})).toBeEnabled({timeout:45000});
  await expect.poll(()=>Math.max(0,...bars),{timeout:45000}).toBeGreaterThan(0);
  checks.push('actual licensed native widget shows fixed synthetic D1 bars from task PostgreSQL/API');
  await page.getByRole('button',{name:'指标',exact:true}).click();
  await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith('blob:'))).toBe(true);
  const frame=page.frames().find(frame=>frame.url().startsWith('blob:'));
  await expect(frame.getByRole('dialog').first()).toBeVisible();
  assert.equal(await frame.locator('.mw-indicator-fallback').count(),0);checks.push('real server catalog opens actual native indicator UI without fallback');
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(frame.getByRole('dialog').first()).toBeHidden();
  await page.screenshot({path:'/tmp/mw-android-personal-real-r1.png'});
  await page.getByRole('link',{name:'更多',exact:true}).click();await expect(page).toHaveURL(/\/m\/more$/);
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
  checks.push('real native dialog back, navigation and logout');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({evidence:'Ubuntu isolated HTTPS real API/PostgreSQL and actual pinned library; synthetic D1 only; Chromium dev-certificate override; no Find X8/supplier/ntfy evidence',checks,maxBars:Math.max(...bars),errors},null,2));
 }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
