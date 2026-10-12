// Real Chromium per-origin page zoom, with no emulated viewport/DPR override.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const output='docs/verification/pro-charts-20261011/browser-native-zoom.json';
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.05,`${actual} differs from ${expected}`);
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mw-pro-charts-native-zoom-'));
 const extension=path.join(directory,'extension');fs.mkdirSync(extension);
 fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Task-only native page zoom',version:'1.0',permissions:['tabs'],background:{service_worker:'background.js'}}));
 fs.writeFileSync(path.join(extension,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
 const report={environment:'Ubuntu quant-server / mw-pro-charts-20261011',zoom:'Chromium chrome.tabs.setZoom automatic per-origin page zoom; no Emulation overrides',cases:[],errors:[]};
 let context;
 try {
  context=await chromium.launchPersistentContext(path.join(directory,'profile'),{
   executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
   headless:true,viewport:{width:1600,height:1000},args:['--no-sandbox','--disable-extensions-except='+extension,'--load-extension='+extension]
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=context.pages()[0];page.setDefaultTimeout(30000);page.on('pageerror',e=>report.errors.push(e.stack));
  await page.goto('http://localhost:19997/');
  await page.getByLabel('管理员密码').fill(fs.readFileSync('/tmp/mw-pro-charts-20261011/login-password','utf8').trim());
  const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));
  await page.getByRole('button',{name:'登录工作台'}).click();assert.equal((await login).status(),200);
  await page.waitForTimeout(300);await page.goto('http://localhost:19997/advanced-charts');
  await page.locator('iframe[title="专业图表工作区"]').waitFor();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith('http://localhost:19998/?'))).toBe(true);
  const host=page.frames().find(f=>f.url().startsWith('http://localhost:19998/?'));
  await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  const ui=host.childFrames()[0];
  const baseline=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight}));
  for(const theme of ['Dark','Light']) {
   await host.evaluate(t=>widget.changeTheme(t),theme);
   for(const factor of [1,1.25,1.5]) {
    const native=await worker.evaluate(async factor=>{
     const tabs=await chrome.tabs.query({url:'http://localhost:19997/*'});if(tabs.length!==1)throw Error('Expected exactly one task page');
     await chrome.tabs.setZoom(tabs[0].id,factor);
     return {factor:await chrome.tabs.getZoom(tabs[0].id),settings:await chrome.tabs.getZoomSettings(tabs[0].id)};
    },factor);
    assert.equal(native.factor,factor);assert.equal(native.settings.mode,'automatic');assert.equal(native.settings.scope,'per-origin');
    await page.waitForFunction(expected=>Math.abs(devicePixelRatio-expected)<0.001,baseline.dpr*factor);
    const outer=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight}));
    close(outer.dpr,baseline.dpr*factor);assert.ok(Math.abs(outer.width-baseline.width/factor)<=1);
    const alert=ui.getByRole('button',{name:'警报',exact:true});
    await page.keyboard.press('Tab');await alert.focus();
    await expect(alert).toBeFocused();
    if(await alert.getAttribute('aria-pressed')==='true') {
     await page.keyboard.press('Enter');await expect(alert).toHaveAttribute('aria-pressed','false');await alert.focus();
    }
    await page.keyboard.press('Enter');await expect(alert).toHaveAttribute('aria-pressed','true');
    const geometry=await alert.evaluate(n=>{
     const a=n.getBoundingClientRect(),b=n.querySelector('svg').getBoundingClientRect(),s=getComputedStyle(n,'::before');
     return {button:[a.width,a.height],svg:[b.width,b.height],center:[b.x+b.width/2-a.x,b.y+b.height/2-a.y],
      focused:n===document.activeElement,focusVisible:n.matches(':focus-visible'),outline:s.outline,decoration:s.content,dpr:devicePixelRatio};
    });
    geometry.button.forEach(v=>close(v,44));geometry.svg.forEach(v=>close(v,44));geometry.center.forEach(v=>close(v,22));
    close(geometry.dpr,outer.dpr);assert.ok(geometry.focused&&geometry.focusVisible);
    assert.ok(geometry.outline.includes('solid')&&geometry.decoration!=='none');
    await page.keyboard.press('Enter');await expect(alert).toHaveAttribute('aria-pressed','false');
    report.cases.push({name:'native page zoom preserves alert entry size/center and keyboard toggle/focus',theme,factor,native,outer,geometry,passed:true});
   }
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
 }catch(e){report.failure=e.stack;throw e;}
 finally {
  try {if(context)await context.close();}
  finally {fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');fs.rmSync(directory,{recursive:true,force:true});}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
