// Run in a logged-in Playwriter session: playwriter -s ID --timeout 90000 -f FILE
// state.page supplies the current isolated acceptance URL. No storage is cleared.
const assert = require('assert').strict;
const fs = require('node:fs');
const target = new URL(state.notificationStartupURL || state.page.url());
target.search = '?panel=notifications';
const page = state.startupPage || (state.startupPage = await context.newPage());
await page.setViewportSize({width:1600,height:1000});
const evidence = state.refreshEvidence;
const results = { cases: [], errors: [] };
const onError = error => results.errors.push(error.message);
page.on('pageerror', onError);
if(!state.startupProbeInstalled) await page.addInitScript(() => {
  if (window.top !== window) return;
  window.__startupUi = [];
  window.__startupMessages = [];
  let previous = '';
  const sample = () => {
    const old = !!document.querySelector('.nc-fallback-entry,.nc-fallback,.nc-popup,.nc-bubble');
    const recovery = !!document.querySelector('.advanced-shell-recovery');
    const frame = document.querySelector('iframe[data-workspace-id]');
    const r = frame?.getBoundingClientRect();
    const key = [old,recovery,!!frame].join(':');
    if (key === previous) return;
    previous = key;
    window.__startupUi.push({ ms: Math.round(performance.now()), old, recovery, frame: !!frame,
      bounds: r && { x:r.x,y:r.y,width:r.width,height:r.height } });
  };
  new MutationObserver(sample).observe(document,{subtree:true,childList:true});
  window.addEventListener('message',event=>{
    if (event.source !== document.querySelector('iframe[data-workspace-id]')?.contentWindow) return;
    if (['notice-center-ready','notice-center-unavailable'].includes(event.data?.type))
      window.__startupMessages.push({ ms:Math.round(performance.now()), type:event.data.type });
  });
});
state.startupProbeInstalled=true;
const read = () => page.evaluate(() => ({ transitions:window.__startupUi, messages:window.__startupMessages }));
const assertNoOld = value => assert(!value.transitions.some(x=>x.old),'Retired notification UI must never mount, including during startup or failure');
async function ready(name, query = true, reload = false) {
  const url = new URL(target); if (!query) url.search = '';
  if (reload) await page.reload({waitUntil:'domcontentloaded'});
  else await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__startupMessages?.some(x=>x.type==='notice-center-ready'),null,{timeout:25000});
  const value = await read(); assertNoOld(value);
  const native = page.frameLocator('iframe[data-workspace-id]').frameLocator('iframe');
  await native.locator('.nc-system-entry').waitFor({state:'visible',timeout:10000});
  if(query) {
    await native.locator('.nc-native-panel').waitFor({state:'visible',timeout:10000});
    await native.locator('.nc-list .nc-row').first().waitFor({state:'visible',timeout:10000});
    assert.equal(await native.locator('.nc-search input').count(),0, 'Search stays collapsed on startup');
  }
  assert(!value.transitions.some(x=>x.recovery),'Healthy startup must not show recovery controls');
  results.cases.push({name,...value});
}
try {
  await ready('normal deep link');
  if(evidence) await page.screenshot({path:evidence+'/02-native-only.png',scale:'css'});
  await ready('reload deep link',true,true);
  await ready('normal chart without panel',false);
  const hostDocument = request => request.isNavigationRequest() && request.frame().parentFrame()===page.mainFrame();
  const hostPattern = /^https:\/\/[^/]+:\d+\/\?parent=/;
  const delayed = async route => {
    if(hostDocument(route.request()))await new Promise(resolve=>setTimeout(resolve,6000));
    await route.continue();
  };
  await page.route(hostPattern,delayed);
  try {
    await ready('chart host delayed 6 seconds');
  } finally { await page.unroute(hostPattern,delayed); }
  const blocked = async route => hostDocument(route.request()) ? route.abort('failed') : route.continue();
  await page.route(hostPattern,blocked);
  try {
    await page.goto(target.href,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'重新加载图表',exact:true}).waitFor({state:'visible',timeout:30000});
    const value = await read(); assertNoOld(value);
    assert(value.transitions.some(x=>x.recovery&&x.ms>=25000),'Timeout must keep a reload action, without reopening retired UI');
    assert.equal(await page.locator('.advanced-shell-recovery button').count(),1);
    if(evidence)await page.screenshot({path:evidence+'/03-timeout-reload-only.png',scale:'css'});
    results.cases.push({name:'blocked chart reaches existing 25 second timeout',...value});
  } finally { await page.unroute(hostPattern,blocked); }
  await page.getByRole('button',{name:'重新加载图表',exact:true}).click();
  await page.waitForFunction(()=>window.__startupMessages?.some(x=>x.type==='notice-center-ready'),null,{timeout:25000});
  const recovered=await read();assertNoOld(recovered);
  assert.equal(await page.locator('.advanced-shell-recovery').count(),0);
  results.cases.push({name:'reload action restores native center',...recovered});
  const surfacePattern = /\/host\.[a-f0-9]+\.js$/;
  const unavailable = async route => {
    const response=await page.request.get(route.request().url(),{ignoreHTTPSErrors:true});
    const code=await response.text();
    const marker='async function nativeNotificationSurface(widget, report) {';
    assert(code.includes(marker),'Exercise the served native adapter in the combined host bundle');
    const headers={...response.headers(),'cache-control':'no-store'};
    for(const key of ['etag','last-modified','content-length']) delete headers[key];
    await route.fulfill({response,headers,body:code.replace(marker,marker+'\nthrow Error("Acceptance: native notification adapter unavailable");')});
  };
  await page.route(surfacePattern,unavailable);
  try {
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'重新加载图表',exact:true}).waitFor({state:'visible',timeout:20000});
    const value=await read();assertNoOld(value);
    assert(value.messages.some(x=>x.type==='notice-center-unavailable'),'Exercise actual native attach failure');
    assert(value.transitions.some(x=>x.recovery&&x.ms<25000),'Explicit failure shows reload promptly');
    results.cases.push({name:'explicit native attach failure',...value});
  } finally { await page.unroute(surfacePattern,unavailable); }
  await ready('native center restored after failure');
  assert.deepEqual(results.errors,[]);
  results.passed=true;
} finally {
  page.off('pageerror',onError);
  if(evidence) fs.writeFileSync(evidence+'/startup-results.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
}
