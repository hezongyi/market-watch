// Independent contract probe. Run from web/. Serves a test-only HTML response
// from the local chart origin; no application API or database is accessed.
const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[],report={mode:process.env.NATIVE_MODE||'boundary',visibleReset:!!process.env.NATIVE_VISIBLE_RESET,cases:[],errors,requests:[]};
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')console.log('BROWSER',m.type(),m.text());});
 page.on('requestfailed',r=>{errors.push('NETWORK '+r.url());console.log('NETWORK',r.url(),r.failure());});
 await page.clock.setFixedTime(new Date('2026-09-29T00:00:00Z'));
 await page.route('**/native-history-probe*',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync('tests/fixtures/native-history.html','utf8')}));
 await page.route('**/api/**',route=>{errors.push('Unexpected backend request');return route.abort();});
 async function step(name,run){try{const evidence=await run();report.cases.push({name,pass:true,evidence});console.log('PASS',name,JSON.stringify(evidence));}
 catch(e){report.cases.push({name,pass:false,error:e.message});console.log('FAIL',name,e.message);}}
 try{
 await page.goto('http://127.0.0.1:15187/native-history-probe'+'?'+new URLSearchParams({...(process.env.NATIVE_VISIBLE_RESET?{visibleReset:'1'}:{}),mode:process.env.NATIVE_MODE||'boundary'}));
 await page.waitForFunction(()=>typeof ready!=='undefined'&&ready);
 await page.waitForTimeout(2500);
 await step('empty initial completes',async()=>{const s=await page.evaluate(()=>probe.snapshot());assert.equal(s.bars,null);assert.ok(await page.evaluate(()=>probe.log.some(e=>e.kind==='loaded')),'empty history must finish a data-loaded cycle');return s;});
 await step('20 partial bars render',async()=>{const s=await page.evaluate(()=>probe.supply(20));assert.ok(s.after.ready&&s.after.bars);return s;});
 await step('80 bars preserve latest scale',async()=>{
 const s=await page.evaluate(()=>probe.supply(80));assert.equal(s.after.spacing,s.before.spacing);
 assert.equal(s.after.offset,s.before.offset);assert.ok(s.after.bars.from<s.before.bars.from);return s;});
 await page.screenshot({path:'/tmp/mw-native-partial-80.png'});
 await step('explicit date jump before local edge',async()=>{
 const x=await page.evaluate(async()=>{
  const target={from:probe.end/1000-110*86400,to:probe.end/1000-90*86400},start=probe.log.length;
  await probe.widget.activeChart().setVisibleRange(target,{rejectByTimeout:2000});await new Promise(r=>setTimeout(r,100));
  return {target,actual:probe.snapshot(),events:probe.log.slice(start)};
 });
 report.dateJump=x;
 assert.ok(x.events.some(e=>e.kind==='request'&&e.value.p.to<=x.target.to)||
 x.events.some(e=>e.kind==='interval'&&e.value.t.timeframe?.from===x.target.from),
 'Native must request missing dates or expose the intended dates through a public event');return x;});
 await step('native date dialog exposes missing target',async()=>{
 await page.mouse.click(700,300);await page.keyboard.press('Alt+g');
 const ui=page.frames().find(f=>f.name().startsWith('tradingview_'));
 const input=ui.getByPlaceholder('YYYY-MM-DD');await input.waitFor();
 const start=await page.evaluate(()=>probe.log.length);
 await input.fill('2026-06-01');await ui.locator('button[name=submit]').click();
 await page.waitForTimeout(300);
 const x=await page.evaluate(start=>({state:probe.snapshot(),events:probe.log.slice(start)}),start);
 report.nativeDate=x;
 assert.ok(x.events.some(e=>e.kind==='request'&&e.value.p.to<=Date.parse('2026-06-02')/1000)||
 x.events.some(e=>e.kind==='interval'&&JSON.stringify(e.value).includes(String(Date.parse('2026-06-01')/1000))),
 'Native date dialog must expose intended date or request it');return x;
 });
 await page.keyboard.press('Escape');
 await step('mouse drag can request before local edge',async()=>{
 await page.evaluate(()=>{const s=probe.widget.activeChart().getTimeScale();s.setBarSpacing(6);s.setRightOffset(10);});
 await page.waitForTimeout(100);
 const start=await page.evaluate(()=>probe.log.length);
 await page.mouse.move(250,250);await page.mouse.down();await page.mouse.move(1000,250,{steps:20});await page.mouse.up();
 await page.waitForTimeout(150);
 const x=await page.evaluate(start=>({state:probe.snapshot(),events:probe.log.slice(start)}),start);
 report.drag=x;
 assert.ok(x.events.some(e=>e.kind==='request'),'dragging beyond local history should issue a data request');return x;
 });
 await step('switch to warm M5 while D1 incomplete',async()=>{
 const s=await page.evaluate(async()=>{const start=performance.now();await probe.widget.activeChart().setResolution('5');
 return {elapsed:performance.now()-start,...probe.snapshot()};});assert.equal(s.r,'5');assert.ok(s.ready&&s.bars);return s;});
 await step('return D1 and fill screen',async()=>{
 await page.evaluate(()=>probe.widget.activeChart().setResolution('1D'));
 const s=await page.evaluate(()=>probe.supply(400));assert.ok(s.after.ready&&s.after.bars);return s;});
 await step('positive control: available older history is requested',async()=>{
 const x=await page.evaluate(async()=>{
  const target={from:probe.end/1000-380*86400,to:probe.end/1000-350*86400},start=probe.log.length;
  await probe.widget.activeChart().setVisibleRange(target,{rejectByTimeout:2000});
  return {target,state:probe.snapshot(),events:probe.log.slice(start)};
 });
 assert.deepEqual(x.state.range,x.target);assert.ok(x.events.some(e=>e.kind==='request'));
 return x;
 });
 await step('historical viewport survives growth',async()=>{
 const s=await page.evaluate(async()=>{await probe.widget.activeChart().setVisibleRange({from:probe.end/1000-150*86400,to:probe.end/1000-120*86400});
 return probe.supply(600);});assert.deepEqual(s.after.range,s.before.range);assert.equal(s.after.spacing,s.before.spacing);return s;});
 await page.screenshot({path:'/tmp/mw-native-history-contract.png'});
 report.requests=await page.evaluate(()=>probe.log);
 report.summary={passed:report.cases.filter(c=>c.pass).length,failed:report.cases.filter(c=>!c.pass).map(c=>c.name),requests:report.requests.filter(e=>e.kind==='request').length};
 }finally{fs.writeFileSync('/tmp/mw-native-history-contract.json',JSON.stringify(report,null,2));await browser.close();}
 if(errors.length||report.cases.some(c=>!c.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
