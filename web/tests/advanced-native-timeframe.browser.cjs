// Public timeframe feasibility matrix. No application backend or saved workspace.
const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const report=[];
 const variants=[{}, {initialTimeframe:'1'}, {intervalHook:'1'},
  {visibleCount:'1'}, {initialTimeframe:'1',visibleCount:'1'}, {intervalHook:'1',visibleCount:'1'}];
 try{for(const flags of variants){
  const name=Object.keys(flags).join('+')||'baseline';
  const row={name,flags,errors:[]};report.push(row);
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>row.errors.push(e.message));
  page.on('requestfailed',r=>row.errors.push(r.url()+': '+r.failure()?.errorText));
  await page.clock.setFixedTime(new Date('2026-09-29T00:00:00Z'));
  await page.route('**/native-history-probe*',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync('tests/fixtures/native-history.html','utf8')}));
  await page.route('**/api/**',r=>{row.errors.push('Unexpected API request');return r.abort();});
  try{
   await page.goto('http://127.0.0.1:15187/native-history-probe?'+new URLSearchParams({initialCount:'20',...flags}));
   await page.waitForFunction(()=>typeof ready!=='undefined'&&ready&&probe.widget.activeChart().dataReady());
   if(flags.intervalHook) await page.evaluate(()=>probe.widget.activeChart().setResolution('1D'));
   await page.waitForTimeout(400);
   row.initial=await page.evaluate(()=>({state:probe.snapshot(),events:[...probe.log]}));
   await page.screenshot({path:'/tmp/mw-native-timeframe-'+name+'.png'});
   row.restoreStart=await page.evaluate(()=>probe.log.length);
   await page.evaluate(()=>{const s=probe.widget.activeChart().getTimeScale();s.setBarSpacing(6);s.setRightOffset(10);});
   await page.waitForTimeout(250);
   row.restored=await page.evaluate(start=>({state:probe.snapshot(),events:probe.log.slice(start)}),row.restoreStart);
   const start=await page.evaluate(()=>probe.log.length);
   await page.mouse.move(250,250);await page.mouse.down();await page.mouse.move(1000,250,{steps:20});await page.mouse.up();
   await page.waitForTimeout(200);
   row.drag=await page.evaluate(start=>({state:probe.snapshot(),events:probe.log.slice(start)}),start);
   const requests=row.initial.events.filter(e=>e.kind==='request'&&e.value.r==='1D');
   row.checks={
    partialDisplayed:row.initial.state.ready&&!!row.initial.state.bars,
    requestFitsAvailable:requests.length>0&&requests.every(e=>e.value.p.countBack<=20),
    preservesSpacing:Math.abs(row.initial.state.spacing-6)<0.01,
    noFalseEnd:[...row.initial.events,...row.restored.events].filter(e=>e.kind==='request'&&e.value.r==='1D').every(e=>!e.value.noData),
    dragRequests:row.drag.events.some(e=>e.kind==='request'&&e.value.r==='1D'),
    noErrors:row.errors.length===0
   };
   row.pass=Object.values(row.checks).every(Boolean);
   console.log(JSON.stringify({name,checks:row.checks,first:requests[0]?.value.p,spacing:row.initial.state.spacing,restored:row.restored.state.spacing}));
  }catch(e){row.errors.push(e.message);row.pass=false;console.log('ERROR',name,e.message);}
  finally{await page.close();}
 }}finally{fs.writeFileSync('/tmp/mw-native-timeframe.json',JSON.stringify(report,null,2));await browser.close();}
 // Red is retained when no variant satisfies the actual combined requirement.
 assert.ok(report.some(r=>r.pass),'No public timeframe variant satisfies cold display, stable spacing and ongoing pagination together');
})().catch(e=>{console.error(e.message);process.exitCode=1});
