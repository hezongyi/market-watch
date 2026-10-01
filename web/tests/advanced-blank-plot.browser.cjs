// Observe real native empty-chart UI; optional public option probe, no vendor edits.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP='https://localhost:15453',CHART='https://127.0.0.1:15454';
const symbol=process.env.BLANK_SYMBOL||'OANDA:USD_SGD';
const output=process.env.BLANK_OUTPUT||'/tmp/mw-blank-plot.json';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});
 const errors=[],textSamples=[];let sampling=false,sampler;
 page.on('pageerror',error=>errors.push(error.message));
 if(process.env.BLANK_PUBLIC_PROBE)await page.addInitScript(({hide})=>{
  globalThis.translationCalls=[];
  addEventListener('DOMContentLoaded',()=>{
   if(!globalThis.TradingView?.widget)return;
   const Original=TradingView.widget;
   TradingView.widget=new Proxy(Original,{construct(target,args){
    args[0].custom_translate_function=(original,singular,translated)=>{
     translationCalls.push({original,singular,translated});
     return hide&&original==='No data'?'':null;
    };
    if(hide)args[0].loading_screen={foregroundColor:'transparent',backgroundColor:'transparent'};
    return Reflect.construct(target,args,target);
   }});
  });
 },{hide:process.env.BLANK_PUBLIC_PROBE==='hide'});
 async function api(path,body){return page.evaluate(async({path,body})=>{
  const {csrf}=await(await fetch('/api/session')).json();
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw Error(path+' '+response.status);return response.json();
 },{path,body});}
 const result={passed:false,symbol,errors,text_samples:textSamples};
 try{
  await page.goto(APP+'/');await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../../market-watch/artifacts/local-credentials.json')).password);
  await page.getByRole('button',{name:'登录工作台'}).click();await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
  const before=await api('market-data/history/plans');assert.ok(!before.some(row=>row.instrument===symbol),'fixture must be genuinely unmaintained');
  const workspace=await api('advanced-charts/workspaces',{name:'空图公开配置验证'});
  await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,revision:workspace.revision,
   document:{engine:'tv31',schemaVersion:1,symbol,series_kind:'managed',interval:'5'}});
  sampling=true;
  sampler=(async()=>{
   while(sampling){
    const host=page.frames().find(f=>f.url().startsWith(CHART+'/'));
    const native=host?.childFrames()[0];
    if(native){
     const body=await native.locator('body').innerText({timeout:300}).catch(()=>null);
     if(body!==null)textSamples.push({at:Date.now(),text:body});
    }
    await page.waitForTimeout(100).catch(()=>{});
   }
  })();
  await page.goto(APP+'/advanced-charts');await page.frameLocator('iframe').locator('#chart').waitFor();
  const frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await page.getByRole('dialog',{name:/维护自建行情/}).waitFor();
  await page.getByRole('button',{name:'暂不维护'}).click();
  await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready);
  await page.waitForTimeout(1000);
  const native=page.frames().find(f=>f.parentFrame()===frame);assert.ok(native);
  result.native_text=await native.locator('body').innerText();
  result.host_text=await frame.locator('body').innerText();
  result.translation_calls=await frame.evaluate(()=>globalThis.translationCalls||[]);
  const after=await api('market-data/history/plans');assert.deepEqual(after.map(row=>row.instrument),before.map(row=>row.instrument));
  assert.ok(!/正在补数|已显示\d+根|历史后台准备中/.test(result.host_text));
  await page.screenshot({path:output.replace(/\.json$/,'.png'),fullPage:true});
  if(process.env.BLANK_ASSERT_EMPTY==='1'){
   assert.ok(!/暂无数据|无数据|No data|正在加载|Loading/.test(result.native_text),'plot has no native no-data or loading label');
   assert.ok(textSamples.length,'transient native UI was observed');
   assert.ok(textSamples.every(sample=>!/暂无数据|无数据|No data|正在加载|Loading/.test(sample.text)),
    'observed initialization and refused-chart UI have no native no-data/loading text');
  }
  assert.deepEqual(errors,[]);result.passed=true;
 }catch(error){result.error=String(error);throw error;}
 finally{sampling=false;await sampler;fs.writeFileSync(output,JSON.stringify(result,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
