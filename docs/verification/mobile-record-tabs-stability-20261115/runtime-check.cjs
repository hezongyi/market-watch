// Read-only Ubuntu acceptance check. All browser writes are blocked after login.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const root=__dirname,base='https://127.0.0.1:18447';
(async()=>{const browser=await chromium.launch();try{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 const credentials=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await context.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok());
 const page=await context.newPage(),errors=[],blockedWrites=[],proof=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{if(route.request().method()!=='GET'){blockedWrites.push(new URL(route.request().url()).pathname);return route.abort();}return route.continue();});
 await page.goto(base+'/m/more');
 await page.getByRole('button',{name:/告警记录/}).click();
 const dialog=page.getByRole('dialog',{name:'事件记录',exact:true});
 await expect(dialog).toBeVisible();await page.waitForTimeout(700);
 for(const name of ['异常 / 恢复','系统','触发','异常 / 恢复']){
  await page.evaluate(()=>{window.__frames=[];window.__tracking=true;const tick=()=>{const el=document.querySelector('.mobile-record-tabs [role=tablist]');window.__frames.push(el.getBoundingClientRect().y);if(window.__tracking)requestAnimationFrame(tick);};tick();});
  await dialog.getByRole('tab',{name,exact:true}).click();await page.waitForTimeout(1000);
  const frames=await page.evaluate(()=>{window.__tracking=false;return window.__frames;});
  proof.push({name,span:Math.max(...frames)-Math.min(...frames),frames});
  await page.screenshot({path:path.join(root,'runtime-'+proof.length+'.png')});
 }
 assert(proof.every(row=>row.span<=1));assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(root,'runtime-proof.json'),JSON.stringify({passed:true,host:'Ubuntu local Docker',proof,errors,blockedWrites},null,2));
 console.log(JSON.stringify({passed:true,switches:proof.length,maxVerticalMovement:Math.max(...proof.map(p=>p.span)),errors,blockedWrites}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
