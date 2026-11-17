const { auditHeaderIcons } = require('./mobile-header-icons.helper.cjs');
// Built mobile settings with explicit API doubles; no Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),out=process.env.MOBILE_NTFY_OUTPUT||'/tmp/mw-mobile-ntfy';
fs.mkdirSync(out,{recursive:true});
let eventMissing=false;
let systemMissing=false,systemAck=false;
let policy={quiet_enabled:false,system_quiet_enabled:true,quiet_start:'23:00',quiet_end:'07:00',timezone:'Asia/Shanghai',priority:5,repeat_seconds:30,ring_seconds:15,max_repeats:0,mode:'ntfy_native'};
let logged=false,healthReads=0,failHealth=false,holdHealth=false,releaseHealth;
let healthResult={version:'fixture-1',ntfy_configured:true,delivery_enabled:true,chart_alerts:{loop:{state:'idle'}}};
let config={url:'https://ntfy.example',topic:'fixture-topic',enabled:false,revision:0,token_configured:true},checkOK=true,acked=false,failSave=false;
const streams=new Set(),errors=[],requests=[];
const record={id:'fixture-record',title:'行情数据连接恢复 · 长标题布局检查',message:'供应商已恢复连接，历史告警记录仍可查阅。',instrument:'EURUSD',severity:'info',occurred_at:Date.now(),handled_at:null};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const c of req)raw+=c;
 const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:req.method});
 if(url.pathname==='/api/session')return logged?json({csrf:'test',subject:'admin'}):json({},401);
 if(url.pathname==='/api/login'){logged=true;return json({csrf:'test',subject:'admin'});}
 if(url.pathname==='/api/chart-alerts/page')return json({items:[],has_more:false});
 if(url.pathname==='/api/chart-alerts/events/page')return json({items:[],next_cursor:null});
 if(url.pathname.startsWith('/api/chart-alerts/events/')&&eventMissing)return json({detail:'触发记录暂时不可读取'},503);
 if(url.pathname.startsWith('/api/chart-alerts/events/'))return json({id:url.pathname.split('/').pop(),alert_id:'rule-1',display_identity:{code:'EURUSD',source:'dukascopy'},occurred_at:Date.now(),detected_at:Date.now(),price:'1.08512',threshold:'1.08500',direction:'up',evidence:{config:{name:'通知直达测试',series_kind:'materialized',instrument:'MWC:fixture',condition:{left:{kind:'price'},relation:'cross_up',right:{kind:'constant',value:'1.08500'}}}},notification_id:'notification-1',notification_status:'server_accepted',delivery_status:'accepted',notice:null,ack_at:null});
 if(url.pathname==='/api/logout'){logged=false;return json({ok:true});}
 if(url.pathname==='/api/health'){
  healthReads++;if(holdHealth)await new Promise(resolve=>releaseHealth=resolve);
  return failHealth?json({detail:'健康状态暂时不可用'},503):json(healthResult);
 }
 if(url.pathname==='/api/settings/notification-transport'){
  if(req.method==='POST'){
   const body=JSON.parse(raw);if(failSave)return json({detail:'保存失败，请重试'},503);
   if(body.revision!==config.revision)return json({detail:'配置已更新'},409);
   config={...config,...body,revision:config.revision+1,token_configured:body.clear_token?false:Boolean(body.token)||config.token_configured};delete config.token;delete config.clear_token;
  }return json(config);
 }
 if(url.pathname==='/api/settings/notifications'){
  if(req.method==='POST')policy={...policy,...JSON.parse(raw)};
  return json(policy);
 }
 if(url.pathname.startsWith('/api/notification-center/notifications/')){
  if(systemMissing)return json({detail:'这条通知暂时不可读取'},503);
  const id=url.pathname.split('/').pop();
  return json({...record,id:'n:'+id,notification_id:id,source_kind:'runtime',title:id.startsWith('1111')?'后台服务异常 · 对应消息一':'后台服务已恢复 · 对应消息二',
   message:'本条通知的原始详情，和列表中的其他记录不同。',notification_status:systemAck?'acknowledged':'server_accepted',ack_at:systemAck?Date.now():null,notify_web:false});
 }
 if(url.pathname.startsWith('/api/notifications/')&&url.pathname.endsWith('/ack')){systemAck=true;return json({status:'acknowledged'});}
 if(url.pathname==='/api/settings/notification-transport/check')return json({ok:checkOK,message:checkOK?'ntfy 服务可达；发布权限和手机接收请用测试通知确认。':'服务拒绝访问，请检查地址与访问令牌。'});
 if(url.pathname==='/api/notification-tests')return json({status:'queued',test_id:'fixture-test'});
 if(url.pathname==='/api/notification-tests/fixture-test/received'){acked=true;return json({status:'acknowledged',confirmation:'user_reported'});}
 if(url.pathname==='/api/notification-tests/fixture-test')return json({status:acked?'acknowledged':'server_accepted',outbox_status:'accepted',ack_at:acked?Date.now():null,attempts:1});
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
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 await context.addInitScript(()=>{
  window.pendingNotification='/alerts?signal=event-1';window.nativeActions=[];
  window.MWMobileHost={postMessage(raw){const msg=JSON.parse(raw);window.nativeActions.push(msg.action);
   if(msg.action==='hello'||msg.action==='notification-link'){
    const target=window.pendingNotification;window.pendingNotification=null;
    queueMicrotask(()=>window.MWMobileHost.onmessage?.({data:JSON.stringify({version:1,...(msg.action==='hello'?{appVersion:'0.1.5',capabilities:['notification-link-v1','app-update-v1']}:{}),notificationPath:target})}));
   }
  }};
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const enter=path=>page.evaluate(path=>{window.pendingNotification=path;dispatchEvent(new Event('mw-mobile-notification-ready'));},path);
 const close=async()=>{await page.getByRole('dialog').last().getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
 try{
 await page.goto('http://127.0.0.1:'+server.address().port+'/m/');
 await expect(page.getByLabel('密码',{exact:true})).toBeVisible();
 await page.getByLabel('密码',{exact:true}).fill('fixture');await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page).toHaveURL(/\/m\/alerts\?signal=event-1$/);
 await expect(page.getByRole('dialog',{name:'触发详情'})).toBeVisible();await expect(page.getByRole('dialog',{name:'触发详情'})).toContainText('1.08512');
 assert.equal(requests.filter(r=>r.method==='POST'&&(r.path.endsWith('/ack')||r.path.includes('/observations'))).length,0,'entry never confirms the notification');
 await page.screenshot({path:path.join(out,'notification-app-event.png')});await close();
 await enter('/alerts?signal=event-2');await expect(page.getByRole('dialog',{name:'触发详情'})).toBeVisible();await expect(page).toHaveURL(/signal=event-2$/);await close();
 await enter('/alerts?signal=event-2');await expect(page.getByRole('dialog',{name:'触发详情'})).toBeVisible();await close();
 await enter('/more?panel=notifications');await expect(page.getByLabel('订阅主题',{exact:true})).toHaveValue('fixture-topic');
 await expect(page.getByRole('switch',{name:'运行通知夜间静默',exact:true})).toBeChecked();
 await page.getByRole('switch',{name:'运行通知夜间静默',exact:true}).click();
 await expect.poll(()=>policy.system_quiet_enabled).toBe(false);
 assert.equal(policy.priority,5,'system preference does not alter price alert priority');
 await page.getByRole('switch',{name:'运行通知夜间静默',exact:true}).click();
 await expect.poll(()=>policy.system_quiet_enabled).toBe(true);
 await page.waitForTimeout(400);await page.screenshot({path:path.join(out,'notification-runtime-policy.png')});
 await page.getByLabel('订阅主题',{exact:true}).fill('unsaved-draft');
 await enter('/alerts?signal=event-3');await page.waitForTimeout(600);await expect(page.getByLabel('订阅主题',{exact:true})).toHaveValue('unsaved-draft');await expect(page).toHaveURL(/\/more/);
 await page.getByRole('dialog').last().getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 await expect(page).toHaveURL(/signal=event-3$/);await expect(page.getByRole('dialog',{name:'触发详情'})).toBeVisible();await close();
 eventMissing=true;await enter('/alerts?signal=event-4');await expect(page.getByText('触发记录暂时不可读取',{exact:true})).toBeVisible();eventMissing=false;await page.getByRole('button',{name:'重试',exact:true}).click();await expect(page.getByRole('dialog',{name:'触发详情'})).toBeVisible();await close();
 await enter('/alerts?records=system');await expect(page.getByRole('dialog',{name:'事件记录',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'系统',exact:true})).toHaveAttribute('aria-selected','true');await close();
 await enter('/advanced-charts?panel=alerts');await page.waitForTimeout(600);await expect(page).toHaveURL(/records=system$/);
 const closeSystem=async()=>{while(await page.getByRole('dialog').count()){await page.getByRole('dialog').last().getByRole('button',{name:'关闭',exact:true}).click();await page.waitForTimeout(250);}};
 await enter('/alerts?signal=n_11111111111111111111111111111111');
 await expect(page.getByRole('dialog',{name:'后台服务异常 · 对应消息一',exact:true})).toBeVisible();
 await expect(page.getByRole('dialog').last()).toContainText('本条通知的原始详情');
 assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/ack')).length,0,'opening a system notification never acknowledges');
 await page.waitForTimeout(400);await page.screenshot({path:path.join(out,'notification-system-exact-record.png')});
 await page.setViewportSize({width:375,height:812});
 await page.evaluate(()=>{document.documentElement.style.fontSize='24px';document.querySelector('.mobile-app').dataset.theme='light';});
 await page.waitForTimeout(400);await page.screenshot({path:path.join(out,'notification-system-375-light-150.png')});
 const confirmBox=await page.getByRole('button',{name:'确认收到',exact:true}).boundingBox();assert(confirmBox.x>=0&&confirmBox.x+confirmBox.width<=375,'confirmation stays within the small viewport');
 await page.evaluate(()=>{document.documentElement.style.fontSize='';document.querySelector('.mobile-app').dataset.theme='dark';});
 await page.setViewportSize({width:412,height:915});
 await page.getByRole('button',{name:'确认收到',exact:true}).click();
 await expect(page.getByRole('button',{name:'已确认收到',exact:true})).toBeDisabled();
 await closeSystem();
 systemMissing=true;await enter('/alerts?signal=n_22222222222222222222222222222222');
 await expect(page.getByText('这条通知暂时不可读取',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog',{name:'后台服务异常 · 对应消息一',exact:true})).toHaveCount(0);
 systemMissing=false;await page.getByRole('button',{name:'重试读取通知',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'后台服务已恢复 · 对应消息二',exact:true})).toBeVisible();
 await closeSystem();
 assert.deepEqual(errors,[]);assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/ack')).length,1);
 console.log(JSON.stringify({checks:['cold native link survives login','exact trigger detail even beyond first history page','warm entry and repeated notification','test opens notification settings','unsaved draft preserved and entry deferred until close','failed direct detail can retry','system record category','invalid routes rejected','exact system message detail','system detail retry never shows a different message','runtime quiet preference preserves price alert policy','375px light 150% and 412px dark layouts','entry does not acknowledge; explicit confirmation does'],errors}));
 }finally{for(const s of streams)s.end();await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
