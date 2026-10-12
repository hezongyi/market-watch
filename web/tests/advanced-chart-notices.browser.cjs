// Actual bridge message handling and host DOM; no server or product deployment.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../advanced-host');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath(),args:['--no-sandbox']});
 try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://mw-notices.invalid/**',r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:'<iframe src="/host?parent=https://mw-notices.invalid" style="width:100%;height:90vh"></iframe>'});
   if(u.pathname==='/host')return r.fulfill({contentType:'text/html; charset=utf-8',body:'<body><input aria-label="图表搜索"><script src="/chart-notices.js"></script><script src="/bridge.js"></script><script>ready=true; window.noticeCalls=0; window.confirmCalls=0; widget={showNoticeDialog(){noticeCalls++},showConfirmDialog(args){confirmCalls++;window.confirm=args.callback}};</script></body>'});
   return r.fulfill({contentType:'text/javascript; charset=utf-8',body:fs.readFileSync(path.join(root,u.pathname.slice(1)),'utf8')});
  });
  await page.goto('https://mw-notices.invalid/');
  await expect.poll(()=>page.frames().some(f=>f.url().includes('/host?'))).toBe(true);
  const host=page.frames().find(f=>f.url().includes('/host?'));
  await host.waitForFunction(()=>ready);
  assert.equal(await host.locator('input').count(),1,await host.locator('body').innerHTML());
  const send=notices=>page.evaluate(notices=>document.querySelector('iframe').contentWindow.postMessage(
   {channel:'mw-chart-v1',type:'notifications',notices},location.origin),notices);
  await host.getByLabel('图表搜索').focus();
  const faults=[{id:'feed',text:'TypeError: Load failed'},{id:'poll:1',text:'TypeError: Load failed'}];
  await send(faults);await expect(host.locator('.mw-chart-notice')).toHaveCount(1);
  await expect(host.locator('.mw-chart-notice')).toContainText('2 次');
  await expect(host.getByLabel('图表搜索')).toBeFocused();
  await send(faults);await expect(host.locator('.mw-chart-notice')).toContainText('2 次');
  await send([]);await send(faults);await expect(host.locator('.mw-chart-notice')).toContainText('4 次');
  await host.getByRole('button',{name:'关闭图表提示'}).click();
  await send([]);await send(faults);await expect(host.locator('.mw-chart-notice')).toHaveCount(0);
  await send([1,2,3,4].map(i=>({id:'fault'+i,text:'独立故障 '+i})));
  await expect(host.locator('.mw-chart-notice')).toHaveCount(3);
  for(const width of [1440,375]){
   await page.setViewportSize({width,height:900});
   const overflow=await host.locator('.mw-chart-notices').evaluate(n=>{
    const b=n.getBoundingClientRect();return b.left<0||b.right>innerWidth||n.scrollWidth>n.clientWidth;
   });assert.equal(overflow,false);
  }
  await send([{id:'draft',text:'草稿待恢复',recover:true}]);
  await host.waitForFunction(()=>confirmCalls===1);
  assert.equal(await host.evaluate(()=>noticeCalls),0,'ordinary faults must never open native notice dialogs');
  await host.evaluate(()=>confirm(false));
  await send([{id:'draft',text:'草稿待恢复',recover:true}]);
  assert.equal(await host.evaluate(()=>confirmCalls),1,'acknowledged draft stays deduplicated');
  assert.deepEqual(errors,[]);
  // Deterministic expiry check on the same store used by the renderer.
  const verdict=await host.evaluate(()=>{
   let clock=0;const store=chartNoticeStore({now:()=>clock});
   const fault=[{id:'feed',text:'TypeError: Load failed'}];
   store.update(fault);store.dismiss('TypeError: Load failed');store.update([]);
   clock=29999;const suppressed=store.update(fault).length;
   store.update([]);clock=60000;const renewed=store.update(fault);
   return {suppressed,renewed:renewed.length,count:renewed[0].count};
  });assert.deepEqual(verdict,{suppressed:0,renewed:1,count:1});
  console.log('PASS ordinary notice bridge: focus, grouping, recovery deduplication, close, cap, narrow viewport, draft confirmation, expiry');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
