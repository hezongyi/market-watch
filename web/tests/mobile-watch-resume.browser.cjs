const { auditHeaderIcons } = require('./mobile-header-icons.helper.cjs');
// Real built mobile UI, explicit API doubles; no supplier or Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const first='MWP:TEST',second='MWP:SECOND',third='MWP:THIRD';
let remote={kind:'setting',name:'mw.watchlists.v1',tool:'',revision:3,content:{envelope:'keep',value:{active:'a',unknown:'keep',lists:[
  {id:'a',title:'第一组',symbols:[first],unknown:'keep-list'}, {id:'b',title:'第二组',symbols:[second]}
]}}},logged=false,conflict=false;
const writes=[],clients=new Set(),streams=new Set(),errors=[],subscriptions=new Map();let holdSave=false,pendingSave;let maxStreams=0,holdQuotes=false,quoteReads=0,sparkReads=0,unsubscribes=0,quotePrice=123.45,sparkVersion=1,quoteReadAt=1000;const pendingQuotes=[];
const dist=path.resolve('dist'),controlsOutput=process.env.MOBILE_WATCH_OUTPUT||'/tmp/mw-watch-controls-regression';
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
 if(url.pathname==='/api/market-data/center/dataset-summaries')return json({items:[],total:0});
 if(url.pathname==='/api/market-data/series/page'){
  const query=url.searchParams.get('query');
  if(query==='old')return setTimeout(()=>json({items:[{ticker:first,symbol:'OLD-RESULT'}]}),700);
  return json({items:[{ticker:third,symbol:query==='new'?'NEW-RESULT':'THIRD',description:'真实身份测试 · 原生 · 测试来源'}],next_offset:null});
 }
 if(url.pathname==='/api/market-data/resolve')return json({id:body.instrument,source:'binance',basis:'last',frames:['M1','M5','H1'],precision:2});
 if(url.pathname==='/api/market-data/quotes'){
  quoteReads++;
  const reply=()=>json(body.symbols.map(n=>({n,s:'ok',v:{short_name:n.slice(4),description:'测试名称 · 原生 · 测试来源',lp:quotePrice,read_at:quoteReadAt,chp:1.2,fetch_status:'ok'}})));
  if(holdQuotes){pendingQuotes.push(reply);return;}return reply();
 }
 if(url.pathname==='/api/market-data/sparklines'){
  sparkReads++;
  const left=Math.floor(Date.now()/86400000)*86400000;
  return json({as_of:Date.now(),items:body.items.map(item=>({ticker:item.ticker,revision:null,window_start:left,window_end:left+86400000,timeframe:'M1',
   points:[{time:left,price:'122',gap_before:false},{time:left+60000,price:'123',gap_before:false},{time:left+180000*sparkVersion,price:String(123.45+sparkVersion),gap_before:true}],status:'partial',last_data_at:left+180000}))});
 }
 if(url.pathname==='/api/charts/stream/events'){
  clients.add(url.searchParams.get('client'));streams.add(res);maxStreams=Math.max(maxStreams,streams.size);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('retry: 100\n\nevent: heartbeat\ndata: {}\n\n');
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
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/');
  await page.getByLabel('密码',{exact:true}).fill('test');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(2);
  await expect(page.locator('.mobile-watch-price').first()).toContainText('123.45');
  await expect.poll(()=>sparkReads).toBeGreaterThan(0);
  const before=sparkReads,oldCurve=await page.locator('.mobile-spark svg').first().innerHTML();
  sparkVersion=2;quotePrice=125.67;quoteReadAt=2000;
  for(const response of streams)response.end();
  await expect(page.locator('.mobile-watch-price').first()).toContainText('125.67',{timeout:5000});
  await expect.poll(()=>sparkReads,{timeout:2000,message:'reconnection must immediately refill the complete curve, not wait for the minute poll'}).toBeGreaterThan(before);
  await expect.poll(()=>page.locator('.mobile-spark svg').first().innerHTML()).not.toBe(oldCurve);
  holdQuotes=true;quotePrice=130.34;quoteReadAt=4000;
  for(const response of streams)response.end();
  await expect.poll(()=>pendingQuotes.length).toBeGreaterThan(0);await expect.poll(()=>streams.size).toBe(1);
  const subscription=[...subscriptions.values()].find(row=>row.query.instrument==='TEST');
  const push=(sequence,price,read_at)=>{for(const response of streams)response.write('data: '+JSON.stringify({listener:subscription.listener,generation:subscription.generation,sequence,type:'quotes',quotes:[{s:'ok',v:{short_name:'TEST',lp:price,chp:2,read_at,fetch_status:'ok'}}]})+'\n\n');};
  push(10,126.12,3000);await expect(page.locator('.mobile-watch-price').first()).toContainText('126.12');
  holdQuotes=false;pendingQuotes.splice(0).forEach(reply=>reply());
  await expect(page.locator('.mobile-watch-price').first()).toContainText('130.34');
  push(11,127,3500);await page.waitForTimeout(150);await expect(page.locator('.mobile-watch-price').first()).toContainText('130.34');
  const url=page.url();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>streams.size).toBe(0);const reads=sparkReads;
  sparkVersion=3;quotePrice=131.45;quoteReadAt=5000;
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('.mobile-watch-price').first()).toContainText('131.45');
  await expect.poll(()=>sparkReads).toBeGreaterThan(reads);assert.equal(page.url(),url);
  assert.deepEqual(errors,[]);await page.screenshot({path:controlsOutput+'/resume.png'});
  console.log('PASS Watch recovery: immediate curve, HTTP/SSE ordering, stale quote fence, foreground resync');
 }finally{await context.close();await browser.close();for(const response of streams)response.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
