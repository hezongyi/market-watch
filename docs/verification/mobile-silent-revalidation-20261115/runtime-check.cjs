// Real Ubuntu APIs; cache reads are deliberately held in the browser to expose transition frames.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const root=__dirname,base='https://127.0.0.1:18447';fs.mkdirSync(root+'/runtime',{recursive:true});
(async()=>{const browser=await chromium.launch();try{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 const credentials=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await context.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok());
 await context.addInitScript(()=>{window.__cacheHints=[];new MutationObserver(()=>{for(const node of document.querySelectorAll('.data-inline-feedback,.data-feedback,.mobile-watch-status,.mobile-record-tabs [data-slot="tabs-content"] > p,.chart-preview span'))if(/上次读取|当前状态待核实|正在确认.*上次自选|上次数据.*更新中/.test(node.textContent))window.__cacheHints.push(node.textContent);}).observe(document,{subtree:true,childList:true,characterData:true});});
 const page=await context.newPage(),errors=[],writes=[],blockedBackgroundReads=[],screenshots=[],geometry=[];let gate,release,holding=()=>false,held=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url());if(req.method()!=='GET'){const entry={path:url.pathname,method:req.method()};if(['/api/market-data/quotes','/api/market-data/sparklines','/api/market-data/resolve','/api/charts/stream/subscribe'].includes(url.pathname))blockedBackgroundReads.push(entry);else writes.push(entry);return route.abort();}if(gate&&holding(url)){held++;await gate;}return route.continue();});
 const hold=predicate=>{holding=predicate;held=0;gate=new Promise(r=>release=r);};
 const resume=()=>{gate=undefined;release();};
 const dialog=()=>page.getByRole('dialog').last();
 const close=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
 const shot=async name=>{await page.waitForTimeout(350);await page.screenshot({path:root+'/runtime/'+name+'.png'});screenshots.push(name);assert.deepEqual(await page.evaluate(()=>window.__cacheHints),[],'no transient cache messages');};
 const first=()=>page.locator('.data-managed-row').first();
 await page.goto(base+'/m/data');await expect(first()).toBeVisible({timeout:30000});
 await page.getByRole('link',{name:'更多',exact:true}).click();
 hold(url=>url.pathname.endsWith('/dataset-summaries'));
 await page.getByRole('link',{name:'数据',exact:true}).click();await expect(first()).toBeVisible();await expect.poll(()=>held).toBeGreaterThan(0);
 await page.locator('.data-managed-scroll').evaluate(el=>el.scrollTop=0);const y=(await first().boundingBox()).y;
 await expect(page.locator('.data-managed-scroll > .data-inline-feedback')).toHaveCount(0);await shot('data-cache-pending');
 const fresh=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/dataset-summaries'));resume();await fresh;
 await expect.poll(async()=>(await first().boundingBox()).y).toBe(y);geometry.push({page:'data',before:y,after:(await first().boundingBox()).y});await shot('data-cache-fresh');
 // Warm a real dataset detail, then reopen while both detail and live reads are held.
 await first().locator('.data-managed-open').click();await expect(dialog().locator('.data-detail-identity')).toBeVisible();await page.waitForTimeout(700);await close();
 hold(url=>url.pathname.includes('/market-data/datasets/')||url.pathname.includes('/market-data/center/datasets/'));
 await first().locator('.data-managed-open').click();await expect(dialog().locator('.data-detail-identity')).toBeVisible();await expect.poll(()=>held).toBeGreaterThan(0);await expect(dialog().locator('.data-inline-feedback')).toHaveCount(0);await shot('managed-detail-cache-pending');resume();await page.waitForTimeout(500);await close();
 // The watch list remains readable while its preference refresh waits.
 await page.getByRole('link',{name:'自选',exact:true}).click();await expect(page.locator('.mobile-watch-row').first()).toBeVisible({timeout:30000});await page.waitForTimeout(500);
 hold(url=>url.pathname==='/api/advanced-charts/preferences');await page.goto(base+'/m/watch');await expect(page.locator('.mobile-watch-row').first()).toBeVisible();await expect.poll(()=>held).toBeGreaterThan(0);await expect(page.locator('.mobile-watch-status')).toHaveCount(0);await shot('watch-cache-pending');resume();
 await page.getByRole('link',{name:'更多',exact:true}).click();
 for(const tab of ['异常 / 恢复','系统']){
  await page.getByRole('button',{name:/告警记录/}).click();await page.getByRole('tab',{name:tab,exact:true}).click();await page.waitForTimeout(600);await close();
  hold(url=>url.pathname==='/api/notification-center/events'&&url.searchParams.has('audience'));
  await page.getByRole('button',{name:/告警记录/}).click();await page.getByRole('tab',{name:tab,exact:true}).click();await expect.poll(()=>held).toBeGreaterThan(0);await shot(tab==='系统'?'system-cache-pending':'records-cache-pending');resume();await page.waitForTimeout(350);await close();
 }
 await context.setOffline(true);await page.getByRole('link',{name:'数据',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'当前离线'})).toBeVisible();await expect(page.locator('.data-managed-row [role="switch"]').first()).toBeDisabled();await shot('data-offline');await context.setOffline(false);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 const proof={passed:true,host:'Ubuntu local Docker',url:'https://192.168.7.232:18447/m/data',readOnly:true,screenshots,geometry,errors,writes,blockedBackgroundReads};fs.writeFileSync(root+'/runtime-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
