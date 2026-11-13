// Built mobile settings with explicit API doubles; no Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),out=process.env.MOBILE_MORE_OUTPUT||'/tmp/mw-mobile-more';
fs.mkdirSync(out,{recursive:true});
let logged=true,healthReads=0,failHealth=false,holdHealth=false,releaseHealth;
const streams=new Set(),errors=[],requests=[];
const record={id:'fixture-record',title:'行情数据连接恢复 · 长标题布局检查',message:'供应商已恢复连接，历史告警记录仍可查阅。',instrument:'EURUSD',severity:'info',occurred_at:Date.now(),handled_at:null};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const c of req)raw+=c;
 const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:req.method});
 if(url.pathname==='/api/session')return logged?json({csrf:'test',subject:'admin'}):json({},401);
 if(url.pathname==='/api/logout'){logged=false;return json({ok:true});}
 if(url.pathname==='/api/health'){
  healthReads++;if(holdHealth)await new Promise(resolve=>releaseHealth=resolve);
  return failHealth?json({detail:'健康状态暂时不可用'},503):json({version:'fixture-1',ntfy_configured:true,delivery_enabled:true,chart_alerts:{loop:{state:'idle'}}});
 }
 if(url.pathname==='/api/advanced-charts/preferences')return json([]);
 if(url.pathname==='/api/notification-center/events')return json({events:url.searchParams.has('audience')?[record]:[],before:null});
 if(url.pathname.endsWith('/timeline'))return json({observations:[]});
 if(url.pathname==='/api/notification-center/snapshot')return json({events:[],cursor:'test'});
 if(url.pathname==='/api/market-data/series/page')return json({items:[],next_offset:null});
 if(url.pathname==='/api/charts/stream/events'){
  streams.add(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');req.on('close',()=>streams.delete(res));return;
 }
 if(url.pathname.startsWith('/api/charts/stream/'))return json({ok:true});
 if(url.pathname.startsWith('/api/'))return json({detail:'Unexpected fixture API '+url.pathname},404);
 let file=path.join(dist,decodeURIComponent(url.pathname));
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
 const proof={screenshots:[],layouts:[],errors,checks:[]};
 page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(()=>{
  window.nativeActions=[];
  window.MWMobileHost={postMessage(raw){const data=JSON.parse(raw);window.nativeActions.push(data.action);if(data.action==='hello')queueMicrotask(()=>window.MWMobileHost.onmessage?.({data:JSON.stringify({version:1,appVersion:'0.1.2',webViewVersion:'fixture-webview',capabilities:['app-update-v1']})}));}};
 });
 const dialog=()=>page.getByRole('dialog').last();
 const settle=async()=>{await page.waitForTimeout(350);await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});};
 const shot=async name=>{await settle();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' document width');const d=dialog();if(await d.count())assert(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),name+' sheet width');await page.screenshot({path:path.join(out,name+'.png')});proof.screenshots.push(name);};
 const close=async()=>{const handle=await dialog().elementHandle();await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect.poll(()=>handle.evaluate(el=>el.isConnected)).toBe(false);};
 const audit=async()=>{const old=await page.evaluate(()=>[...document.querySelectorAll('.mobile-more button,.mobile-more input,.mobile-more select,.mobile-records button,.mobile-records input,.mobile-records select')].filter(el=>el.getClientRects().length&&!el.closest('[aria-hidden="true"]')&&!el.dataset.slot).map(el=>el.outerHTML.slice(0,120)));assert.deepEqual(old,[],'More controls use actual shadcn components');};
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/more');
  await expect(page.getByRole('heading',{name:'我的守望',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'更多',exact:true})).toHaveCount(0);
  await expect(page.locator('#mobile-main > .mobile-title')).toHaveCount(0);
  await expect(page.locator('.mobile-more')).not.toContainText('最近通信');
  await expect(page.getByRole('button',{name:/后台通知/})).toContainText('ntfy 已配置');
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert(await page.locator('.mobile-profile img').evaluate(el=>el.complete&&el.naturalWidth>0),'actual logo loaded');
  for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
   await page.setViewportSize({width,height:812});if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();await expect(page.locator('.mobile-app')).toHaveAttribute('data-theme',theme);await expect(page.getByRole('button',{name:/显示主题/})).toContainText(theme==='dark'?'深色':'浅色');await page.evaluate(font=>{document.documentElement.style.fontSize=font+'px'},font);
   await shot(`more-${theme}-${width}-${font}`);await audit();
   const rows=await page.locator('.mobile-setting-row').evaluateAll(els=>els.map(el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,separator:getComputedStyle(el).borderTopWidth,overflow:el.scrollWidth>el.clientWidth+1})));
   assert(rows.every(r=>r.height>=48&&!r.overflow));assert.equal(rows[2].separator,'1px','consecutive settings have a quiet separator');proof.layouts.push({theme,width,font,rows});
   if(width===375){for(const [label,name] of [['连接状态','connection'],['后台通知','notifications'],['检查更新','update'],['关于守望','about']]){
    await page.getByRole('button',{name:new RegExp(label)}).click();await shot(`${name}-${theme}-${font}`);await audit();
    assert.notEqual(await dialog().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
    await close();
   }}
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize='14px'});await page.setViewportSize({width:375,height:812});
  const themeBefore=await page.locator('.mobile-app').getAttribute('data-theme');
  await page.getByRole('button',{name:/显示主题/}).click();await expect(page.locator('.mobile-app')).not.toHaveAttribute('data-theme',themeBefore);
  await page.getByRole('button',{name:/显示主题/}).click();await expect(page.locator('.mobile-app')).toHaveAttribute('data-theme',themeBefore);
  await page.getByRole('button',{name:/连接状态/}).click();
  holdHealth=true;await dialog().getByRole('button',{name:'刷新服务状态',exact:true}).click();await expect.poll(()=>Boolean(releaseHealth)).toBe(true);
  await expect(dialog().getByRole('button',{name:'正在刷新…',exact:true})).toBeDisabled();holdHealth=false;releaseHealth();
  await expect(dialog().getByRole('button',{name:'刷新服务状态',exact:true})).toBeEnabled();
  failHealth=true;await dialog().getByRole('button',{name:'刷新服务状态',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();await page.getByRole('button',{name:'关闭通知',exact:true}).click();failHealth=false;
  await dialog().getByRole('button',{name:'换服务器',exact:true}).click();await expect(page.getByRole('alertdialog',{name:'切换服务器？',exact:true})).toBeVisible();await shot('switch-server-confirm');
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);await expect(dialog()).toHaveAccessibleName('连接状态');
  assert.equal(requests.filter(r=>r.path==='/api/logout').length,0,'cancel server switch never logs out');
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:/后台通知/}).click();await page.getByRole('button',{name:'通知与事件记录',exact:true}).click();
  await expect(dialog()).toHaveAccessibleName('事件记录');await expect(page.getByRole('dialog',{name:'后台通知',exact:true})).toHaveCount(0);
  proof.recordLayouts=[];
  const metrics=async()=>dialog().evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,title:getComputedStyle(el.querySelector('h2')).fontSize,radius:getComputedStyle(el).borderTopLeftRadius,padding:getComputedStyle(el.querySelector('.mobile-drawer-scroll')).paddingLeft}));
  for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
   // The page is inert while a drawer is open; use the real theme switch between openings.
   await close();if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
   await page.setViewportSize({width,height:812});await page.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);
   await page.getByRole('button',{name:/后台通知/}).click();await settle();const baseline=await metrics();await close();
   await page.getByRole('button',{name:/告警记录/}).click();await shot(`records-${theme}-${width}-${font}`);await audit();const actual=await metrics();
   assert.equal(actual.width,baseline.width);assert.equal(actual.title,baseline.title);assert.equal(actual.radius,baseline.radius);assert.equal(actual.padding,baseline.padding);
   assert(await dialog().evaluate(el=>el.classList.contains('mobile-control-drawer')));assert.equal(await dialog().locator('[data-slot=drawer-swipe-handle]').count(),1);
   proof.recordLayouts.push({theme,width,font,baseline,actual});
   for(const name of ['异常 / 恢复','系统']){
    await page.getByRole('tab',{name,exact:true}).click();await expect(dialog().getByRole('button',{name:/行情数据连接恢复/})).toBeVisible();await audit();const selectedTab=page.getByRole('tab',{name,exact:true});await expect(selectedTab).toHaveAttribute('aria-selected','true');assert.equal(await selectedTab.getAttribute('aria-controls'),await dialog().getByRole('tabpanel').getAttribute('id'));
   }
   if(width===375){await shot(`record-history-${theme}-${font}`);await dialog().getByRole('button',{name:/行情数据连接恢复/}).click();await shot(`record-detail-${theme}-${font}`);await audit();
    const detail=await dialog().elementHandle();await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));await expect.poll(()=>detail.evaluate(el=>el.isConnected)).toBe(false);await expect(dialog()).toHaveAccessibleName('事件记录');
   }
  }
  await close();await page.evaluate(()=>document.documentElement.style.fontSize='14px');await page.setViewportSize({width:375,height:812});
  await page.getByRole('button',{name:/告警记录/}).click();await expect(dialog()).toHaveAccessibleName('事件记录');await close();
  await page.getByRole('button',{name:/检查更新/}).click();await dialog().getByRole('button',{name:'检查更新',exact:true}).click();
  await expect(dialog().getByRole('button',{name:'正在检查…',exact:true})).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>window.nativeActions.filter(x=>x==='check-app-update').length)).toBe(1);
  await page.evaluate(()=>window.MWMobileHost.onmessage({data:JSON.stringify({version:1,appUpdate:{status:'downloading',label:'正在下载更新，25%'}})}));
  await expect(dialog().getByRole('button',{name:'正在下载…',exact:true})).toBeDisabled();await shot('update-downloading');
  await page.evaluate(()=>window.MWMobileHost.onmessage({data:JSON.stringify({version:1,appUpdate:{status:'current',label:'当前已是最新版本'}})}));
  await expect(dialog().getByRole('button',{name:'检查更新',exact:true})).toBeEnabled();await close();
  await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:/关于守望/}).click();await settle();assert.equal(await dialog().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');await close();
  await context.setOffline(true);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('button',{name:/连接状态/})).toContainText('等待连接');
  await page.getByRole('button',{name:/连接状态/}).click();
  await expect(dialog().getByRole('button',{name:'刷新服务状态',exact:true})).toBeDisabled();
  if(await page.getByRole('button',{name:'关闭通知',exact:true}).count())await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await shot('connection-offline');await close();
  await context.setOffline(false);await page.evaluate(()=>dispatchEvent(new Event('online')));
  await expect(page.getByRole('button',{name:/连接状态/})).not.toContainText('等待连接');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'登录',exact:true})).toBeEnabled();assert.equal(requests.filter(r=>r.path==='/api/logout').length,1);
  assert.deepEqual(errors,[]);
  proof.checks=['header removed','all More controls use shadcn','375/412, two themes, 150% text','all four drawers and exit lifecycle','theme toggle','service refresh busy/error toast','server switch cancel and top-layer back','records handoff after exit','record drawers match settings geometry; all record controls migrated; nested back','native update checking/downloading/result','reduced motion','offline connection status and disabled refresh','logout'];
  fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({checks:proof.checks,errors,out}));
 }finally{for(const s of streams)s.end();await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
