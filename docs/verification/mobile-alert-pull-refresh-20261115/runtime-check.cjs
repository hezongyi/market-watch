// Actual Ubuntu Docker frontend and APIs; only auth creates a session.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const base='https://127.0.0.1:18447',root=__dirname;
fs.mkdirSync(root+'/runtime',{recursive:true});
(async()=>{const browser=await chromium.launch();try{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812},isMobile:true,hasTouch:true});
 const credentials=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await context.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok());
 const page=await context.newPage(),errors=[],writes=[],reads=[],checks=[];
 let gate,release,heldPath;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const req=route.request(),p=new URL(req.url()).pathname;
  if(req.method()!=='GET'){writes.push({method:req.method(),path:p});return route.abort();}
  if(gate&&p===heldPath){reads.push(p);await gate;}
  try{await route.continue();}catch{}
 });
 const touch=await context.newCDPSession(page);
 async function pull(){await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:160,y:180}]});for(const y of [210,240,280,310,345])await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:160,y}]});await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
 const indicator=page.locator('.mobile-alerts .mobile-pull-refresh[data-refreshing]');
 async function refresh(name,p){
  await page.locator('.alert-list-scroll:visible').evaluate(el=>el.scrollTop=0);
  heldPath=p;gate=new Promise(r=>release=r);
  await pull();await expect(indicator).toBeVisible();
  await page.waitForTimeout(200);await page.screenshot({path:root+'/runtime/'+name+'-refreshing.png'});
  release();gate=undefined;await expect(indicator).toHaveCount(0);
  await page.waitForTimeout(200);await page.screenshot({path:root+'/runtime/'+name+'-settled.png'});
  assert(reads.includes(p));checks.push(name+' gesture/refetch/retract');
 }
 await page.goto(base+'/m/alerts');
 await expect(page.locator('.alert-rule').first()).toBeVisible({timeout:30000});
 await refresh('rules','/api/chart-alerts/page');
 await page.getByRole('tab',{name:'事件记录',exact:true}).click();
 await expect(page.locator('.alert-records-content .data-loading')).toHaveCount(0,{timeout:30000});
 await page.waitForTimeout(400);
 await refresh('records','/api/chart-alerts/events/page');
 for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]){
  await page.setViewportSize({width,height:880});await page.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);
  await page.getByRole('link',{name:'更多',exact:true}).click();if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();await page.getByRole('link',{name:/^告警/}).click();
  for(const tab of ['规则','事件记录']){
   await page.getByRole('tab',{name:tab,exact:true}).click();
   await page.waitForTimeout(350);
   const geometry=await page.locator('.alert-list-scroll:visible').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,height:el.clientHeight,bottom:el.getBoundingClientRect().bottom}));
   assert(geometry.height>350&&geometry.scrollWidth<=geometry.width+1);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:root+'/runtime/'+`${tab==='规则'?'rules':'records'}-${width}-${theme}-${font}.png`});
  }
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 const proof={passed:true,host:'Ubuntu local Docker',project:'mw-managed-live-rollover-20261113',readOnly:true,checks,heldReads:reads,screenshots:20,errors,writes};fs.writeFileSync(root+'/runtime-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
