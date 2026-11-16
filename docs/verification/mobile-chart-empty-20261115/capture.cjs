// Isolated browser profile against Ubuntu acceptance. No user watchlists/settings are changed.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const baseline=process.env.CHART_EMPTY_BEFORE==='1',local=process.env.CHART_EMPTY_LOCAL==='1',out=path.join(__dirname,baseline?'before':local?'local':'after');fs.mkdirSync(out,{recursive:true});
const dist=path.resolve(__dirname,'../../../web/dist');
const fixture=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(['/api/session','/api/login'].includes(url.pathname))return json({subject:'admin',csrf:'fixture'});
  if(url.pathname.endsWith('/preferences'))return json([]);
  if(url.pathname.endsWith('/dataset-summaries'))return json({items:[],total:0,categories:[]});
  if(url.pathname.endsWith('/snapshot'))return json({events:[],cursor:'fixture'});
  if(url.pathname.endsWith('/events'))return json({events:[],before:null});
  if(url.pathname.endsWith('/health'))return json({version:'fixture'});
  res.writeHead(404);return res.end();
 }
 let file=path.join(dist,decodeURIComponent(url.pathname));
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
});
(async()=>{const browser=await chromium.launch();try{
 if(local)await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const base=local?'http://127.0.0.1:'+fixture.address().port:'https://127.0.0.1:18447',context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 const credentials=local?{login_password:'fixture'}:JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await context.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok());
 const page=await context.newPage(),errors=[],blockedWrites=[],layouts=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{if(route.request().method()!=='GET'){blockedWrites.push(new URL(route.request().url()).pathname);return route.abort();}return route.continue();});
 await page.goto(base+'/m/chart');
 await expect(page.getByText('选择要查看的品种',{exact:true})).toBeVisible();
 const capture=async(name)=>{
  await page.waitForTimeout(400);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page overflow');
  await expect(page.locator('.mobile-chart-canvas iframe')).toHaveCount(0);
  const geometry=await page.locator('.chart-idle').evaluate(el=>({width:el.clientWidth,scrollHeight:el.scrollHeight,height:el.clientHeight,buttons:[...el.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height};})}));
  if(!baseline){assert(geometry.buttons.every(b=>b.height>=48),'comfortable touch targets');assert.equal(geometry.buttons.length,2);}
  await page.screenshot({path:path.join(out,name+'.png')});layouts.push({name,...geometry});
 };
 for(const theme of ['light','dark']){
  await page.getByRole('link',{name:'更多',exact:true}).click();
  if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
  await page.getByRole('link',{name:'图表',exact:true}).click();
  for(const width of [375,412])for(const font of [14,21]){
   await page.setViewportSize({width,height:812});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
   await capture(`${theme}-${width}-${font}`);
  }
  if(!baseline){
   for(const size of [{width:375,height:480},{width:812,height:375}]){
    await page.setViewportSize(size);await capture(`${theme}-${size.width}x${size.height}-21`);
    await page.getByRole('button',{name:'前往自选',exact:true}).scrollIntoViewIfNeeded();
    await page.getByRole('button',{name:'查看自建行情',exact:true}).scrollIntoViewIfNeeded();
    assert((await page.getByRole('button',{name:'查看自建行情',exact:true}).boundingBox()).y+48<=(await page.locator('.mobile-nav').boundingBox()).y,'secondary action reachable above navigation');
    await page.locator('.chart-idle').evaluate(el=>el.scrollTop=0);
   }
  }
 }
 if(!baseline){
  await page.setViewportSize({width:375,height:812});await page.evaluate(()=>document.documentElement.style.fontSize='14px');
  await page.getByRole('button',{name:'前往自选',exact:true}).click();await expect(page).toHaveURL(/\/m\/?$/);
  await page.getByRole('link',{name:'图表',exact:true}).click();
  await page.getByRole('button',{name:'查看自建行情',exact:true}).click();await expect(page).toHaveURL(/\/m\/data$/);
  await page.getByRole('link',{name:'图表',exact:true}).click();
  await page.route('**/api/session',route=>route.fulfill({status:503,json:{detail:'fixture unavailable'}}));await page.reload();
  await expect(page.getByRole('heading',{name:'等待连接图表',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'重新连接',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'offline.png')});
 }
 assert.deepEqual(errors,[]);
 const result={host:local?'Built UI with API fixture':'Ubuntu local Docker',baseline,layouts,errors,blockedWrites};fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({passed:true,screenshots:layouts.length+(baseline?0:1),errors,blockedWrites}));
}finally{await browser.close();if(local)await new Promise(resolve=>fixture.close(resolve));}})().catch(e=>{console.error(e);process.exitCode=1;});
