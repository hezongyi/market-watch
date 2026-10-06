// Real provider bars and painted exterior labels; no price-axis or layout changes.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP=process.env.RANGE_APP||'https://192.168.7.232:16843',CHART=process.env.RANGE_CHART||'https://192.168.7.232:16844';
const OUT=process.env.RANGE_OUTPUT||'/tmp/mw-range-rectangle/geometry.json';
const report={at:new Date().toISOString(),APP,CHART,cases:[],errors:[]};
(async()=>{const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});try{
const f=await require('./fixtures/bar-range-acceptance.cjs')({browser:{newContext:options=>browser.newContext({...options,deviceScaleFactor:2})},report,APP,CHART}),{host,page}=f;
const geometry=()=>host.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>{const c=widget.chart(i),cw=c._chartWidget,m=cw.model().model(),p=cw.paneWidgets().find(p=>p.containsMainSeries()),s=m.mainSeries(),scale=s.priceScale(),value=s.firstValue(),ts=m.timeScale(),r=p.canvasElement().getBoundingClientRect(),source=MWBarRangeMapping.diagnostics().source;
const candles=[];for(let n=Math.floor(ts.coordinateToFloatIndex(0))-1;n<=Math.ceil(ts.coordinateToFloatIndex(ts.width()))+1;n++){const v=s.bars().valueAt(n);if(!v)continue;const x=ts.indexToCoordinate(n),a=scale.priceToCoordinate(v[2],value),b=scale.priceToCoordinate(v[3],value);candles.push({time:c._convertIndexToPublicTime(n)*1000,x,high:v[2],low:v[3],left:x-Math.max(1,ts.barSpacing()*.4),right:x+Math.max(1,ts.barSpacing()*.4),top:Math.min(a,b),bottom:Math.max(a,b)})}
const legend=p._legendWidget.getElement().getBoundingClientRect();
return {i,pane:{x:r.x,y:r.y,width:r.width,height:r.height},source,labels:MWBarRangeMapping.labels(c),candles,legend:{left:legend.left-r.left,right:legend.right-r.left,top:legend.top-r.top,bottom:legend.bottom-r.top},oldRails:cw._parent.querySelectorAll('[data-name="mw-range-price-rail"]').length,range:c.getVisibleRange(),spacing:ts.barSpacing(),price: c.getPanes().find(p=>p.hasMainSeries()).getMainSourcePriceScale().getVisiblePriceRange(),shapeCount:c.getAllShapes().length};}));
const overlaps=(a,b)=>a.x<b.right+2&&a.x+a.width>b.left-2&&a.y<b.bottom+2&&a.y+a.height>b.top-2;
// Use a completed real hour. The current live bar may legitimately have no
// room for either label, which is checked separately by occupied diagnostics.
const hoverSource=async()=>{
  await page.mouse.move(10,10);const box=await f.box(0);
  const x=await host.evaluate(()=>{const m=widget.chart(0)._chartWidget.model().model(),ts=m.timeScale();return ts.indexToCoordinate(m.mainSeries().bars().lastIndex()-1)});
  assert.ok(x>=0&&x<=box.width,'completed source bar is visible');
  await page.mouse.move(box.x+x,box.y+box.height*.55);await page.waitForTimeout(200);
};
const check=async(name,{requireVisible=false}={})=>{
await f.idle();await hoverSource();await page.waitForTimeout(200);const rows=await geometry();report.lastGeometry={name,rows};let visible=0,hidden=0;
for(const row of rows){assert.equal(row.oldRails,0);assert.equal(row.shapeCount,0);if(row.i===0){assert.deepEqual(row.labels,[]);continue;}
for(const label of row.labels){assert.equal(label.price,row.source[label.kind]);if(!label.visible){assert.ok(['unmatched-extreme','outside-pane','occupied'].includes(label.reason));hidden++;continue;}visible++;
assert.ok(label.box.y+label.box.height<=label.boundary-7||label.box.y>=label.boundary+7,'label outside rectangle');
assert.ok(label.box.x>=0&&label.box.x+label.box.width<=row.pane.width&&label.box.y>=0&&label.box.y+label.box.height<=row.pane.height,'full number within pane');
assert.ok(!row.candles.some(c=>overlaps(label.box,c)),'label must not contact a candle wick or body');assert.ok(!overlaps(label.box,row.legend),'label must not cover legend');
assert.ok(!row.candles.some(c=>overlaps(label.leader,c)),'leader must not contact a candle wick or body');assert.ok(!overlaps(label.leader,row.legend),'leader must not cover legend');
const bar=row.candles.find(c=>c.time===label.barTime);assert.ok(bar,'price location must be an actual visible bar');assert.equal(bar[label.kind],label.price);
assert.ok(Math.abs(bar.x-label.barX)<.01,'label leader identifies verified high/low bar');
const prior=row.candles.filter(c=>c.x>=0&&c.x<=row.pane.width&&c.time<bar.time&&c[label.kind]===label.price&&c.time>=row.source.start&&c.time<row.source.end);assert.equal(prior.length,0,'equal extrema deterministically choose earliest visible bar');
}}
if(requireVisible)assert.ok(visible>0,'real external high/low must be painted');
report.cases.push({name,visible,hidden,rows});await page.screenshot({path:OUT.replace('.json','-'+name+'.png')});return rows;
};
await host.evaluate(async()=>{MWBarRangeMapping.configure({style:'rectangle',priceLabels:true});for(let i=0;i<widget.chartsCount();i++){await widget.chart(i).setSymbol('MWP:BTCUSDT',{doNotActivateChart:true});await widget.chart(i).setResolution(i?'5':'60',{doNotActivateChart:true});}});await f.settle();
await check('real-extrema-dpr2',{requireVisible:true});
await page.mouse.move(10,10);const before=await geometry();await hoverSource();const after=await geometry();assert.deepEqual(after.map(r=>[r.pane,r.range,r.price,r.spacing]),before.map(r=>[r.pane,r.range,r.price,r.spacing]));report.cases.push({name:'hover does not change pane axis range or spacing'});
for(const theme of ['Light','Dark']){await host.evaluate(t=>widget.changeTheme(t),theme);await check('theme-'+theme,{requireVisible:true});}
for(const [mode,inverted] of [[1,false],[2,false],[3,true],[0,true],[0,false]]){await host.evaluate(([mode,inverted])=>{for(let i=1;i<widget.chartsCount();i++){const s=widget.chart(i).getPanes().find(p=>p.hasMainSeries()).getMainSourcePriceScale();s.setMode(mode);s.setInverted(inverted);s.setAutoScale(true)}},[mode,inverted]);await check('mode-'+mode+'-inverted-'+inverted);}
await host.evaluate(()=>{for(let i=1;i<widget.chartsCount();i++){const s=widget.chart(i).getPanes().find(p=>p.hasMainSeries()).getMainSourcePriceScale();s.setMode(0);s.setInverted(false);s.setAutoScale(false);s.setVisiblePriceRange({from:1,to:2})}});const offscreen=await check('offscreen-hides-prices');assert.ok(offscreen.slice(1).every(r=>r.labels.every(t=>!t.visible)));
await host.evaluate(()=>{for(let i=1;i<widget.chartsCount();i++)widget.chart(i).getPanes().find(p=>p.hasMainSeries()).getMainSourcePriceScale().setAutoScale(true)});
await host.evaluate(()=>widget.setLayout('8'));await f.settle();await host.evaluate(async()=>{for(let i=0;i<widget.chartsCount();i++){await widget.chart(i).setSymbol('MWP:BTCUSDT',{doNotActivateChart:true});await widget.chart(i).setResolution(i?'5':'60',{doNotActivateChart:true})}});await page.setViewportSize({width:1100,height:800});await f.settle();await check('eight-narrow-dpr2');
await host.evaluate(()=>widget.applyOverrides({'scalesProperties.fontSize':16}));await check('eight-native-16px-font');
await host.evaluate(()=>MWBarRangeMapping.configure({priceLabels:false}));await page.waitForTimeout(100);assert.deepEqual(await host.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>MWBarRangeMapping.labels(widget.chart(i)))),Array.from({length:8},()=>[]));report.cases.push({name:'disable clears all exterior labels'});
assert.deepEqual(report.errors,[]);await f.ctx.close();
}catch(e){report.failure=e.stack;process.exitCode=1}finally{fs.mkdirSync(require('node:path').dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(report,null,2));console.log(JSON.stringify({cases:report.cases.length,failure:report.failure,errors:report.errors}));await browser.close()}})();
