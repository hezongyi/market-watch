// Real Ubuntu acceptance instance; GET-only after authentication, no configuration writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const root=__dirname,base='https://127.0.0.1:18447';fs.mkdirSync(root+'/runtime',{recursive:true});
(async()=>{const browser=await chromium.launch();try{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812},hasTouch:true,isMobile:true,serviceWorkers:'block'});
 const credentials=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await context.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok(),'authentication');
 const page=await context.newPage(),errors=[],writes=[],blockedBackgroundReads=[],screenshots=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{const req=route.request();if(req.method()==='GET')return route.continue();const entry={method:req.method(),path:new URL(req.url()).pathname};if(['/api/market-data/quotes','/api/market-data/sparklines','/api/market-data/resolve','/api/charts/stream/subscribe'].includes(entry.path))blockedBackgroundReads.push(entry);else writes.push(entry);return route.abort();});
 const dialog=()=>page.getByRole('dialog').last();
 const settle=()=>page.waitForTimeout(400);
 const shot=async name=>{await settle();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'document width');if(await dialog().count())assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1),'drawer width');await page.screenshot({path:root+'/runtime/'+name+'.png'});screenshots.push(name);};
 const close=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
 await page.goto(base+'/m/more');await expect(page.getByRole('heading',{name:'我的守望',exact:true})).toBeVisible();
 for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
  await page.setViewportSize({width,height:812});if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();await expect(page.getByRole('button',{name:/显示主题/})).toHaveAttribute('aria-pressed',String(theme==='dark'));
  await page.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);await shot(`more-${theme}-${width}-${font}`);
  if(width===375)for(const [label,key] of [['连接状态','connection'],['后台通知','notifications'],['检查更新','update'],['关于守望','about'],['日志','logs']]){
   await page.getByRole('button',{name:new RegExp(label)}).click();await shot(`${key}-${theme}-${font}`);
   if(key==='about'){await dialog().getByRole('button',{name:'运行环境',exact:true}).click();await expect(dialog().getByText('浏览器',{exact:true})).toBeVisible();await shot(`environment-${theme}-${font}`);}
   await close();
  }
 }
 await page.setViewportSize({width:375,height:480});await page.getByRole('button',{name:/关于守望/}).click();await dialog().getByRole('button',{name:'运行环境',exact:true}).click();await dialog().getByText('浏览器',{exact:true}).scrollIntoViewIfNeeded();await shot('browser-environment-short');await close();
 await page.evaluate(()=>document.documentElement.style.fontSize='14px');await page.setViewportSize({width:375,height:812});
 for(const [route,heading] of [['data','数据'],['alerts','告警']]){await page.getByRole('link',{name:heading,exact:true}).click();await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();await shot('comparison-'+route);}
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 fs.writeFileSync(root+'/runtime-proof.json',JSON.stringify({passed:true,host:'Ubuntu local Docker',url:'https://192.168.7.232:18447/m/more',readOnly:true,screenshots,errors,writes,blockedBackgroundReads},null,2));console.log(JSON.stringify({passed:true,screenshots:screenshots.length,errors,writes}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
