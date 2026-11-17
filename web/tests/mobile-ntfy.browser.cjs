const { auditHeaderIcons } = require('./mobile-header-icons.helper.cjs');
// Built mobile settings with explicit API doubles; no Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),out=process.env.MOBILE_NTFY_OUTPUT||'/tmp/mw-mobile-ntfy';
fs.mkdirSync(out,{recursive:true});
let logged=true,healthReads=0,failHealth=false,holdHealth=false,releaseHealth;
let healthResult={version:'fixture-1',ntfy_configured:true,delivery_enabled:true,chart_alerts:{loop:{state:'idle'}}};
let config={url:'https://ntfy.example',topic:'fixture-topic',enabled:false,revision:0,token_configured:true},checkOK=true,acked=false,failSave=false;
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
 if(url.pathname==='/api/settings/notification-transport'){
  if(req.method==='POST'){
   const body=JSON.parse(raw);if(failSave)return json({detail:'保存失败，请重试'},503);
   if(body.revision!==config.revision)return json({detail:'配置已更新'},409);
   config={...config,...body,revision:config.revision+1,token_configured:body.clear_token?false:Boolean(body.token)||config.token_configured};delete config.token;delete config.clear_token;
  }return json(config);
 }
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
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));const dialog=()=>page.getByRole('dialog').last();
 const close=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
 try{
 await page.goto('http://127.0.0.1:'+server.address().port+'/m/more');
 await page.getByRole('button',{name:/后台通知/}).click();await expect(page.getByLabel('订阅主题',{exact:true})).toHaveValue('fixture-topic');
 await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();
 await page.getByRole('switch',{name:'后台通知',exact:true}).click();
 await expect(page.getByRole('button',{name:'检查连接',exact:true})).toBeDisabled();
 await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
 await expect(page.getByRole('alertdialog',{name:'放弃本次修改？'})).toBeVisible();
 await page.getByRole('button',{name:'继续编辑',exact:true}).click();await expect(page.getByRole('alertdialog')).toHaveCount(0);
 await page.getByRole('button',{name:/访问令牌/}).click();await page.getByLabel('访问令牌',{exact:true}).fill('fixture-private-token');
 failSave=true;await page.getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('保存失败');await expect(page.getByLabel('访问令牌',{exact:true})).toHaveValue('fixture-private-token');
 failSave=false;await page.getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog().getByRole('status')).toContainText('已保存');await expect(page.getByLabel('访问令牌',{exact:true})).toHaveValue('');assert(config.enabled);
 await page.getByRole('button',{name:'检查连接',exact:true}).click();await expect(dialog().getByText(/ntfy 服务可达/)).toBeVisible();
 checkOK=false;await page.getByRole('button',{name:'检查连接',exact:true}).click();await expect(dialog().getByRole('alert')).toContainText('服务拒绝访问');
 await page.getByRole('button',{name:'发送测试',exact:true}).click();await expect(dialog().getByText('ntfy 已接受 · 等待手机确认',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'我已收到',exact:true}).click();await expect(dialog().getByText('手机已确认收到',{exact:true})).toBeVisible();
 await expect(page.locator('.mobile-toast')).toHaveCount(0);await close();
 const reads=requests.filter(r=>r.path==='/api/notification-tests/fixture-test').length;await page.waitForTimeout(2300);assert.equal(requests.filter(r=>r.path==='/api/notification-tests/fixture-test').length,reads,'polling stops when closed');
 for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){
  await page.setViewportSize({width,height:812});if(await page.locator('.mobile-app').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:/显示主题/}).click();await page.evaluate(f=>document.documentElement.style.fontSize=f+'px',font);
  await page.getByRole('button',{name:/后台通知/}).click();await expect(page.getByLabel('订阅主题',{exact:true})).toHaveValue('fixture-topic');await page.waitForTimeout(400);
  assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,`notifications-${theme}-${width}-${font}.png`)});await close();
 }
 await page.setViewportSize({width:375,height:480});await page.getByRole('button',{name:/后台通知/}).click();await expect(page.getByLabel('订阅主题',{exact:true})).toBeVisible();await page.getByLabel('订阅主题',{exact:true}).focus();await page.getByRole('button',{name:'发送测试',exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'发送测试',exact:true})).toBeInViewport();await page.screenshot({path:path.join(out,'short-viewport.png')});await close();
 const local=await page.evaluate(()=>JSON.stringify({...localStorage}));assert(!local.includes('fixture-private-token'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks:['read/save token masking','dirty back confirmation','save failure retains draft','saved config check only','test accepted vs phone acknowledged','no floating toast','poll stops on close','375/412 light/dark 150% font','short viewport action reachable'],errors}));
 }finally{for(const s of streams)s.end();await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
