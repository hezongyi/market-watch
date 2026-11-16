// Read-only server comparison. Fresh isolated browser profiles, no user writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
(async()=>{const browser=await chromium.launch();try{
 const proof=[];
 for(const [port,project] of [[18446,'mw-mobile-data-workflow-20261113'],[18447,'mw-managed-live-rollover-20261113']].filter(([port])=>!process.env.SERVER_CHECK_PORT||port===Number(process.env.SERVER_CHECK_PORT))){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:process.env.SERVER_CHECK_SW==='1'?'allow':'block'}),base=`https://127.0.0.1:${port}`;
  const creds=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/'+project+'/credentials.json'));
  assert((await context.request.post(base+'/api/login',{data:{password:creds.login_password}})).ok());
  await context.addInitScript(()=>{
   window.__hints=[];new MutationObserver(()=>{for(const node of document.querySelectorAll('.data-inline-feedback,.data-feedback'))if(/上次读取|上次更新|当前状态待核实/.test(node.textContent))window.__hints.push(node.textContent);}).observe(document,{subtree:true,childList:true,characterData:true});
  });
  const page=await context.newPage();let hold=false,release;const gate=new Promise(r=>release=r);
  await page.route('**/api/**',async route=>{if(route.request().method()!=='GET')return route.abort();if(hold&&new URL(route.request().url()).pathname.endsWith('/dataset-summaries'))await gate;return route.continue();});
  await page.goto(base+'/m/data');await expect(page.locator('.data-managed-row').first()).toBeVisible({timeout:30000});await page.waitForTimeout(700);
  // Leave this origin and return, as the native server picker does.
  await page.goto('https://127.0.0.1:'+(port===18446?18447:18446)+'/m/more');
  hold=true;await page.goto(base+'/m/data');await expect(page.locator('.data-managed-row').first()).toBeVisible();await page.waitForTimeout(500);
  const pending=await page.locator('.data-managed-row').first().evaluate(el=>el.getBoundingClientRect().y);
  await page.screenshot({path:path.join(__dirname,port+'-cached.png')});
  hold=false;release();await page.waitForTimeout(1300);
  const fresh=await page.locator('.data-managed-row').first().evaluate(el=>el.getBoundingClientRect().y),hints=await page.evaluate(()=>window.__hints);
  await page.screenshot({path:path.join(__dirname,port+'-fresh.png')});
  const manifest=await context.request.get(base+'/m/shell-manifest.json').then(r=>r.json());proof.push({port,shellVersion:manifest.version,pendingY:pending,freshY:fresh,movement:fresh-pending,hints:[...new Set(hints)]});await context.close();
 }
 fs.writeFileSync(path.join(__dirname,process.env.SERVER_CHECK_SW==='1'?'sw-proof.json':'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
 assert(proof.every(row=>row.hints.length===0),'switching servers must not insert transient cache notices');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
