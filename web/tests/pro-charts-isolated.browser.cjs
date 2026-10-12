// Ubuntu-only full-stack product flows, with synthetic provider I/O fixture.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const base='http://localhost:19997',chart='http://localhost:19998';
const output=path.resolve(__dirname,'../../docs/verification/pro-charts-20261011/browser-full-stack.json');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),report={environment:'Ubuntu mw-pro-charts-20261011',supply:'synthetic task-only; real API/PostgreSQL/licensed engine',cases:[],errors:[],http:[]};
 page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('requestfailed',request=>{report.http.push({failed:true,path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
 page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/')&&!r.url().endsWith('/api/session'))report.http.push({status:r.status(),path:new URL(r.url()).pathname,body:(await r.text()).slice(0,200)});});
 const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
 try {
  await page.goto(base+'/');await page.getByLabel('管理员密码').fill(fs.readFileSync('/tmp/mw-pro-charts-20261011/login-password','utf8').trim());
  const logged=page.waitForResponse(r=>r.url().endsWith('/api/login'));await page.getByRole('button',{name:'登录工作台'}).click();assert.equal((await logged).status(),200);
  await page.waitForTimeout(500);await page.goto(base+'/advanced-charts');
  await page.locator('iframe[title="专业图表工作区"]').waitFor();
  const host=page.frames().find(f=>f.url().startsWith(chart+'/?'));await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:30000});
  const ui=host.childFrames()[0];
  await host.evaluate(()=>{globalThis.acceptanceLoads=[];const original=feed.getBars;feed.getBars=async(s,res,p,cb,err)=>{
    const record={ticker:s.ticker,res,count:p.countBack,from:p.from,to:p.to};acceptanceLoads.push(record);
    return original(s,res,p,(bars,meta)=>{record.rows=bars.length;record.first=bars[0]?.time;record.last=bars.at(-1)?.time;record.meta=meta;record.accepted=cb(bars,meta);return record.accepted},e=>{record.error=String(e);record.code=e.code;return err(e)});
  }});
  const state=()=>host.evaluate(()=>({layout:widget.layout(),charts:Array.from({length:widget.chartsCount()},(_,i)=>{const c=widget.chart(i);return {index:i,symbol:c.symbol(),resolution:c.resolution(),ready:c.dataReady(),range:c.getVisibleRange()};})}));
  await host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('2-3');});
  await host.waitForFunction(()=>widget.chartsCount()===5);
  console.log('FIVE_LAYOUT');const composite='MWC:85EB595180ED9491E1D5E3064ACA750933A9FFD787B840D1357645FBBECA3B8A';
  await host.evaluate(async symbol=>{for(let i=0;i<5;i++){const c=widget.chart(i),res=['60','5','1W','1D','240'][i];if(!MWSeries.same(c.symbol(),symbol))await c.setSymbol(symbol,{doNotActivateChart:true});if(c.resolution()!==res)await c.setResolution(res,{doNotActivateChart:true});}widget.symbolSync().setValue(true);},composite);
  await host.waitForFunction(()=>Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:30000});
  console.log('FIVE_READY');const sequence=[{step:'five-initial',state:await state()}];
  await ui.getByRole('button',{name:'布局设置',exact:true}).click();await ui.locator('[data-name="layouts-list"] [aria-label="s"]').click();
  await host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady());
  console.log('SINGLE_READY');for(const symbol of ['BTCUSDT','XAUUSD','AAPL','EURUSD']){
    await ui.getByRole('button',{name:'商品代码搜索',exact:true}).click();const dialog=ui.locator('[data-name="symbol-search-items-dialog"]');await dialog.getByRole('searchbox').fill(symbol);
    const row=symbol==='EURUSD'?dialog.locator('[data-symbol-name^="MWC:"]'):symbol==='AAPL'?dialog.locator('[data-symbol-name^="MWP:YAHOO:"]'):dialog.locator('[data-symbol-name^="MWP:"]');
    await expect(row.first()).toBeVisible({timeout:30000});await row.first().click();
    await host.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:35000});sequence.push({step:symbol,state:await state()});console.log('SWITCH',symbol);
  }
  await ui.getByRole('button',{name:'布局设置',exact:true}).click();await ui.locator('[data-name="layouts-list"] [aria-label="2-3"]').click();
  await host.waitForFunction(()=>widget.chartsCount()===5&&Array.from({length:5},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:35000});
  const final=await state();assert.ok(final.charts.every(c=>c.symbol===composite&&c.range.to>c.range.from));assert.deepEqual(final.charts.map(c=>c.resolution),['60','5','1W','1D','240']);
  report.cases.push({name:'F1 full five-to-single BTCUSDT XAUUSD Yahoo-AAPL composite-EURUSD five',passed:true,sequence,final});save();
  console.log(JSON.stringify(report.cases));
  assert.deepEqual(report.errors,[]);report.passed=true;save();
 }catch(e){report.failure=e.message;const host=page.frames().find(f=>f.url().startsWith(chart+'/?'));report.lastState=await host?.evaluate(()=>({ready,loading,loads:acceptanceLoads,charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),ready:widget.chart(i).dataReady()}))})).catch(()=>null);report.ui=await host?.childFrames()[0]?.locator('body').innerText();save();throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
