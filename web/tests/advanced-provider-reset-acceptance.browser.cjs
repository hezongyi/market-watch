const {chromium}=require('@playwright/test');
const fs=require('fs'),assert=require('assert/strict');
const dir=process.env.NATIVE_RESET_EVIDENCE_DIR || '/home/quant/.local/state/mw-native-update-20261014/browser-acceptance';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();const events=[],acks=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().endsWith('/api/charts/stream/accept'))acks.push({at:Date.now(),status:r.status(),body:await r.json()});});
 await page.exposeFunction('record',v=>events.push(v));
 await page.addInitScript(()=>{const Base=EventSource;window.EventSource=class extends Base{constructor(url,options){super(url,options);this.addEventListener('message',e=>window.record({at:Date.now(),path:new URL(url,location.href).pathname,data:JSON.parse(e.data)}));}};});
 let result={passed:false};
 try{
  await page.goto('http://127.0.0.1:17443/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(dir+'/credentials.private.json')).password);await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('heading',{name:'让机会，主动找到你。'}).waitFor();
  await page.goto('http://127.0.0.1:17443/advanced-charts');await page.waitForSelector('iframe');
  let host;for(let i=0;i<100&&!host;i++){host=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:17444/'));if(!host)await page.waitForTimeout(200);}
  assert(host);await host.waitForFunction(()=>typeof widget!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:90000});
  await host.evaluate(()=>{window.nativeResets=[];const chart=widget.activeChart(),reset=chart.resetData.bind(chart);chart.resetData=(...a)=>{nativeResets.push(Date.now());return reset(...a);};});
  const csrf=(await (await page.request.get('http://127.0.0.1:17443/api/session')).json()).csrf;
  const control=async args=>{const r=await page.request.post('http://127.0.0.1:17443/api/reset-fixture/control',{headers:{'x-csrf-token':csrf},data:args});assert.equal(r.status(),200);return r.json();};
  const main=()=>events.filter(e=>e.path==='/api/charts/stream/events'&&e.data.identity?.kind==='bars');
  const wait=async(fn,label)=>{const until=Date.now()+15000;while(Date.now()<until){if(await fn())return;await page.waitForTimeout(100);}throw Error('timeout '+label);};
  await wait(()=>acks.some(x=>x.body.ok),'first native acceptance');
  const start=Date.now();let handoffs=0;
  for(const change of ['metadata','price','volume','metadata','price']){
   const prevAck=acks.length,prevBars=main().length;const target=await control({op:'handoff',change});
   await wait(()=>main().slice(prevBars).some(e=>e.data.type==='bars'&&e.data.bars.some(b=>b.start===target.last)),'new bar');
   await wait(()=>acks.length>prevAck&&acks.at(-1).body.ok,'handoff acknowledgement');
   const next=main().length;await control({op:'tail'});
   await wait(()=>main().length>next,'post handoff result');
   await page.waitForTimeout(200);handoffs++;
   assert.equal(main().filter(e=>e.at>=start&&e.data.type==='reset').length,0);
   assert.equal(await host.evaluate(()=>nativeResets.length),0);
  }
  const repairs=[];
  for(const spec of [{target:'previous',field:'close',value:'1.118'},{target:'older',field:'volume',value:'9'}]){
   const before=main().filter(e=>e.data.type==='reset').length;const n=await host.evaluate(()=>nativeResets.length);
   await control({op:'repair',...spec});
   await wait(()=>main().filter(e=>e.data.type==='reset').length>before,'genuine correction reset');
   await wait(()=>host.evaluate(n=>nativeResets.length>n,n),'native history reload');
   await host.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:30000});repairs.push(spec.target+':'+spec.field);
  }
  result={passed:true,environment:'Ubuntu isolated Docker with controlled supplier, PostgreSQL, built web and licensed native chart',normalHandoffs:handoffs,normalResets:0,genuineRepairs:repairs,genuineNativeResets:await host.evaluate(()=>nativeResets.length),acknowledgements:acks.length,ackFailures:acks.filter(x=>!x.body.ok).length,pageErrors:errors};assert.deepEqual(errors,[]);
 }catch(e){result.error=e.message;result.pageErrors=errors;console.error(e.message);await page.screenshot({path:dir+'/failure.private.png'});fs.writeFileSync(dir+'/failure-body.private.txt',await page.locator('body').innerText());process.exitCode=1;}
 finally{fs.writeFileSync(dir+'/browser-result.json',JSON.stringify(result,null,2));fs.writeFileSync(dir+'/events.private.json',JSON.stringify(events));await context.close();await browser.close();console.log(JSON.stringify(result));}
})().catch(e=>{console.error(e.message);process.exitCode=1});
