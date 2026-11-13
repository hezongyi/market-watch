// Real built mobile UI, explicit API doubles; no supplier or Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const first='MWP:TEST',second='MWP:SECOND',third='MWP:THIRD';
let remote={kind:'setting',name:'mw.watchlists.v1',tool:'',revision:3,content:{envelope:'keep',value:{active:'a',unknown:'keep',lists:[
  {id:'a',title:'第一组',symbols:[first],unknown:'keep-list'}, {id:'b',title:'第二组',symbols:[second]}
]}}},logged=false,conflict=false;
const writes=[],clients=new Set(),streams=new Set(),errors=[],subscriptions=new Map();let holdSave=false,pendingSave;let maxStreams=0,holdQuotes=false,quoteReads=0,sparkReads=0,unsubscribes=0,quotePrice=123.45;const pendingQuotes=[];
const dist=path.resolve('dist'),controlsOutput='/tmp/mw-watch-controls-regression';
fs.mkdirSync(controlsOutput,{recursive:true});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):{};
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/api/session')return logged?json({csrf:'test',subject:'admin'}):json({},401);
 if(url.pathname==='/api/health')return json({ntfy_configured:false,delivery_enabled:false,chart_alerts:{loop:{state:'idle'}}});
 if(url.pathname==='/api/login'){logged=true;return json({csrf:'test',subject:'admin'});}
 if(url.pathname==='/api/advanced-charts/preferences')return json([remote]);
 if(url.pathname==='/api/advanced-charts/preferences/save'){
  writes.push(body);
  if(holdSave)await new Promise(resolve=>pendingSave=resolve);
  if(conflict||body.revision!==remote.revision)return json({detail:'自选冲突'},409);
  remote={...remote,...body,revision:remote.revision+1};return json(remote);
 }
 if(url.pathname==='/api/market-data/series/page'){
  const query=url.searchParams.get('query');
  if(query==='old')return setTimeout(()=>json({items:[{ticker:first,symbol:'OLD-RESULT'}]}),700);
  return json({items:[{ticker:third,symbol:query==='new'?'NEW-RESULT':'THIRD',description:'真实身份测试 · 原生 · 测试来源'}],next_offset:null});
 }
 if(url.pathname==='/api/market-data/resolve')return json({id:body.instrument,source:'binance',basis:'last',frames:['M1','M5','H1'],precision:2});
 if(url.pathname==='/api/market-data/quotes'){
  quoteReads++;
  const reply=()=>json(body.symbols.map(n=>({n,s:'ok',v:{short_name:n.slice(4),description:'测试名称 · 原生 · 测试来源',lp:quotePrice,chp:1.2,fetch_status:'ok'}})));
  if(holdQuotes){pendingQuotes.push(reply);return;}return reply();
 }
 if(url.pathname==='/api/market-data/sparklines'){
  sparkReads++;
  const left=Math.floor(Date.now()/86400000)*86400000;
  return json({as_of:Date.now(),items:body.items.map(item=>({ticker:item.ticker,revision:null,window_start:left,window_end:left+86400000,timeframe:'M1',
   points:[{time:left,price:'122',gap_before:false},{time:left+60000,price:'123',gap_before:false},{time:left+180000,price:'123.45',gap_before:true}],status:'partial',last_data_at:left+180000}))});
 }
 if(url.pathname==='/api/charts/stream/events'){
  clients.add(url.searchParams.get('client'));streams.add(res);maxStreams=Math.max(maxStreams,streams.size);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');
  res.on('close',()=>streams.delete(res));return;
 }
 if(url.pathname.startsWith('/api/charts/stream/')){
  clients.add(body.client);
  if(url.pathname.endsWith('/subscribe'))subscriptions.set(body.listener,body);
  if(url.pathname.endsWith('/unsubscribe')){unsubscribes++;subscriptions.delete(body.listener);}
  return json({ok:true});
 }
 if(url.pathname.startsWith('/api/'))return json({detail:'Unexpected API '+url.pathname},404);
 let file=path.join(dist,decodeURIComponent(url.pathname));
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json'}[path.extname(file)]||'application/octet-stream'});
 res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true,recordVideo:{dir:controlsOutput+'/video',size:{width:412,height:915}}}),page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/');
  await page.getByLabel('密码',{exact:true}).fill('test');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(2);
  await expect(page.locator('.mobile-watch-price').first()).toContainText('123.45');
  await expect(page.locator('.mobile-sse')).toContainText('已连接');
  await expect(page.locator('.mobile-sse')).toContainText('最近通信');
  await expect.poll(()=>page.locator('.mobile-spark path[stroke]').count()).toBe(4);
  await expect(page.locator('.mobile-watch-row.stale')).toHaveCount(0);
  const navigationStream=[...streams][0],navigationUnsubscribes=unsubscribes,navigationSparks=sparkReads;
  for(const name of ['更多','数据']){
   await page.getByRole('link',{name,exact:true}).click();
   await expect(page.locator('.mobile-watch')).toBeHidden();
   // Give route effects and the intersection observer time to flush.
   await page.waitForTimeout(200);
   assert(streams.has(navigationStream),'navigation must keep the original SSE open');
   assert.equal(unsubscribes,navigationUnsubscribes,'navigation must retain quote subscriptions');
  }
  assert.equal(sparkReads,navigationSparks,'hidden Watch must not refresh its historical curves');
  const subscription=[...subscriptions.values()].find(row=>row.query.instrument==='TEST');
  assert(subscription,'hidden Watch retains its quote listener');
  const beforeLive=await page.locator('.mobile-watch-row').first().locator('.mobile-spark svg').innerHTML(),beforeLiveHistory=sparkReads;
  for(const stream of streams)stream.write('data: '+JSON.stringify({listener:subscription.listener,generation:subscription.generation,sequence:1,type:'quotes',quotes:[{s:'ok',v:{short_name:'TEST',lp:124.56,chp:2.1,fetch_status:'ok',quote_time:Date.now()}}]})+'\n\n');
  await expect(page.locator('.mobile-watch-price').first()).toContainText('124.56');
  await expect.poll(()=>page.locator('.mobile-watch-row').first().locator('.mobile-spark svg').innerHTML(),{timeout:2000,message:'received quote must update the sparkline immediately without waiting for historical refresh'}).not.toBe(beforeLive);
  assert.equal(sparkReads,beforeLiveHistory,'live tail must not trigger historical requests');
  // Simulate Android WebView visibility while another app is in front.
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>streams.size).toBe(0);
  await expect.poll(()=>subscriptions.size).toBe(0);
  const backgroundReads=quoteReads,backgroundSparks=sparkReads;
  await page.waitForTimeout(200);
  assert.equal(quoteReads,backgroundReads,'background Watch must not fetch quotes');
  assert.equal(sparkReads,backgroundSparks,'background Watch must not fetch curves');
  quotePrice=125.67;
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>streams.size).toBe(1);
  await expect.poll(()=>quoteReads).toBeGreaterThan(backgroundReads);
  await expect(page.locator('.mobile-watch-price').first()).toContainText('125.67');
  assert(!streams.has(navigationStream),'foreground resumes with a new transport');
  await page.getByRole('link',{name:'自选',exact:true}).click();
  await expect(page.locator('.mobile-sse')).toContainText('已连接');
  await expect(page.locator('.mobile-watch-row.stale')).toHaveCount(0);
  await expect.poll(()=>sparkReads).toBeGreaterThan(backgroundSparks);
  quotePrice=123.45;
  holdQuotes=true;for(const response of streams)response.end();
  await expect(page.locator('.mobile-watch-row.stale')).toHaveCount(2);
  await expect(page.locator('.mobile-sse')).toContainText('已连接',{timeout:10000});
  await expect.poll(()=>pendingQuotes.length).toBeGreaterThan(0);
  await expect(page.locator('.mobile-watch-row.stale')).toHaveCount(2);
  holdQuotes=false;for(const reply of pendingQuotes.splice(0))reply();
  await expect(page.locator('.mobile-watch-row.stale')).toHaveCount(0);
  for(const width of [375,412]){
   await page.setViewportSize({width,height:915});await page.evaluate(()=>document.documentElement.style.fontSize='150%');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'large watch text overflow');
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='100%');
  await page.screenshot({path:'/tmp/mw-android-personal-v205-watch.png'});
  // Product controls: measure real transitions and touch gestures against the built UI.
  const controlsProof={timings:[],gestures:[],screenshots:[],reducedMotion:false};
  const settle=async()=>page.evaluate(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await Promise.all([...document.querySelectorAll('[data-mobile-overlay]')].flatMap(el=>el.getAnimations({subtree:true}))
      .filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
  });
  const auditControls=async()=>{
    const missed=await page.locator('.mobile-watch').evaluate(root=>[...root.querySelectorAll('button,input,select,textarea')].filter(el=>el.getClientRects().length&&!el.closest('[hidden],[aria-hidden="true"]')&&!el.dataset.slot).map(el=>({tag:el.tagName,text:el.getAttribute('aria-label')||el.textContent.slice(0,40)})));
    assert.deepEqual(missed,[],'all visible Watch controls use shadcn components');
  };
  const captureControl=async name=>{await settle();await auditControls();await page.screenshot({path:controlsOutput+'/'+name+'.png'});controlsProof.screenshots.push(name);};
  const topDialog=()=>page.getByRole('dialog').last();
  const closeControl=async()=>{const element=await topDialog().elementHandle();await topDialog().getByRole('button',{name:'关闭',exact:true}).click();await expect.poll(()=>element.evaluate(el=>el.isConnected)).toBe(false);};
  const touch=await context.newCDPSession(page);
  const dragDrawer=async(distance,delay=22)=>{
    await settle();const dialog=topDialog(),box=await dialog.boundingBox(),x=box.x+box.width/2,y=box.y+10;
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let step=1;step<=8;step++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+distance*step/8}]});await page.waitForTimeout(delay);}
    const moved=await dialog.evaluate(el=>({transform:getComputedStyle(el).transform,top:el.getBoundingClientRect().top,swiping:el.hasAttribute('data-swiping')}));
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    return {distance,start:box.y,...moved};
  };
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.querySelector('.mobile-app').dataset.theme=theme,theme);
    await page.getByRole('button',{name:'自选操作',exact:true}).click();
    await expect(topDialog()).toHaveAccessibleName('自选操作');
    await captureControl('actions-'+theme);
    const duration=await topDialog().evaluate(el=>getComputedStyle(el).transitionDuration);
    assert.notEqual(duration,'0s','drawer has an actual enter transition');controlsProof.timings.push({theme,duration});
    const element=await topDialog().elementHandle();
    await topDialog().getByRole('button',{name:'关闭',exact:true}).click();
    assert(await element.evaluate(el=>el.isConnected&&el.hasAttribute('data-ending-style')),'exit keeps the drawer mounted for animation');
    await expect.poll(()=>element.evaluate(el=>el.isConnected)).toBe(false);
    await page.getByRole('button',{name:'选择自选分组',exact:true}).click();
    await captureControl('groups-'+theme);
    await closeControl();
  }
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();
  const partialDrag=await dragDrawer(34,45);assert(partialDrag.top>partialDrag.start+12,'drawer follows the finger before release');
  await settle();await expect(topDialog()).toHaveAccessibleName('自选分组');controlsProof.gestures.push({...partialDrag,outcome:'returned'});
  const dismissDrag=await dragDrawer(350);await expect(page.getByRole('dialog')).toHaveCount(0);controlsProof.gestures.push({...dismissDrag,outcome:'dismissed'});
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();
  await page.getByRole('button',{name:'新建分组',exact:true}).click();
  await topDialog().getByLabel('分组名称',{exact:true}).fill('保留中的输入');
  const dirtyDrag=await dragDrawer(180);
  await expect(page.getByRole('alertdialog',{name:'放弃本次修改？',exact:true})).toBeVisible();
  await captureControl('discard-confirm');
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(topDialog().getByLabel('分组名称',{exact:true})).toHaveValue('保留中的输入');
  controlsProof.gestures.push({...dirtyDrag,outcome:'unsaved-protected'});
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'新建分组',exact:true})).toHaveCount(0);
  await expect(topDialog()).toHaveAccessibleName('自选分组');await closeControl();
  assert.equal(writes.length,0,'gesture, cancel and discard never persist draft changes');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('button',{name:'自选操作',exact:true}).click();await settle();
  assert.equal(await topDialog().evaluate(el=>getComputedStyle(el).transitionDuration),'0s','reduced motion removes drawer animation');
  await closeControl();controlsProof.reducedMotion=true;await page.emulateMedia({reducedMotion:'no-preference'});
  // Rapid open/close must never leave an invisible modal blocking Watch.
  for(let i=0;i<3;i++){
    await page.getByRole('button',{name:'自选操作',exact:true}).click();
    await closeControl();
    await expect(page.locator('[data-slot=drawer-overlay]')).toHaveCount(0);
  }
  // A smaller viewport approximates the available space while typing; a device keyboard still needs device acceptance.
  await page.setViewportSize({width:375,height:420});
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();
  await page.getByRole('button',{name:'新建分组',exact:true}).click();
  await topDialog().getByLabel('分组名称',{exact:true}).focus();await settle();
  await topDialog().getByRole('button',{name:'保存分组',exact:true}).scrollIntoViewIfNeeded();
  const submitBounds=await topDialog().getByRole('button',{name:'保存分组',exact:true}).boundingBox();
  assert(submitBounds.y>=0&&submitBounds.y+submitBounds.height<=420,'submit remains reachable in reduced viewport');
  await captureControl('compact-form');await closeControl();await closeControl();
  await page.setViewportSize({width:412,height:915});
  await page.getByRole('button',{name:'自选操作',exact:true}).click();
  await page.getByRole('button',{name:'管理自选',exact:true}).click();
  await page.getByRole('tab',{name:'分组',exact:true}).click();
  await settle();
  await page.getByRole('button',{name:'下移分组 第一组',exact:true}).click();
  const reorder=await page.locator('.mobile-manage-group').evaluateAll(rows=>({
    order:rows.map(row=>row.dataset.orderId),
    animations:rows.flatMap(row=>row.getAnimations()).filter(a=>a.effect.getTiming().duration===200).length,
  }));
  assert.deepEqual(reorder.order,['b','a']);assert(reorder.animations>0,'group sort animates rows to their new positions');
  await page.getByRole('button',{name:'删除分组 第二组',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.mobile-manage-group')).toHaveCount(2);
  await page.getByRole('button',{name:'删除分组 第二组',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'删除分组',exact:true}).click();
  await expect(page.getByRole('button',{name:'删除分组 第二组',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'删除分组 未分组',exact:true})).toBeVisible();
  assert.equal(remote.content.value.lists.length,2,'delete only changes draft before save');
  await topDialog().getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(writes.length,0,'discarded reorder and delete must not write server state');
  controlsProof.reorder=reorder;controlsProof.compactViewport=true;controlsProof.rapidClose=true;controlsProof.deleteDiscard=true;
  fs.writeFileSync(controlsOutput+'/controls-proof.json',JSON.stringify(controlsProof,null,2));
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();
  await page.getByRole('radio',{name:'第一组',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(1);assert.equal(writes.length,0,'phone group selection never writes desktop active');
  await page.getByRole('button',{name:'自选操作',exact:true}).click();await page.getByRole('button',{name:'管理自选',exact:true}).click();
  await page.getByRole('tab',{name:'分组',exact:true}).click();
  await page.getByLabel('分组名称',{exact:true}).first().fill('手机修改组名');
  remote.content.value.active='b';remote.revision++;
  holdSave=true;
  await page.getByRole('button',{name:'保存分组',exact:true}).click();
  await expect.poll(()=>Boolean(pendingSave)).toBe(true);
  await expect(topDialog().getByRole('button',{name:'关闭',exact:true})).toBeDisabled();
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(topDialog()).toHaveAccessibleName('管理自选');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  holdSave=false;pendingSave();
  await expect(topDialog().getByRole('button',{name:'关闭',exact:true})).toBeEnabled();
  await expect.poll(()=>writes.length).toBe(1);assert.equal(writes[0].content.value.active,'b');
  assert.equal(writes[0].content.value.unknown,'keep');assert.equal(writes[0].content.envelope,'keep');
  assert.equal(writes[0].content.value.lists[0].unknown,'keep-list');
  conflict=true;
  await page.getByLabel('分组名称',{exact:true}).first().fill('冲突输入保留');
  await page.getByRole('button',{name:'保存分组',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'尚未保存'})).toBeVisible();
  await expect(page.getByLabel('分组名称',{exact:true}).first()).toHaveValue('冲突输入保留');
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(page.getByRole('alertdialog',{name:'放弃本次修改？',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  conflict=false;
  await page.getByRole('button',{name:'自选操作',exact:true}).click();await page.getByRole('button',{name:'搜索并添加品种',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'搜索品种',exact:true}).getByLabel('搜索代码或中文')).toBeVisible();
  const sourceFilters=page.getByRole('group',{name:'搜索来源',exact:true});
  await sourceFilters.getByRole('button',{name:'Yahoo',exact:true}).click();
  await expect(sourceFilters.getByRole('button',{name:'Yahoo',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(sourceFilters.getByRole('button',{name:'全部',exact:true})).toHaveAttribute('aria-pressed','false');
  await sourceFilters.getByRole('button',{name:'全部',exact:true}).click();
  await expect(sourceFilters.getByRole('button',{name:'全部',exact:true})).toHaveAttribute('aria-pressed','true');
  await captureControl('search-controls');
  await page.getByRole('dialog',{name:'搜索品种',exact:true}).getByLabel('搜索代码或中文').fill('old');await page.waitForTimeout(300);
  await page.getByRole('dialog',{name:'搜索品种',exact:true}).getByLabel('搜索代码或中文').fill('new');
  await expect(page.locator('.mobile-search-info').filter({hasText:'NEW-RESULT'})).toBeVisible();await page.waitForTimeout(800);
  await expect(page.locator('.mobile-search-info').filter({hasText:'OLD-RESULT'})).toHaveCount(0);
  await page.locator('.mobile-search-row').filter({hasText:'NEW-RESULT'}).getByRole('button',{name:'详情',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'行情详情',exact:true}).locator('.mobile-chip-list')).toContainText('M1');
  await expect(page.getByRole('dialog',{name:'行情详情',exact:true}).locator('.mobile-chip-list')).toContainText('M5');
  await expect(page.getByRole('dialog',{name:'行情详情',exact:true}).locator('.mobile-chip-list')).toContainText('H1');
  const targetSelect=page.getByRole('combobox',{name:'添加到分组',exact:true});
  await expect(targetSelect).toContainText('手机修改组名');
  await targetSelect.click();
  await expect(page.getByRole('option',{name:'默认自选列表',exact:true})).toBeVisible();
  await auditControls();
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('dialog',{name:'行情详情',exact:true})).toBeVisible();
  await targetSelect.click();
  await page.getByRole('option',{name:'默认自选列表',exact:true}).click();
  await expect(targetSelect).toContainText('默认自选列表');
  await targetSelect.click();
  await page.getByRole('option',{name:'手机修改组名',exact:true}).click();
  await expect(targetSelect).toContainText('手机修改组名');
  await captureControl('details-select');
  await page.getByRole('button',{name:'加入自选',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'行情详情',exact:true}).getByRole('button',{name:'已添加',exact:true})).toBeVisible();
  assert.equal(remote.content.value.active,'b');
  await expect(page.getByRole('alert').filter({hasText:'已加入自选'})).toBeVisible();
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await page.getByRole('dialog',{name:'行情详情',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('dialog',{name:'搜索品种',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'自选操作',exact:true}).click();await page.getByRole('button',{name:'管理自选',exact:true}).click();
  await page.getByRole('button',{name:'下移TEST',exact:true}).click();
  await expect.poll(()=>remote.content.value.lists[0].symbols.join(',')).toBe([third,first].join(','));
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.getByRole('link',{name:'自选',exact:true}).click();
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();await page.getByRole('radio',{name:'全部自选',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(3);
  const clientCountBeforeReload=clients.size;
  remote.content.value.lists[0].symbols.push(...Array.from({length:30},(_,i)=>'MWP:SCROLL'+i));remote.revision++;
  await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-watchlists-changed')));
  await expect(page.locator('.mobile-watch-row')).toHaveCount(33);
  await page.locator('.mobile-watch-list').evaluate(el=>{el.scrollTop=700;});
  await expect.poll(()=>page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('mw-mobile');r.onsuccess=()=>resolve(r.result);});
    return new Promise(resolve=>{const r=db.transaction('records').objectStore('records').get([location.origin,'admin',1,'watch-scroll']);r.onsuccess=()=>{db.close();resolve(r.result?.value?.['']||0);};});
  })).toBe(700);
  await page.reload();await expect(page.locator('.mobile-watch-row')).toHaveCount(33);
  await expect.poll(()=>page.locator('.mobile-watch-list').evaluate(el=>el.scrollTop)).toBe(700);
  assert.equal(clientCountBeforeReload,1,'one application market client');assert.equal(maxStreams,1,'only one SSE channel');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({evidence:'built mobile UI with API doubles',checks:['all visible Watch controls use shadcn slots','source filter selection including all sources','Select change, Android back and visible success notification','drawer enter and exit transitions','touch follows, rebounds and dismisses','dirty swipe and Android back preserve unsaved input','reduced-motion close lifecycle','reorder animation and delete cancel/discard','small viewport form and rapid repeated close','saving blocks back and close','real transport heartbeat status','navigation retains original SSE and receives live quotes','background pauses subscriptions; foreground reconnects and refreshes quotes','hidden Watch pauses historical refresh','SSE drop grays rows until new connection snapshot aligns','scroll restored after reload','visible quote/spark rows and gaps','375/412 at 150% font','phone group selection isolated','latest desktop active and unknown fields retained','409 keeps input','late search discarded','actual supported periods shown','favorite add and shared refresh','one market client/SSE'],errors},null,2));
 }finally{for(const response of streams)response.end();await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
