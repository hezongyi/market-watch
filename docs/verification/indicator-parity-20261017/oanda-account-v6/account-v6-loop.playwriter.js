const fs=require('node:fs');
await state.accountPage.bringToFront();
await state.accountChart.waitForFunction(()=>!loading&&widget.activeChart().resolution()==='15'&&widget.activeChart()._chartWidget.model().model().mainSeries().data().size()>0,{},{timeout:15000});
await state.accountChart.evaluate(()=>{accountProbe.events=[];accountProbe.messages=[];});
await state.accountNative.evaluate(()=>{
 globalThis.accountPaint={samples:[],until:Date.now()+15500};
 const sample=()=>{if(Date.now()>accountPaint.until)return;
 const c=document.querySelector('canvas');if(c&&c.height>70){const d=c.getContext('2d').getImageData(0,70,c.width,c.height-70).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>100&&((d[i]>180&&d[i+1]<110&&d[i+2]<140)||(d[i]<80&&d[i+1]>100&&d[i+2]>65)))n++;accountPaint.samples.push({at:Date.now(),colored:n});}requestAnimationFrame(sample);};sample();
});
const switchAt=Date.now();
await state.accountNative.getByRole('radio',{name:'5 分钟',exact:true}).click();
await state.accountPage.waitForTimeout(11000);
const result={run:state.accountRun||'plain-1',switchAt,paint:await state.accountNative.evaluate(()=>accountPaint.samples),chart:await state.accountChart.evaluate(()=>({symbol:widget.activeChart().symbol(),res:widget.activeChart().resolution(),bars:widget.activeChart()._chartWidget.model().model().mainSeries().data().size(),events:accountProbe.events,messages:accountProbe.messages,studies:widget.activeChart().getAllStudies()}))};
const drops=result.paint.filter((x,i,a)=>x.at>switchAt+2000&&x.colored<Math.max(...a.slice(Math.max(0,i-45),i).map(y=>y.colored))*.2);
let blanks=[],run=null;for(const x of result.paint){if(x.colored<50){if(!run)blanks.push(run={start:x.at,end:x.at,frames:0});run.end=x.at;run.frames++;}else run=null;}
result.summary={symbol:result.chart.symbol,res:result.chart.res,bars:result.chart.bars,frames:result.paint.length,dropFrames:drops.length,blankRuns:blanks.map(x=>({...x,start:x.start-switchAt,end:x.end-switchAt})),resets:result.chart.events,marketEvents:result.chart.messages.map(x=>({ms:x.at-switchAt,type:x.type,reason:x.reason,bars:x.bars})),studies:result.chart.studies};
fs.writeFileSync('/tmp/mw-issue74-20261017/account-v6-'+result.run+'.json',JSON.stringify(result,null,2));
console.log(result.summary);
if(result.chart.res!=='5'||result.chart.bars<100||result.paint.length<100)throw Error('Incomplete GBPJPY M5 browser observation');
if(drops.length||result.chart.events.some(e=>e.at>switchAt+2000)||result.chart.messages.some(e=>e.type==='reset'&&e.reason==='history_changed'))throw Error('RED: secondary repaint/reset after M5 switch');
