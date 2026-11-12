// Built phone UI + explicit HTTP fixtures. No device/supplier/push acceptance claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const instrument='a'.repeat(64), revision='11111111-1111-4111-8111-111111111111',ticker='MWC:'+instrument;
let logged=false,lost=true,conflict=false,createBodies=[],edits=[],actions=[],observations=[],rows=[],errors=[];
const note={id:'s:incident',first_seq:1,version:1,source_kind:'chart_alert_execution',source_domain:'pro_chart',source_id:'test',
 incident_id:'incident',kind:'failure',severity:'warning',title:'执行缺口',message:'当前区间无法判定',occurred_at:Date.now(),recorded_at:Date.now(),
 viewed_at:null,handled_at:null,attention:true,backfill:false,workspace:'',instrument:ticker,context:{},evidence:{},incident:{id:'incident',count:1,closed_at:null}};
const pageOf=()=>({events:[note],before:null,after:'cursor1',epoch:'epoch1',unread:0,system_unread:0,alert_unread:1,server_time:Date.now()});
const dist=path.resolve('dist');
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/api/session')return logged?json({csrf:'test',subject:'admin'}):json({},401);
 if(url.pathname==='/api/login'){logged=true;return json({csrf:'test',subject:'admin'});}
 if(url.pathname==='/api/advanced-charts/preferences')return json([]);
 if(url.pathname==='/api/health')return json({ntfy_configured:false,delivery_enabled:false,chart_alerts:{loop:{state:'idle'}}});
 if(url.pathname==='/api/market-data/series/page')return json({items:[],next_offset:null});
 if(url.pathname==='/api/market-data/resolve')return json({id:instrument,source:'composite',created:true,frames:['M1','H1']});
 if(url.pathname==='/api/market-data/composites/'+instrument)return json({active_revision_id:revision,display_symbol:'TEST-COMPOSITE'});
 if(url.pathname==='/api/chart-alerts/capabilities')return json({sources:[{source:'composite',series_kind:'composite',available:false,
   price_modes:{close:{available:false,reason:'完成柱尚不可用'},intrabar:{available:body.timeframe==='M1',reason:body.timeframe==='M1'?null:'周期不可用'}}}]});
 if(url.pathname==='/api/chart-alerts/events')return json([]);
 if(url.pathname==='/api/chart-alerts'&&req.method==='GET')return json(rows);
 if(url.pathname==='/api/chart-alerts'&&req.method==='POST'){
  createBodies.push(body);
  let row=rows.find(r=>r.request_id===body.request_id);
  if(!row){row={id:'22222222-2222-4222-8222-222222222222',request_id:body.request_id,name:body.config.name,config:body.config,
   version:1,control_revision:1,run:1,status:'active',health:'warming',count:0,max_triggers:1,condition_summary:'价格上穿 123',updated_at:Date.now(),
   display_identity:{code:'TEST-COMPOSITE'},execution:{state:'preparing',label:'准备中',message:'等待接管',phone_configuration:{message:'ntfy 未配置'}}};rows.push(row);}
  if(lost){lost=false;return json({detail:'test lost response'},503);}return json(row,201);
 }
 if(/^\/api\/chart-alerts\/[^/]+\/judgments$/.test(url.pathname))return json([{id:'j',event_time:Date.now(),outcome:'unknown',created_at:Date.now()}]);
 if(/^\/api\/chart-alerts\/[^/]+\/edit$/.test(url.pathname)){
  edits.push(body);if(conflict)return json({detail:'另一个窗口已修改'},409);
  const row=rows[0];row.version++;row.config=body.config;row.name=body.config.name;return json(row);
 }
 if(/^\/api\/chart-alerts\/[^/]+\/lifecycle$/.test(url.pathname)){
  actions.push(body);const row=rows.find(r=>url.pathname.includes(r.id));row.control_revision++;
  row.status=body.action==='pause'?'paused':body.action==='resume'?'active':'archived';row.execution={state:row.status,label:row.status==='paused'?'已暂停':'准备中'};return json(row);
 }
 if(/^\/api\/chart-alerts\/[^/]+$/.test(url.pathname))return json(rows.find(r=>url.pathname.endsWith(r.id)));
 if(url.pathname==='/api/notification-center/events')return json(pageOf());
 if(url.pathname==='/api/notification-center/changes')return json({...pageOf(),changes:[],more:false});
 if(url.pathname==='/api/notification-center/health')return json({state:'idle',at:Date.now(),display_enabled:true,sound_enabled:false});
 if(url.pathname==='/api/notification-center/observations'){observations.push(body);if(body.kind==='handled')note.handled_at=Date.now();return json({ok:true});}
 if(url.pathname.endsWith('/timeline'))return json({observations:[{id:'o',kind:'viewed',received_at:Date.now(),reported_at:Date.now()}]});
 if(url.pathname.startsWith('/api/'))return json({detail:'Unexpected '+url.pathname},404);
 let file=path.join(dist,decodeURIComponent(url.pathname));if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true}),page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));

 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/alerts');
  await page.getByLabel('密码',{exact:true}).fill('test');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'创建告警',exact:true})).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('未处理事件');
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();assert.equal(observations.filter(v=>v.kind==='handled').length,0);
  await page.evaluate(async ticker=>{
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put({value:ticker,readAt:Date.now()},[location.origin,'admin',1,'chart-selection']);tx.oncomplete=resolve;tx.onerror=reject;});db.close();
  },ticker);
  await page.reload();await expect(page.getByRole('button',{name:'创建告警',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'关闭通知',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'创建告警',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'创建价格告警',exact:true});
  await expect(dialog.getByRole('button',{name:'保存告警',exact:true})).toBeDisabled();
  await expect(dialog.getByText('完成柱尚不可用',{exact:true})).toBeVisible();
  await dialog.getByLabel('判定方式',{exact:true}).selectOption('intrabar');
  await dialog.getByLabel('目标价格',{exact:true}).fill('123');await dialog.getByLabel('名称',{exact:true}).fill('手机价格规则');
  await expect(dialog.getByRole('checkbox',{name:'ntfy 手机通知',exact:true})).toBeDisabled();
  await dialog.getByLabel('周期',{exact:true}).selectOption('H1');await expect(dialog.getByRole('button',{name:'保存告警',exact:true})).toBeDisabled();
  await dialog.getByLabel('周期',{exact:true}).selectOption('M1');
  await dialog.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  await expect(dialog.getByRole('button',{name:'核查同一次提交',exact:true})).toBeVisible();assert.equal(createBodies.length,1,'rapid submit fenced');
  await expect(dialog.getByLabel('名称',{exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'核查同一次提交',exact:true}).click();
  await expect(dialog).toHaveCount(0);assert.equal(createBodies.length,2);assert.deepEqual(createBodies[0],createBodies[1]);
  assert.equal(createBodies[0].config.association,null);assert.equal(createBodies[0].config.composite_revision_id,revision);
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await expect(page.locator('.mobile-rule-card')).toContainText('准备中');
  rows[0].config.association={workspace_id:'existing-workspace',chart_id:'existing-chart',generation:'old',object_id:null,object_kind:null};
  await page.getByRole('button',{name:'更多告警筛选',exact:true}).click();
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByRole('button',{name:'应用筛选',exact:true}).click();
  await page.locator('.mobile-rule-card').click();await page.getByRole('button',{name:'编辑价格告警',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'编辑价格告警',exact:true});
  await edit.getByLabel('目标价格',{exact:true}).fill('124');conflict=true;
  await edit.getByRole('button',{name:'保存告警',exact:true}).click();
  await expect(edit.getByRole('alert')).toContainText('另一个窗口');await expect(edit.getByLabel('目标价格',{exact:true})).toHaveValue('124');
  assert.deepEqual(edits[0].config.association,rows[0].config.association);
  page.once('dialog',d=>d.dismiss());await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(edit).toBeVisible();
  page.once('dialog',d=>d.accept());await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
  await expect(edit).toHaveCount(0);await expect(page.getByRole('dialog',{name:'手机价格规则',exact:true})).toBeVisible();
  rows[0].execution={...rows[0].execution,state:'monitoring',label:'后台最新监控状态',message:'后台刷新已接管'};
  rows[0].count=1;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('dialog',{name:'手机价格规则',exact:true})).toContainText('后台最新监控状态');
  await expect(page.getByRole('dialog',{name:'手机价格规则',exact:true})).toContainText('1/1 次');
  conflict=false;await page.getByRole('button',{name:'暂停',exact:true}).click();
  await expect(page.getByRole('button',{name:'恢复',exact:true})).toBeVisible();assert.equal(actions[0].version,1);assert.equal(actions[0].control_revision,1);
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'事件记录',exact:true}).click();await page.getByRole('button',{name:'异常 / 恢复',exact:true}).click();
  await page.getByRole('button',{name:/执行缺口/}).click();await expect(page.getByText('查看',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'标记已处理',exact:true}).click();await expect.poll(()=>observations.filter(v=>v.kind==='handled').length).toBe(1);
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>document.documentElement.style.fontSize='150%');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/mw-android-personal-v205-alerts.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({evidence:'built mobile UI with HTTP doubles',checks:['per-mode capabilities and actual frames','no workspace on create; revision bound','rapid submit fenced','unknown result reuses request ID/config','editing preserves old association','409 preserves input','back affects only top sheet','versioned lifecycle','execution preparing is not monitoring','open rule detail follows background refresh','notice close does not handle; explicit confirmation does','notice ID dedup across reload','single mobile IDB and 150% layout'],errors},null,2));
 }finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
