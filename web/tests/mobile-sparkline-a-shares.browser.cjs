// Built UI, explicit HTTP fixtures; no supplier writes or host clock changes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const{chromium,expect}=require('@playwright/test');
const output=process.env.MOBILE_ASHARE_OUTPUT||'/tmp/mw-ashare-sparkline-20261114';fs.mkdirSync(output,{recursive:true});
const minute=60000,day=86400000,time=s=>Date.parse('2026-11-13T'+s+':00+08:00');
const segments=[{start:time('09:30'),end:time('11:30')},{start:time('13:00'),end:time('15:00')}];
const ids=['MWP:TENCENT-NATIVE:SSE:688256','MWP:SINA-NATIVE:SZSE:000001','MWP:NVDA'];
let phase='legacy',now=time('16:00');const streams=new Set(),errors=[];
const prefs={kind:'setting',name:'mw.watchlists.v1',tool:'',revision:1,content:{value:{active:'a',lists:[{id:'a',title:'验收',symbols:ids}]}}};
function item(ticker){
 const stock=ticker!==ids[2],base={ticker,revision:null,timeframe:'M1',status:'partial',reason:null,reference_times:[],
  window_start:Date.parse('2026-11-13T00:00:00Z'),window_end:Date.parse('2026-11-14T00:00:00Z'),valid_until:now+14*day,next_check_at:now+minute,
  session:{date:'2026-11-13',previous:phase==='previous'},display_state:phase==='previous'?'previous':'current',previous_close_price:stock?'1000':'160'};
 if(!stock)return{...base,window_start:time('09:30')-day,window_end:time('16:00')-day,session:{date:'2026-11-12',previous:true},display_state:'previous',
  points:Array.from({length:79},(_,i)=>({time:time('09:30')-day+i*5*minute,price:String(160+Math.sin(i/8)*2),gap_before:false}))};
 let lastEnd;const points=[];
 for(const segment of segments)for(let close=segment.start;close<=segment.end;close+=minute){
  if(close>now||close>time('10:10')&&close<time('10:20'))continue;const start=close-minute,index=points.length;
  points.push({time:start,display_time:close,price:String(1000+Math.sin(index/20)*12+index/30),gap_before:lastEnd!==undefined&&lastEnd!==start});lastEnd=close;
 }
 return phase==='legacy'?{...base,points:points.map(({display_time,...p})=>p)}:{...base,display_segments:segments,points};
}
const dist=path.resolve('dist'),server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
 const json=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(url.pathname==='/api/session')return json({csrf:'fixture',subject:'admin'});
 if(url.pathname==='/api/advanced-charts/preferences')return json([prefs]);
 if(url.pathname==='/api/market-data/quotes')return json(body.symbols.map(n=>({n,s:'ok',v:{short_name:n===ids[0]?'688256':n===ids[1]?'000001':'NVDA',
  description:n===ids[0]?'688256 · 寒武纪 · 原生 · 腾讯（AKShare）':n===ids[1]?'000001 · 平安银行 · 原生 · 新浪（AKShare）':'NVDA · 英伟达 · 原生 · Yahoo Finance',lp:n===ids[2]?162.85:1005,chp:.5,fetch_status:'ok'}})));
 if(url.pathname==='/api/market-data/sparklines')return json({as_of:now,items:body.items.map(({ticker})=>item(ticker))});
 if(url.pathname==='/api/market-data/sparklines/prepare')return json({as_of:now,items:[item(body.ticker)],preparation:'ready'});
 if(url.pathname==='/api/charts/stream/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
 if(url.pathname.startsWith('/api/charts/stream/'))return json({ok:true});
 if(url.pathname==='/api/health')return json({});
 if(url.pathname.startsWith('/api/'))return json({detail:'fixture unavailable'},404);
 let file=path.join(dist,decodeURIComponent(url.pathname));if(!file.startsWith(dist+path.sep))return json({},404);
 if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(dist,'m/index.html');
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch();let baselineUS,baselineGeometry;const proof={checks:[],screenshots:[]};
 try{
  for(const[name,clock,ratio]of[['legacy','16:00',null],['morning','10:30',.25],['lunch','12:00',.5],['afternoon','14:00',.75],['full','16:00',1],['previous','16:00',1]]){
   phase=name;now=time(clock)+(name==='previous'?day:0);const context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
   try{
    page.on('pageerror',e=>errors.push(e.message));await page.clock.setFixedTime(new Date(now));await page.goto('http://127.0.0.1:'+server.address().port+'/m/watch');
    const rows=page.locator('.mobile-watch-row');await expect(rows).toHaveCount(3);await expect(rows.first().locator('path[stroke]')).toHaveCount(['morning','lunch'].includes(name)?2:3);
    await expect.poll(()=>rows.first().locator('.mobile-spark svg').evaluate(el=>el.viewBox.baseVal.width)).toBeGreaterThan(100);
    const position=await rows.first().locator('.mobile-spark svg').evaluate(el=>{const p=[...el.querySelectorAll('path[stroke]')].at(-1),xs=[...p.getAttribute('d').matchAll(/[ML]([-\d.]+),/g)].map(m=>Number(m[1]));return xs.at(-1)/el.viewBox.baseVal.width;});
    if(ratio!==null)assert(Math.abs(position-ratio)<.001,name+' retains future blank space');else assert(position<.3,'legacy full-day curve occupies less than 30%');
    const us=await rows.nth(2).locator('.mobile-spark svg').innerHTML();
    const geometry=await rows.first().evaluate(el=>({height:el.getBoundingClientRect().height,left:el.querySelector('.symbol-info').getBoundingClientRect().width,right:el.querySelector('.mobile-watch-price').getBoundingClientRect().width,spark:el.querySelector('.mobile-spark').getBoundingClientRect().width}));
    if(name==='legacy'){baselineUS=us;baselineGeometry=geometry;}else{assert.equal(us,baselineUS,'US rendering unchanged');assert.deepEqual(geometry,baselineGeometry,'geometry unchanged');}
    if(name==='previous')await expect(rows.first().locator('.mobile-spark')).toHaveAttribute('data-previous-session','true');
    const screenshot=name+'.png';await page.screenshot({path:output+'/'+screenshot});proof.screenshots.push(screenshot);proof.checks.push({phase:name,end_ratio:position});
    if(name==='full')for(const width of[375,412])for(const theme of['light','dark'])for(const font of[14,21]){
     await page.setViewportSize({width,height:915});await page.evaluate(({theme,font})=>{document.querySelector('.mobile-app').dataset.theme=theme;document.documentElement.style.fontSize=font+'px'},{theme,font});await page.waitForTimeout(120);
     assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow');const file=`full-${width}-${theme}-${font}.png`;await page.screenshot({path:output+'/'+file});proof.screenshots.push(file);
    }
   }finally{await context.close();}
  }
  assert.deepEqual(errors,[]);proof.errors=errors;proof.passed=true;fs.writeFileSync(output+'/proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
 }finally{await browser.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
