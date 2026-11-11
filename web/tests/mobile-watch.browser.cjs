// Real built mobile UI, explicit API doubles; no supplier or Android-device claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const first='MWP:TEST',second='MWP:SECOND',third='MWP:THIRD';
let remote={kind:'setting',name:'mw.watchlists.v1',tool:'',revision:3,content:{envelope:'keep',value:{active:'a',unknown:'keep',lists:[
  {id:'a',title:'第一组',symbols:[first],unknown:'keep-list'}, {id:'b',title:'第二组',symbols:[second]}
]}}},logged=false,conflict=false;
const writes=[],clients=new Set(),streams=new Set(),errors=[];let maxStreams=0;
const dist=path.resolve('dist');
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):{};
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/api/session')return logged?json({csrf:'test',subject:'admin'}):json({},401);
 if(url.pathname==='/api/login'){logged=true;return json({csrf:'test',subject:'admin'});}
 if(url.pathname==='/api/advanced-charts/preferences')return json([remote]);
 if(url.pathname==='/api/advanced-charts/preferences/save'){
  writes.push(body);
  if(conflict||body.revision!==remote.revision)return json({detail:'自选冲突'},409);
  remote={...remote,...body,revision:remote.revision+1};return json(remote);
 }
 if(url.pathname==='/api/market-data/series/page'){
  const query=url.searchParams.get('query');
  if(query==='old')return setTimeout(()=>json({items:[{ticker:first,symbol:'OLD-RESULT'}]}),700);
  return json({items:[{ticker:third,symbol:query==='new'?'NEW-RESULT':'THIRD',description:'真实身份测试 · 平台 · 测试来源'}],next_offset:null});
 }
 if(url.pathname==='/api/market-data/resolve')return json({id:body.instrument,source:'binance',basis:'last',frames:['M1','M5','H1'],precision:2});
 if(url.pathname==='/api/market-data/quotes')return json(body.symbols.map(n=>({n,s:'ok',v:{short_name:n.slice(4),description:'测试名称 · 平台 · 测试来源',lp:123.45,chp:1.2,fetch_status:'ok'}})));
 if(url.pathname==='/api/market-data/sparklines'){
  const left=Math.floor(Date.now()/86400000)*86400000;
  return json({as_of:Date.now(),items:body.items.map(item=>({ticker:item.ticker,revision:null,window_start:left,window_end:left+86400000,timeframe:'M1',
   points:[{time:left,price:'122',gap_before:false},{time:left+60000,price:'123',gap_before:false},{time:left+180000,price:'123.45',gap_before:true}],status:'partial',last_data_at:left+180000}))});
 }
 if(url.pathname==='/api/charts/stream/events'){
  clients.add(url.searchParams.get('client'));streams.add(res);maxStreams=Math.max(maxStreams,streams.size);
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');
  res.on('close',()=>streams.delete(res));return;
 }
 if(url.pathname.startsWith('/api/charts/stream/')){clients.add(body.client);return json({ok:true});}
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
 const context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true}),page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/');
  await page.getByLabel('密码',{exact:true}).fill('test');await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(2);
  await expect(page.locator('.mobile-watch-price').first()).toContainText('123.45');
  await expect(page.locator('.mobile-sse')).toContainText('SSE 已连接');
  await expect(page.locator('.mobile-sse')).toContainText('最近通信');
  await expect.poll(()=>page.locator('.mobile-spark path[stroke]').count()).toBe(4);
  for(const width of [375,412]){
   await page.setViewportSize({width,height:915});await page.evaluate(()=>document.documentElement.style.fontSize='150%');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'large watch text overflow');
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='100%');
  await page.screenshot({path:'/tmp/mw-android-personal-v205-watch.png'});
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();
  await page.getByRole('button',{name:'第一组',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(1);assert.equal(writes.length,0,'phone group selection never writes desktop active');
  await page.getByRole('button',{name:'管理自选',exact:true}).click();
  await page.getByLabel('分组名称',{exact:true}).first().fill('手机修改组名');
  remote.content.value.active='b';remote.revision++;
  await page.getByRole('button',{name:'保存分组',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);assert.equal(writes[0].content.value.active,'b');
  assert.equal(writes[0].content.value.unknown,'keep');assert.equal(writes[0].content.envelope,'keep');
  assert.equal(writes[0].content.value.lists[0].unknown,'keep-list');
  conflict=true;
  await page.getByLabel('分组名称',{exact:true}).first().fill('冲突输入保留');
  await page.getByRole('button',{name:'保存分组',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'尚未保存'})).toBeVisible();
  await expect(page.getByLabel('分组名称',{exact:true}).first()).toHaveValue('冲突输入保留');
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'关闭',exact:true}).click();
  conflict=false;
  await page.getByRole('button',{name:'搜索并添加品种',exact:true}).click();
  await expect(page.getByLabel('搜索代码或中文')).toBeVisible();
  await page.getByLabel('搜索代码或中文').fill('old');await page.waitForTimeout(300);
  await page.getByLabel('搜索代码或中文').fill('new');
  await expect(page.getByRole('button',{name:/NEW-RESULT/})).toBeVisible();await page.waitForTimeout(800);
  await expect(page.getByRole('button',{name:/OLD-RESULT/})).toHaveCount(0);
  await page.getByRole('button',{name:/NEW-RESULT/}).click();
  await expect(page.getByText('M1 · M5 · H1',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'加入自选',exact:true}).click();
  await expect(page.getByRole('button',{name:'已添加',exact:true})).toBeVisible();
  assert.equal(remote.content.value.active,'b');
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('link',{name:'自选',exact:true}).click();
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();await page.getByRole('button',{name:'全部自选',exact:true}).click();
  await expect(page.locator('.mobile-watch-row')).toHaveCount(3);
  assert.equal(clients.size,1,'one application market client');assert.equal(maxStreams,1,'only one SSE channel');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({evidence:'built mobile UI with API doubles',checks:['real transport heartbeat status','visible quote/spark rows and gaps','375/412 at 150% font','phone group selection isolated','latest desktop active and unknown fields retained','409 keeps input','late search discarded','actual supported periods shown','favorite add and shared refresh','one market client/SSE'],errors},null,2));
 }finally{for(const response of streams)response.end();await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
