state.accountOandaPage=state.accountPage;state.accountOandaChart=state.accountChart;state.accountOandaNative=state.accountNative;
await state.accountChart.evaluate(()=>{for(const [owner,key,orig] of accountProbe.originals)owner[key]=orig;removeEventListener('message',accountProbe.listener);});
state.accountPage=await context.newPage();await state.accountPage.goto('https://127.0.0.1:18474/advanced-charts');await state.accountPage.waitForTimeout(1300);
state.accountChart=state.accountPage.frames().find(f=>f.url().startsWith('https://127.0.0.1:17475/'));
await state.accountChart.waitForFunction(()=>typeof widget!=='undefined'&&ready&&!loading,{},{timeout:15000});
state.accountNative=state.accountPage.frames().find(f=>f.url().startsWith('blob:'));
await state.accountChart.evaluate(()=>{for(const s of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(s.id);widget.activeChart().setSymbol('MWP:DUKA:055C2FBF27268A4C6D76ADC491E51CD3');});
await state.accountChart.waitForFunction(()=>!loading&&widget.activeChart().symbol().startsWith('MWP:DUKA:')&&widget.activeChart().dataReady(),{},{timeout:15000});
await state.accountChart.evaluate(()=>{
 const c=widget.activeChart();globalThis.accountProbe={events:[],messages:[],originals:[]};accountProbe.listener=e=>{const m=e.data;if(m?.type!=='market-event')return;const v=m.event||{};accountProbe.messages.push({at:Date.now(),type:v.type,reason:v.reason,bars:v.bars?.length});};addEventListener('message',accountProbe.listener);
 for(const [owner,key] of [[widget,'resetCache'],[c,'resetData']]){const orig=owner[key];accountProbe.originals.push([owner,key,orig]);owner[key]=function(...a){accountProbe.events.push({at:Date.now(),call:key});return orig.apply(this,a);};}c.setResolution('15');
});
state.accountRun='dukascopy';state.accountStudy=null;console.log({stage:'duka-ready'});
