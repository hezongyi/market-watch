const {root, configuration, fixtureServer, nativePage, application, chromium, expect, fs, path} = require('./swing-notice-support.cjs');
const assert = require('node:assert/strict');
(async()=>{
 const config=configuration(),server=await fixtureServer(),browser=await chromium.launch({args:['--no-sandbox']});
 const result={source:'real licensed native Surface + production React adapter; synthetic in-memory transport; Docker native application smoke',cases:[],samples:[],passed:false};
 const record=name=>{result.cases.push(name);console.log('PASS',name)};
 try{
  const page=await nativePage(browser,server.url+'/fixture.html');
  const setup=async()=>{
   globalThis.actions=[];globalThis.queue=[];
   globalThis.noticeState={epoch:'test',revision:1,events:[],pending:[],unread:0,status:'',gap:'',enabled:true,unlocked:true,soundLimited:false,soundStatus:'',systemPopups:true,systemPopupSeconds:3,bubble:null,overflow:0,alertPending:0,serverTime:Date.now()};
   globalThis.notice=(id,trading=false,message='本地合成通知，用于定位与动效验收')=>({id,version:1,first_seq:1,source_domain:'test',source_kind:trading?'chart_alert':'workspace',source_id:id,incident_id:id,kind:'fault',severity:'warning',title:'通知 '+id,message,occurred_at:Date.now(),recorded_at:Date.now(),viewed_at:null,handled_at:null,attention:true,backfill:false,workspace:'test',instrument:'XAUUSD',context:{},evidence:{}});
   globalThis.show=row=>{noticeState={...noticeState,bubble:row,revision:noticeState.revision+1};notifications.update(noticeState)};
   globalThis.notifications=await MWNativeNotifications.attach({widget,scope:{workspace_id:'test',session:'test',epoch:1},state:noticeState,
    request:async action=>{actions.push({...action,time:performance.now()});if(action.action==='dismiss')show(null);if(action.action==='confirm-alert')show(queue.shift()||null);return {events:[],before:null,unread:0,server_time:Date.now()};},report:e=>{throw e},locate:()=>{},alert:()=>{},panelChanged:()=>{}});
   globalThis.surfaceProbe=await nativeNotificationSurface(widget,console.error);
   globalThis.trace=[];globalThis.tracing=true;
   const doc=surfaceProbe.document;
   globalThis.probeFrames=[];
   doc.addEventListener('animationstart',event=>{
    const node=event.target;if(!node.matches?.('.nc-native-instant'))return;
    const animation=node.getAnimations().find(a=>a.animationName===event.animationName);if(!animation)return;
    const original=animation.currentTime,duration=animation.effect.getTiming().duration;
    animation.pause();
    for(const fraction of [.2,.5,.8]){animation.currentTime=duration*fraction;const style=doc.defaultView.getComputedStyle(node),r=node.getBoundingClientRect();probeFrames.push({name:event.animationName,fraction,y:r.y,translate:style.translate,opacity:+style.opacity,clip:style.clipPath,inert:!!node.querySelector('[inert]')});}
    animation.currentTime=original;animation.play();
   });
   function sample(){if(!tracing)return;const n=doc.querySelector('.nc-native-instant'),phase=n?.querySelector('[data-notice-phase]')?.dataset.noticePhase;
    if(n){const s=doc.defaultView.getComputedStyle(n),r=n.getBoundingClientRect();trace.push({t:performance.now(),phase,y:r.y,bottom:r.bottom,translate:s.translate,opacity:+s.opacity,animation:s.animationName,clip:s.clipPath,inert:!!n.querySelector('[inert]')});}doc.defaultView.requestAnimationFrame(sample)}sample();
  };
  await page.evaluate(setup);
  const native=()=>page.frames().find(f=>f.url().startsWith('blob:'));
  const shown=()=>expect(native().locator('[data-notice-phase="shown"]')).toBeVisible();
  const hide=async()=>{await page.evaluate(()=>show(null));await expect(native().locator('.nc-native-instant')).toHaveCount(0)};
  const geometry=()=>page.evaluate(()=>{const n=surfaceProbe.document.querySelector('.nc-native-instant'),r=n.getBoundingClientRect(),s=surfaceProbe.document.defaultView.getComputedStyle(n);return {rect:r.toJSON(),bounds:surfaceProbe.overlayBounds(),style:{top:s.top,bottom:s.bottom,right:s.right,left:s.left,transform:s.transform},canvas:Array.from(surfaceProbe.document.querySelectorAll('canvas')).map(x=>[x.width,x.height])}});
  const beforeCanvas=await page.evaluate(()=>Array.from(surfaceProbe.document.querySelectorAll('canvas')).map(n=>[n.width,n.height]));
  await page.evaluate(()=>show(notice('system-1',true)));await shown();
  await page.waitForTimeout(60);
  let samples=await page.evaluate(()=>trace);const enter=await page.evaluate(()=>probeFrames.filter(x=>x.name==='nc-notice-in'));
  result.initialTrace=samples;assert.ok(enter.length>=2,'actual enter intermediate frames');assert.ok(enter[0].y>enter.at(-1).y,'enters upward');assert.ok(enter[0].opacity<enter.at(-1).opacity,'entry fades in');assert.ok(enter.every(x=>x.clip==='none'));
  const rendered=await page.evaluate(()=>actions.find(x=>x.action==='rendered').time);
  assert.ok(rendered>=samples.find(x=>x.phase==='enter').t,'rendered/timer start only after entry');
  await page.evaluate(()=>{show({...noticeState.bubble,message:'同一事件更新'});});await page.waitForTimeout(70);
  assert.equal(await native().locator('[data-notice-phase]').getAttribute('data-notice-phase'),'shown');
  record('entry upward, opacity, unclipped shadow, rendered after entry, same-id update does not replay');
  const initial=await geometry();assert.deepEqual(initial.canvas,beforeCanvas,'overlay must not resize any chart canvas');result.canvasUnchanged=true;
  for(const [theme,width,height] of [['Dark',1440,900],['Light',1024,700],['Light',375,620],['Dark',375,320]]){
   await page.evaluate(t=>widget.changeTheme(t),theme);await page.setViewportSize({width,height});await page.waitForTimeout(350);
   const g=await geometry(),area=width<480?{left:0,top:0,right:width,bottom:height}:g.bounds.chartBounds,inset=width<480?12:16;
   assert.ok(Math.abs(g.rect.right-(area.right-inset))<=1);assert.ok(Math.abs(g.rect.bottom-(area.bottom-inset))<=1);
   assert.ok(g.rect.width<=355&&g.rect.left>=0&&g.rect.top>=area.top);
   assert.equal(g.style.transform,'none');result.samples.push({theme,width,height,...g});
   await page.screenshot({path:path.join(config.output,`notice-${theme}-${width}-${height}.png`)});
  }
  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(250);
  for(let i=0;i<2;i++){
   await page.evaluate(async()=>{const api=await widget.widgetbar(),bar=api._widgetbar;bar.layout.onTabClick(bar.layout.getActivePage())});await page.waitForTimeout(350);
   const g=await geometry();assert.ok(Math.abs(g.rect.right-(g.bounds.chartBounds.right-16))<=1);result.samples.push({sidebarToggle:i,...g});
  }
  // Exercise the pinned center area's real layout boundary as bottom tools resize.
  await page.evaluate(()=>{const center=surfaceProbe.document.querySelector('.layout__area--center');globalThis.centerBefore=center.style.cssText;center.style.height='500px';});await page.waitForTimeout(250);
  const bottom=await geometry();assert.ok(Math.abs(bottom.rect.bottom-(bottom.bounds.chartBounds.bottom-16))<=1);
  await page.evaluate(()=>{surfaceProbe.document.querySelector('.layout__area--center').style.cssText=centerBefore});
  record('desktop, sidebar, bottom layout boundary, resize, 375px, low viewport and both themes');
  await hide();await page.evaluate(()=>show(notice('long-alert',true,'长内容用于滚动验证。'.repeat(300))));await shown();
  await page.setViewportSize({width:375,height:320});await page.waitForTimeout(250);
  const content=native().locator('.nc-native-instant-content');
  const overlap=await page.evaluate(()=>{const doc=surfaceProbe.document,card=doc.querySelector('.mw-swing-card'),notice=doc.querySelector('.nc-native-instant');const r=card.getBoundingClientRect(),n=notice.getBoundingClientRect(),x=Math.max(r.left,n.left)+3,y=Math.max(r.top,n.top)+3;return {sameDocument:card.ownerDocument===notice.ownerDocument,covered:!!doc.elementFromPoint(x,y)?.closest('.nc-native-instant')};});
  assert.deepEqual(overlap,{sameDocument:true,covered:true},'native notice covers Swing card in narrow layout');
  const scroll=await content.evaluate(n=>({client:n.clientHeight,scroll:n.scrollHeight}));assert.ok(scroll.scroll>scroll.client);
  await native().getByRole('button',{name:'确定',exact:true}).scrollIntoViewIfNeeded();
  const confirmBox=await native().getByRole('button',{name:'确定',exact:true}).boundingBox();assert.ok(confirmBox.y>=0&&confirmBox.y+confirmBox.height<=320);
  await native().getByRole('button',{name:'查看图表',exact:true}).scrollIntoViewIfNeeded();
  const locateBox=await native().getByRole('button',{name:'查看图表',exact:true}).boundingBox();assert.ok(locateBox.y>=0&&locateBox.y+locateBox.height<=320);
  await page.screenshot({path:path.join(config.output,'notice-long-scroll.png')});
  await native().getByRole('button',{name:'确定',exact:true}).click();await expect(native().locator('.nc-native-instant')).toHaveCount(0);
  await page.evaluate(()=>show(notice('long-system',false,'长内容用于系统消息操作验证。'.repeat(300))));await shown();
  for(const label of ['关闭即时通知']){
   const button=native().getByRole('button',{name:label,exact:true});await button.scrollIntoViewIfNeeded();
   const box=await button.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=375&&box.y+box.height<=320,label+' remains reachable');
  }
  await native().getByRole('button',{name:'关闭即时通知',exact:true}).click();await expect(native().locator('.nc-native-instant')).toHaveCount(0);
  record('long content scroll with reachable confirmation in 375×320 viewport');
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>{trace=[];show(notice('first-alert',true));});await shown();
  await page.waitForTimeout(3300);assert.ok(await native().locator('.nc-native-instant').isVisible(),'unconfirmed trading alert remains');
  await page.evaluate(()=>{queue.push(notice('second-alert',true));noticeState={...noticeState,alertPending:2};notifications.update(noticeState)});
  await expect(native().locator('.nc-pending')).toHaveText(/另有 1 条/);
  await native().getByRole('button',{name:'确定',exact:true}).click();await expect(native().locator('h3')).toHaveText('通知 second-alert');await shown();
  samples=await page.evaluate(()=>trace);const exit=await page.evaluate(()=>probeFrames.filter(x=>x.name==='nc-notice-out').slice(-3));assert.ok(exit.length>=2);assert.ok(exit.at(-1).y>exit[0].y,'exit downward');assert.ok(exit[0].opacity>exit.at(-1).opacity,'exit fades out');assert.ok(exit.every(x=>x.inert));
  assert.equal(await page.evaluate(()=>actions.filter(x=>x.action==='confirm-alert').length),2,'only explicit clicks confirm');
  result.animation=samples;result.controlledAnimationFrames=await page.evaluate(()=>probeFrames);record('unconfirmed alert persists, new alert queues, explicit confirmation, exit downward and inert before next entry');
  await hide();await page.evaluate(()=>show(notice('pause-system')));await shown();
  await native().locator('.nc-bubble').hover();await page.waitForTimeout(3200);assert.ok(await native().locator('.nc-native-instant').isVisible());
  await native().getByRole('button',{name:'关闭即时通知'}).focus();await page.mouse.move(5,5);await page.waitForTimeout(3200);assert.ok(await native().locator('.nc-native-instant').isVisible());
  await native().getByRole('button',{name:'关闭即时通知'}).evaluate(n=>n.blur());
  await expect(native().locator('.nc-native-instant')).toHaveCount(0,{timeout:5000});
  record('system timer pauses on hover/focus and resumes after focus leaves');
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{trace=[];show(notice('reduced',true));});await shown();
  assert.equal(await native().locator('.nc-native-instant').evaluate(n=>getComputedStyle(n).animationName),'none');await hide();
  record('reduced motion skips animation and phase delay');
  result.animationSamples=result.animation.length;await page.evaluate(()=>{tracing=false;notifications.destroy();surfaceProbe.destroy()});await page.close();
  const app=await application(browser,config);
  const served=await app.page.request.get(config.chart+'/native-notification-surface.js');assert.equal(await served.text(),fs.readFileSync(path.join(root,'advanced-host/native-notification-surface.js'),'utf8'));
  await app.host.evaluate(setup);
  await app.host.evaluate(()=>show(notice('deployed-surface-check',true)));
  await expect(app.native().locator('[data-notice-phase="shown"]')).toBeVisible({timeout:30000});
  result.deployedGeometry=await app.host.evaluate(()=>{const r=surfaceProbe.document.querySelector('.nc-native-instant').getBoundingClientRect();return {rect:r.toJSON(),bounds:surfaceProbe.overlayBounds()};});
  assert.ok(Math.abs(result.deployedGeometry.rect.right-(result.deployedGeometry.bounds.chartBounds.right-16))<=1);
  assert.ok(Math.abs(result.deployedGeometry.rect.bottom-(result.deployedGeometry.bounds.chartBounds.bottom-16))<=1);
  await app.page.screenshot({path:path.join(config.output,'notice-mwa-instant.png')});
  await app.native().getByRole('button',{name:'打开交易面板',exact:true}).click();
  await expect.poll(()=>app.host.evaluate(()=>surfaceProbe.overlayBounds().chartBounds.bottom),{timeout:15000}).toBeLessThan(result.deployedGeometry.bounds.chartBounds.bottom-100);
  result.deployedBottomExpanded=await app.host.evaluate(()=>({rect:surfaceProbe.document.querySelector('.nc-native-instant').getBoundingClientRect().toJSON(),bounds:surfaceProbe.overlayBounds()}));
  await expect.poll(()=>app.host.evaluate(()=>{const r=surfaceProbe.document.querySelector('.nc-native-instant').getBoundingClientRect(),b=surfaceProbe.overlayBounds().chartBounds;return Math.abs(r.bottom-(b.bottom-16));})).toBeLessThanOrEqual(1);
  await app.page.screenshot({path:path.join(config.output,'notice-mwa-bottom-expanded.png')});
  await app.native().getByRole('button',{name:/^(打开|关闭|隐藏)交易面板$/}).first().click();
  await expect.poll(()=>app.host.evaluate(()=>surfaceProbe.overlayBounds().chartBounds.bottom),{timeout:15000}).toBeGreaterThan(result.deployedBottomExpanded.bounds.chartBounds.bottom+100);
  await expect.poll(()=>app.host.evaluate(()=>{const r=surfaceProbe.document.querySelector('.nc-native-instant').getBoundingClientRect(),b=surfaceProbe.overlayBounds().chartBounds;return Math.abs(r.bottom-(b.bottom-16));})).toBeLessThanOrEqual(1);
  record('mw-acceptance actual account-manager bottom panel open/close and live notice reposition');
  await app.host.evaluate(()=>{tracing=false;notifications.destroy();surfaceProbe.destroy()});
  await expect(app.native().locator('.nc-system-entry')).toBeVisible({timeout:60000});
  await app.native().locator('.nc-system-entry').click();await expect(app.native().locator('[data-name="mw-native-system-message-center"]')).toBeVisible();
  result.application={url:config.base,chartOrigin:config.chart,notificationCenter:true,blockedWrites:app.writes};
  await app.page.screenshot({path:path.join(config.output,'notice-mwa-center.png')});await app.context.close();
  record('mw-acceptance real native notification center and exact Surface candidate');
  result.passed=true;
 }catch(error){result.failure=error.stack;throw error}
 finally{fs.writeFileSync(path.join(config.output,'instant-notice-placement.json'),JSON.stringify(result,null,2));await browser.close();await server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
