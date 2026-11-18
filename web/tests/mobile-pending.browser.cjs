const { auditHeaderIcons } = require('./mobile-header-icons.helper.cjs');
// Built mobile settings with explicit API doubles; no Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),out=process.env.MW_PENDING_OUTPUT||'/tmp/mw-mobile-pending-browser';
fs.mkdirSync(out,{recursive:true});
let logged=true,healthReads=0,failHealth=false,holdHealth=false,releaseHealth;
let healthResult={version:'fixture-1',ntfy_configured:true,delivery_enabled:true,chart_alerts:{loop:{state:'idle'}}};
const streams=new Set(),errors=[],requests=[];
const record={id:'fixture-record',title:'行情数据连接恢复 · 长标题布局检查',message:'供应商已恢复连接，历史告警记录仍可查阅。',instrument:'EURUSD',severity:'info',occurred_at:Date.now(),handled_at:null};
const reportId='6c276e57-6191-42cf-8c2f-79e3b29f439a';
let plan={enabled:false,group_ids:['fx'],revision:1,next_run_at:null,groups:[{id:'fx',title:'外汇'},{id:'stocks',title:'全球股票与贵金属观察组'}],phone_available:true};
const report={id:reportId,mode:'scheduled',status:'partial',created_at:Date.now(),cutoff_at:Date.now(),finished_at:Date.now(),snapshot:{groups:[{id:'fx',title:'外汇'}]},body:{coverage:{ok:1,total:2},issues:['部分数据仍待来源更新'],sections:[{id:'daily_change',kind:'daily_change',title:'最近交易日涨跌',items:[{ticker:'EURUSD',symbol:'EURUSD',name:'欧元美元',category:'forex',source:'oanda',basis:'bid',status:'ok',freshness:'已核实交易日历',trading_date:'2026-11-16',previous_trading_date:'2026-11-13',change_pct:'0.123456',close:'1.12345',price_description:'原始价格'},{ticker:'MWP:YAHOO:AAPL',symbol:'AAPL',name:'苹果',category:'stock',source:'yahoo',basis:'adjusted',status:'not_updated',reason:'本期尚未确认',freshness:'新鲜度未核实',price_description:'来源复权'}]}]}};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const c of req)raw+=c;
 const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:req.method});
 if(url.pathname==='/api/market-data/quotes'){const body=JSON.parse(raw);assert(Array.isArray(body.symbols),'symbols payload');return json(body.symbols.map(n=>({n,s:'ok',v:{lp:1.1,quote_time:Date.now()}})));}
 if(url.pathname==='/api/briefings/plan'){if(req.method==='POST'){const body=JSON.parse(raw);if(body.revision!==plan.revision)return json({detail:'简报设置已在其他窗口修改，请重新读取后保存'},409);plan={...plan,...body,revision:plan.revision+1};}return json(plan);}
 if(url.pathname==='/api/briefings/reports')return json({items:[report],next_cursor:null});
 if(url.pathname.startsWith('/api/briefings/reports/'))return url.pathname.endsWith(reportId)?json(report):json({detail:'该期简报不存在'},404);
 if(url.pathname==='/api/session')return logged?json({csrf:'test',subject:'admin'}):json({},401);
 if(url.pathname==='/api/logout'){logged=false;return json({ok:true});}
 if(url.pathname==='/api/health'){
  healthReads++;if(holdHealth)await new Promise(resolve=>releaseHealth=resolve);
  return failHealth?json({detail:'健康状态暂时不可用'},503):json(healthResult);
 }
 if(url.pathname==='/api/settings/notifications')return json({system_quiet_enabled:true,quiet_start:'23:00',quiet_end:'07:00',timezone:'Asia/Shanghai'});
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
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const base=`http://127.0.0.1:${server.address().port}/m/more`,dialog=()=>page.getByRole('dialog').last(),settle=()=>page.waitForTimeout(550),proof={screenshots:[],checks:[]};
 const close=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).click();await settle();};
 const shot=async name=>{await settle();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' viewport overflow');assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1),name+' dialog overflow');await page.screenshot({path:path.join(out,name+'.png')});proof.screenshots.push(name);};
 const matrix=async prefix=>{for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){await page.evaluate(theme=>document.querySelector('.mobile-app').setAttribute('data-theme',theme),theme);await page.setViewportSize({width,height:812});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);await shot(`${prefix}-${theme}-${width}-${font}`);}};
 try{
 await page.goto(base);await page.getByRole('button',{name:/头寸计算/}).click();await expect(page.getByLabel('允许亏损 · USD')).toHaveValue('100.00');
 await page.getByLabel('入场价',{exact:true}).fill('1.1000');await page.getByLabel('止损价',{exact:true}).fill('1.0980');await expect(page.locator('.position-result > strong')).toContainText('0.50');await matrix('position');
 await page.setViewportSize({width:375,height:500});await page.getByLabel('止损价',{exact:true}).focus();await page.getByRole('button',{name:'复制结果',exact:true}).scrollIntoViewIfNeeded();await shot('position-short-viewport');
 await page.setViewportSize({width:375,height:812});await page.evaluate(()=>document.documentElement.style.fontSize='14px');
 await page.getByLabel('允许亏损 · USD').fill('77.77');await close();await context.setOffline(true);await page.getByRole('button',{name:/头寸计算/}).click();await expect(page.getByLabel('允许亏损 · USD')).toHaveValue('77.77');await page.getByLabel('入场价',{exact:true}).fill('1.1000');await page.getByLabel('止损价',{exact:true}).fill('1.0980');await expect(page.locator('.position-result > strong')).toContainText('0.38');await shot('position-offline');await close();await context.setOffline(false);
 proof.checks.push('exact risk + remembered valid budget + offline calculation + actual quotes payload + short viewport');
 await page.getByRole('button',{name:/市场简报/}).click();await expect(dialog().getByRole('switch')).not.toBeChecked();await dialog().getByRole('switch').click();await expect(dialog().getByRole('button',{name:'保存计划'})).toBeVisible();
 await context.setOffline(true);await page.waitForTimeout(100);await context.setOffline(false);await settle();await expect(dialog().getByRole('switch')).toBeChecked();await expect(dialog().getByRole('button',{name:'保存计划'})).toBeVisible();await dialog().getByRole('button',{name:'保存计划'}).click();await expect(dialog().getByRole('button',{name:'保存计划'})).toHaveCount(0);
 await dialog().locator('.briefing-history-row').click();await expect(dialog().getByText('EURUSD',{exact:true})).toBeVisible();await matrix('briefing');
 await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));await expect(dialog().getByText('观察分组',{exact:true})).toBeVisible();await close();
 proof.checks.push('dirty plan survives reconnect + saved revision + categorized report + Android back body→history');
 await page.getByRole('button',{name:/市场简报/}).click();await dialog().getByRole('switch').click();plan={...plan,revision:plan.revision+1,group_ids:['stocks']};await dialog().getByRole('button',{name:'保存计划'}).click();await expect(dialog().getByRole('button',{name:'读取最新设置'})).toBeVisible();await dialog().getByRole('button',{name:'读取最新设置'}).click();await expect(dialog().getByRole('button',{name:'保存计划'})).toHaveCount(0);await expect(dialog().getByRole('switch')).toBeChecked();await close();proof.checks.push('409 keeps draft; explicit reload replaces plan and draft atomically');
 await page.goto(base+'?briefing='+reportId);await expect(dialog().getByText('EURUSD',{exact:true})).toBeVisible();await context.setOffline(true);await settle();await expect(dialog().getByText('EURUSD',{exact:true})).toBeVisible();await context.setOffline(false);
 await page.goto(base+'?briefing=7c276e57-6191-42cf-8c2f-79e3b29f439a');await expect(dialog().getByText('该期简报不存在',{exact:true})).toBeVisible();await expect(dialog().getByText('EURUSD',{exact:true})).toHaveCount(0);
 proof.checks.push('direct report + offline cached body + missing report never shows old body');
 assert.deepEqual(errors,[]);proof.errors=errors;fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:true,...proof}));
 }finally{await context.close();await browser.close();for(const r of streams)r.end();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
