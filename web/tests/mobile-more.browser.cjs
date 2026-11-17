const { auditHeaderIcons } = require('./mobile-header-icons.helper.cjs');
// Built mobile settings with explicit API doubles; no Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),out=process.env.MOBILE_MORE_OUTPUT||'/tmp/mw-mobile-more';
fs.mkdirSync(out,{recursive:true});
let logged=true,healthReads=0,failHealth=false,holdHealth=false,releaseHealth;
let healthResult={version:'fixture-1',ntfy_configured:true,delivery_enabled:true,chart_alerts:{loop:{state:'idle'}}};
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
  return failHealth?json({detail:'健康状态暂时不可用'},503):json(healthResult);
 }
 if(url.pathname==='/api/settings/notification-transport')return json({url:'https://ntfy.example',topic:'fixture-topic',enabled:true,token_configured:false,revision:0,last_test_id:'fixture-test'});
 if(url.pathname==='/api/notification-tests/fixture-test')return json({status:'server_accepted',outbox_status:'accepted',attempts:1,ack_at:null});
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
 const shot=async name=>{await settle();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' document width');const d=dialog();if(await d.count())assert(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),name+' sheet width');assert(await page.locator('.more-time > span').evaluateAll(nodes=>nodes.every(node=>{const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length<=1})),name+' time components remain whole');await auditHeaderIcons(page);await page.screenshot({path:path.join(out,name+'.png')});proof.screenshots.push(name);};
 const close=async()=>{const handle=await dialog().elementHandle();await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect.poll(()=>handle.evaluate(el=>el.isConnected)).toBe(false);};
 const audit=async()=>{const old=await page.evaluate(()=>[...document.querySelectorAll('.mobile-more button,.mobile-more input,.mobile-more select,.mobile-records button,.mobile-records input,.mobile-records select,.mobile-logs button,.mobile-logs input')].filter(el=>el.getClientRects().length&&!el.closest('[aria-hidden="true"]')&&!el.dataset.slot).map(el=>el.outerHTML.slice(0,120)));assert.deepEqual(old,[],'More controls use actual shadcn components');};
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/more');
  await expect(page.getByRole('heading',{name:'我的守望',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'更多',exact:true})).toHaveCount(0);
  await expect(page.locator('#mobile-main > .mobile-title')).toHaveCount(0);
  await expect(page.locator('.mobile-more')).not.toContainText('最近通信');
  await expect(page.getByRole('button',{name:/后台通知/})).toContainText('已启用');
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert(await page.locator('.mobile-profile img').evaluate(el=>el.complete&&el.naturalWidth>0),'actual logo loaded');
  for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
   await page.setViewportSize({width,height:812});if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();await expect(page.locator('.mobile-app')).toHaveAttribute('data-theme',theme);await expect(page.getByRole('button',{name:/显示主题/})).toContainText(theme==='dark'?'深色':'浅色');await page.evaluate(font=>{document.documentElement.style.fontSize=font+'px'},font);
   await shot(`more-${theme}-${width}-${font}`);await audit();
   const rows=await page.locator('.mobile-setting-row').evaluateAll(els=>els.map(el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,separator:getComputedStyle(el).borderBottomWidth,overflow:el.scrollWidth>el.clientWidth+1})));
   assert(rows.every(r=>r.height>=48&&!r.overflow));assert.equal(rows[0].separator,'1px','consecutive settings have a quiet separator');assert.equal(rows[2].separator,'0px','group ends without a boxed edge');proof.layouts.push({theme,width,font,rows});
   if(width===375){for(const [label,name] of [['连接状态','connection'],['后台通知','notifications'],['检查更新','update'],['关于守望','about']]){
    await page.getByRole('button',{name:new RegExp(label)}).click();await shot(`${name}-${theme}-${font}`);await audit();
    if(name==='about'){
     await expect(dialog().getByText('fixture-webview',{exact:true})).toHaveCount(0);
     await dialog().getByRole('button',{name:'运行环境',exact:true}).click();
     await expect(dialog().getByText('fixture-webview',{exact:true})).toBeVisible();await shot(`environment-${theme}-${font}`);
    }
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
  await expect(dialog().getByRole('alert')).toContainText('健康状态暂时不可用');await expect(page.locator('.mobile-toast')).toHaveCount(0);failHealth=false;
  await dialog().getByRole('button',{name:'换服务器',exact:true}).click();await expect(page.getByRole('alertdialog',{name:'切换服务器？',exact:true})).toBeVisible();await shot('switch-server-confirm');
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);await expect(dialog()).toHaveAccessibleName('连接状态');
  assert.equal(requests.filter(r=>r.path==='/api/logout').length,0,'cancel server switch never logs out');
  await close();
  await page.getByRole('button',{name:/检查更新/}).click();
  await expect(dialog().getByRole('alert')).toHaveCount(0);await close();
  await page.getByRole('button',{name:/连接状态/}).click();
  await dialog().getByRole('button',{name:'刷新服务状态',exact:true}).click();
  await expect(dialog().getByRole('alert')).toHaveCount(0);
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
  // Actual UI error collection, persistence, filters, disclosure and safe export.
  await page.reload();await expect(page.getByRole('button',{name:/日志/})).toBeVisible();await expect(page.locator('.mobile-app')).toHaveAttribute('data-theme','dark');
  for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
   if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
   await page.setViewportSize({width,height:812});await page.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);
   await page.getByRole('button',{name:/日志/}).click();await expect(dialog()).toHaveAccessibleName('日志');
   await expect(dialog().locator('.mobile-log-summary').filter({hasText:'健康状态暂时不可用'})).toHaveCount(1);
   await shot(`logs-${theme}-${width}-${font}`);await audit();
   await dialog().getByRole('button',{name:'异常',exact:true}).click();
   await dialog().getByRole('searchbox',{name:'搜索日志'}).fill('健康状态');
   const row=dialog().locator('.mobile-log-row').filter({hasText:'健康状态暂时不可用'});await row.locator('.mobile-log-summary').click();
   await expect(row.getByText('首次 / 最近',{exact:true})).toBeVisible();await shot(`log-detail-${theme}-${width}-${font}`);
   await dialog().getByRole('searchbox',{name:'搜索日志'}).fill('不匹配关键词');await expect(dialog().getByText('没有符合条件的日志',{exact:true})).toBeVisible();
   await dialog().getByRole('searchbox',{name:'搜索日志'}).fill('');await dialog().getByRole('button',{name:'全部',exact:true}).click();
   if(theme==='light'&&width===375&&font===14){
    await page.evaluate(()=>{window.copiedLog='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedLog=text}}});});
    await row.locator('.mobile-log-summary').click();await row.getByRole('button',{name:'复制条目',exact:true}).click();await expect(row.getByRole('button',{name:'已复制',exact:true})).toBeVisible();assert((await page.evaluate(()=>window.copiedLog)).includes('健康状态'));
    const downloadPromise=page.waitForEvent('download');await dialog().getByRole('button',{name:'导出脱敏日志',exact:true}).click();const download=await downloadPromise;
    const data=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert(data.timezone);assert(data.entries.some(r=>r.message.includes('健康状态')));assert(!JSON.stringify(data).includes('test-csrf'));
   }
   await close();
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='14px');await page.setViewportSize({width:375,height:812});
  await page.getByRole('button',{name:/日志/}).click();await dialog().getByRole('button',{name:'查看告警记录',exact:true}).click();await expect(dialog()).toHaveAccessibleName('事件记录');await close();
  assert.equal(requests.filter(r=>r.method==='POST'&&/handled/.test(r.path)).length,0,'reading logs never handles server events');
  // Plain status labels and mapped notification results; no internal status codes leak.
  for(const [configured,enabled,expected] of [[false,false,'未配置'],[true,false,'未启用'],[true,true,'已启用']]){
   healthResult={...healthResult,ntfy_configured:configured,delivery_enabled:enabled,last_notification_test:{status:'notification_test_accepted',at:Date.now()}};
   await page.getByRole('button',{name:/连接状态/}).click();await dialog().getByRole('button',{name:'刷新服务状态',exact:true}).click();await expect(dialog().getByRole('button',{name:'刷新服务状态',exact:true})).toBeEnabled();await close();
   await expect(page.getByRole('button',{name:/后台通知/})).toContainText(expected);
  }
  await page.getByRole('button',{name:/后台通知/}).click();await expect(dialog().getByText('ntfy 已接受 · 等待手机确认',{exact:true})).toBeVisible();await expect(dialog()).not.toContainText('notification_test_');await shot('notification-test-result');await close();
  for(const theme of ['light','dark']){
   if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();
   await page.setViewportSize({width:375,height:480});await page.evaluate(()=>document.documentElement.style.fontSize='21px');
   await page.getByRole('button',{name:/后台通知/}).click();await dialog().getByRole('button',{name:'通知与事件记录',exact:true}).scrollIntoViewIfNeeded();await expect(dialog().getByRole('button',{name:'通知与事件记录',exact:true})).toBeInViewport();await shot(`notifications-short-${theme}`);await close();
   await page.getByRole('button',{name:/关于守望/}).click();await dialog().getByRole('button',{name:'运行环境',exact:true}).click();await dialog().getByText('fixture-webview',{exact:true}).scrollIntoViewIfNeeded();await shot(`environment-short-${theme}`);await close();
  }
  await page.setViewportSize({width:375,height:812});await page.evaluate(()=>document.documentElement.style.fontSize='14px');
  // Bad native bridge responses stay inline and are logged, with no blocking alert.
  let nativeDialogs=0;page.on('dialog',async d=>{nativeDialogs++;await d.dismiss()});
  await page.evaluate(()=>window.MWMobileHost.onmessage({data:JSON.stringify({version:99})}));
  await page.getByRole('button',{name:/检查更新/}).click();await expect(dialog().getByRole('alert')).toContainText('页面协议不兼容');await close();assert.equal(nativeDialogs,0);
  await expect(page.locator('.mobile-toast')).toHaveCount(0);
  await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:/关于守望/}).click();await settle();assert.equal(await dialog().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');await close();
  await context.setOffline(true);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('button',{name:/连接状态/})).toContainText('等待连接');
  await page.getByRole('button',{name:/连接状态/}).click();
  await expect(dialog().getByRole('button',{name:'刷新服务状态',exact:true})).toBeDisabled();
  if(await page.getByRole('button',{name:'关闭通知',exact:true}).count())await expect(page.locator('.mobile-toast')).toHaveCount(0);
  await shot('connection-offline');await close();
  await context.setOffline(false);await page.evaluate(()=>dispatchEvent(new Event('online')));
  await expect(page.getByRole('button',{name:/连接状态/})).not.toContainText('等待连接');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'登录',exact:true})).toBeEnabled();assert.equal(requests.filter(r=>r.path==='/api/logout').length,1);
  assert.deepEqual(errors,[]);
  proof.checks=['compact brand header, unboxed two-group list, no duplicate page header','all More controls use shadcn','technical environment disclosed on demand','connection failures do not leak into update panel','375/412, two themes, 150% text','all four drawers and exit lifecycle','theme toggle','service refresh busy/inline error','server switch cancel and top-layer back','records handoff after exit','record drawers match settings geometry; all record controls migrated; nested back','native update checking/downloading/result','reduced motion','offline connection status and disabled refresh','notification state labels and translated last test','short viewport and large text actions accessible','unfragmented 24h timestamps','logout','logs persist, filter/search/empty, expand/copy/export, eight layouts, records handoff, native bridge inline/no dialog'];
  fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({checks:proof.checks,errors,out}));
 }finally{for(const s of streams)s.end();await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
