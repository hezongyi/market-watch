// A stable notice stays at the global corner and may cover expanded panels.
const {configuration,fixtureServer,nativePage,application,chromium,expect,fs,path}=require('./swing-notice-support.cjs');
const assert=require('node:assert/strict');
(async()=>{
 const config=configuration(),server=await fixtureServer(),browser=await chromium.launch({args:['--no-sandbox']});
 const deployed=process.env.MW_LAYOUT_APP==='1';
 const result={passed:false,deployed,samples:[]};
 try{
  const app=deployed?await application(browser,config):null;
  const page=app?.page||await nativePage(browser,server.url+'/fixture.html?layout');
  const host=app?.host||page;
  const native=app?.native||(()=>page.frames().find(f=>f.url().startsWith('blob:')));
  await host.evaluate(async()=>{
   const now=Date.now();
   globalThis.layoutState={epoch:'layout',revision:1,events:[],pending:[],unread:0,status:'',gap:'',enabled:true,unlocked:true,soundLimited:false,soundStatus:'',systemPopups:true,systemPopupSeconds:60,overflow:0,alertPending:1,serverTime:now,
    bubble:{id:'layout-sticky',version:1,source_domain:'test',source_kind:'chart_alert',source_id:'layout',kind:'fault',severity:'warning',title:'全局右下角回归测试',message:'这条通知在侧栏及底栏开合期间保持显示，且不会收到后续消息更新。',occurred_at:now,recorded_at:now,workspace:'layout',instrument:'XAUUSD',context:{},evidence:{}}};
   globalThis.layoutNotice=await MWNativeNotifications.attach({widget,scope:{workspace_id:'layout',session:'layout',epoch:1},state:layoutState,request:async()=>({events:[],before:null,unread:0,server_time:now}),report:e=>{throw e},locate:()=>{},alert:()=>{},panelChanged:()=>{}});
  });
  await expect(native().getByRole('heading',{name:'全局右下角回归测试'})).toBeVisible();
  const sticky=()=>native().locator('.nc-native-instant').filter({has:native().getByRole('heading',{name:'全局右下角回归测试'})});
  await expect(sticky().locator('[data-notice-phase="shown"]')).toBeVisible();
  const sample=async(label)=>{
   await page.waitForTimeout(450);
   const state=await host.evaluate(()=>{
    const doc=document.querySelector('iframe').contentDocument;
    const notices=Array.from(doc.querySelectorAll('.nc-native-instant')).filter(n=>n.querySelector('h3')?.textContent==='全局右下角回归测试');
    const notice=notices[0],n=notice.getBoundingClientRect();
    const c=doc.querySelector('.layout__area--center').getBoundingClientRect();
    const charts=Array.from(doc.querySelectorAll('.chart-container')).map(n=>n.getBoundingClientRect()).filter(r=>r.width&&r.height);
    return {viewport:{width:innerWidth,height:innerHeight},notice:n.toJSON(),center:c.toJSON(),chartBottom:Math.max(...charts.map(r=>r.bottom)),count:notices.length,topLayer:doc.elementFromPoint(n.left+20,n.top+20)?.closest('.nc-native-instant')===notice};
   });
   result.samples.push({label,...state});
   await page.screenshot({path:path.join(config.output,(deployed?'application-':'fixture-')+label+'.png')});
   const inset=state.viewport.width<480?12:16;
   console.log(label,JSON.stringify(state));
   assert.equal(state.count,1,'inspect the unique stable notice');
   assert.ok(Math.abs(state.notice.right-(state.viewport.width-inset))<=1,'notice stays at the global right edge');
   assert.ok(Math.abs(state.notice.bottom-(state.viewport.height-inset))<=1,'notice stays at the global bottom edge');
   assert.ok(state.topLayer,'notice can cover the panel beneath it');
  };
  await sample('desktop-initial');
  await native().locator('button[data-name="base"][aria-pressed]').click();await sample('desktop-sidebar-closed');
  await native().locator('button[data-name="base"][aria-pressed]').click();await sample('desktop-sidebar-open');
  await native().getByRole('button',{name:'打开交易面板',exact:true}).click();await sample('desktop-bottom-open');
  await native().getByRole('button',{name:/^(打开|关闭|隐藏)交易面板$/}).first().click();await sample('desktop-bottom-closed');
  await page.setViewportSize({width:375,height:700});await sample('narrow-initial');
  await host.evaluate(()=>layoutNotice.destroy());
  result.passed=true;
 }catch(e){result.failure=e.stack;throw e}
 finally{fs.writeFileSync(path.join(config.output,(deployed?'application-':'fixture-')+'instant-notice-layout.json'),JSON.stringify(result,null,2));await browser.close();await server.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
