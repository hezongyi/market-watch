// Actual task-owned API/PG/worker/native chart; synthetic inputs, no HTTP replacement.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const base='http://127.0.0.1:20271',origin='http://127.0.0.1:20272';
const privateDir='/tmp/mw-pending-fixes-20261013-private';
function mutate(action,at){
 const command=`docker compose --env-file ${privateDir}/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml -f ${privateDir}/indicator-fixture.override.yaml run --rm --no-deps seed python /fixture/production_pending_indicator_fixture.py ${action}${at?' '+at:''}`;
 execFileSync('sg',['docker','-c',command],{stdio:'pipe',timeout:30000});
}
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],resets=[];
 page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(base+'/advanced-charts');
  await page.getByLabel('管理员密码').fill(fs.readFileSync(privateDir+'/password','utf8'));
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/?')),{timeout:30000}).toBe(true);
  const host=page.frames().find(f=>f.url().startsWith(origin+'/?'));
  await host.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  await host.evaluate(()=>widget.setLayout('1'));
  await host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady());
  await host.evaluate(()=>new Promise(resolve=>widget.activeChart().setSymbol('BTCUSDT',resolve)));
  await host.evaluate(()=>new Promise(resolve=>widget.activeChart().setResolution('1',resolve)));
  await host.evaluate(async()=>{
   const chart=widget.activeChart();for(const s of chart.getAllStudies())chart.removeEntity(s.id);
   globalThis.correctionIds=[];
   correctionIds.push(await chart.createStudy('守望 Python LWMA',false,false,{period:5}));
   correctionIds.push(await chart.createStudy('守望 Python EMA',false,false,{period:300}));
   globalThis.correctionResets=[];
   addEventListener('message',e=>{if(e.data?.type==='market-event'&&e.data.event?.type==='reset')correctionResets.push(e.data.event.reason);});
  });
  const snapshot=()=>host.evaluate(()=>{
   const chart=widget.activeChart(),key=chart.symbol()+'|1';
   return {binding:indicatorBindings.get(key),demand:indicatorDependencyOrigins.get(key),
    studies:correctionIds.map(id=>{const study=chart._chartWidget.model().model().dataSourceForId(id);
     return {count:study.data().size(),last:study.data().last()?.value[1]};}),resets:correctionResets};
  });
  await expect.poll(async()=>(await snapshot()).studies.every(s=>s.count>100),{timeout:60000}).toBe(true);
  await expect.poll(async()=>!!(await snapshot()).binding.dependencyRevision,{timeout:15000}).toBe(true);
  const initial=await snapshot();assert.equal(initial.studies[0].last,10);
  mutate('tail');
  await expect.poll(async()=>(await snapshot()).studies[0].last,{timeout:30000}).toBeGreaterThan(10);
  const afterTail=await snapshot();
  assert.equal(afterTail.binding.inputRevision,initial.binding.inputRevision);
  const prefix=initial.binding.calculationStart;
  assert.ok(prefix<initial.binding.firstStart,'repair must precede loaded price window');
  mutate('prefix',prefix);
  await expect.poll(async()=>(await snapshot()).binding.correctionVersion,{timeout:30000}).toBeGreaterThan(afterTail.binding.correctionVersion);
  await expect.poll(async()=>(await snapshot()).studies[1].last,{timeout:30000}).not.toBe(afterTail.studies[1].last);
  const corrected=await snapshot();assert.deepEqual(corrected.resets,[],'prefix-only repair must not reset price chart');
  const expected=await host.evaluate(async()=>{
   const chart=widget.activeChart(),binding=indicatorBindings.get(chart.symbol()+'|1');
   const page=await query(chart.symbol(),'1',{before:binding.lastStart+1,limit:2,
    indicators:[{name:'EMA',params:{period:300}},{name:'LWMA',params:{period:5}}],provisional:true});
   return page.indicators.map(i=>({name:i.name,last:i.series[0].values.at(-1).value}));
  });
  for(const [i,name] of ['LWMA','EMA'].entries())assert.equal(corrected.studies[i].last,expected.find(x=>x.name===name).last);
  assert.deepEqual(errors,[]);
  const report={passed:true,scope:'Ubuntu task-local synthetic published M1 inputs, actual HTTP/PG/shared stream worker/Python/native chart',
   checks:['same-time tail update without confirmed input revision','recursive prefix repair outside loaded window','Python numeric agreement after repair','no price chart reset'],errors};
  fs.writeFileSync(privateDir+'/pr55-indicator-corrections.json',JSON.stringify(report,null,2));
  console.log('PASS actual indicator corrections '+JSON.stringify(report));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
