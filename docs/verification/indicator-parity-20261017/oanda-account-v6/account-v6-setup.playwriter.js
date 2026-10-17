state.accountPage=await context.newPage();
await state.accountPage.goto('https://127.0.0.1:18474/advanced-charts');
await state.accountPage.waitForTimeout(1300);
state.accountChart=state.accountPage.frames().find(f=>f.url().startsWith('https://127.0.0.1:17475/'));
await state.accountChart.waitForFunction(()=>typeof widget!=='undefined'&&ready&&!loading,{},{timeout:15000});
state.accountNative=state.accountPage.frames().find(f=>f.url().startsWith('blob:'));
await state.accountChart.evaluate(()=>{
 for(const s of widget.activeChart().getAllStudies())widget.activeChart().removeEntity(s.id);
 globalThis.accountProbe={events:[],messages:[],originals:[]};
 accountProbe.listener=e=>{const m=e.data;if(m?.type!=='market-event')return;const v=m.event||{};accountProbe.messages.push({at:Date.now(),type:v.type,reason:v.reason,listener:v.listener,generation:v.generation,bars:v.bars?.length});};
 addEventListener('message',accountProbe.listener);
 const c=widget.activeChart();for(const [owner,key] of [[widget,'resetCache'],[c,'resetData']]){const orig=owner[key];accountProbe.originals.push([owner,key,orig]);owner[key]=function(...a){accountProbe.events.push({at:Date.now(),call:key,symbol:c.symbol(),res:c.resolution()});return orig.apply(this,a);};}
 c.setSymbol('MWP:OANDA:GBP_JPY');
});
await state.accountChart.waitForFunction(()=>!loading&&widget.activeChart().symbol()==='MWP:OANDA:GBP_JPY'&&widget.activeChart()._chartWidget.model().model().mainSeries().data().size()>0,{},{timeout:15000});
await state.accountChart.evaluate(()=>widget.activeChart().setResolution('15'));
console.log({stage:'setup',chart:await state.accountChart.evaluate(()=>({symbol:widget.activeChart().symbol(),res:widget.activeChart().resolution(),bars:widget.activeChart()._chartWidget.model().model().mainSeries().data().size()}))});
