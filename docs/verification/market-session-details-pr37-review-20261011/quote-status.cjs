const fs=require('fs'),vm=require('vm');const src=fs.readFileSync('advanced-host/bridge.js','utf8');
const rows=new Map([['MWP:DUKA:XAUUSD',{s:'ok',n:'MWP:DUKA:XAUUSD',v:{lp:4000,data_start:100,market_session:'closed',read_at:200}}]]);
const entry={listener:'fixture',generation:1,sequence:1};let calls=0;
const ctx={quote:{listeners:[entry],cb:()=>calls++},event:{listener:'fixture',generation:1,sequence:2,type:'status',status:'error',error:'行情暂不可用，后台重试中'},quoteSnapshotRows:rows};vm.createContext(ctx);
const start=src.indexOf('    if(quote) {',src.indexOf("if(m.type==='market-event')"));const end=src.indexOf('    const sub=',start);vm.runInContext('(function(){'+src.slice(start,end)+'})()',ctx);
console.log(JSON.stringify({calls,retainedSnapshot:rows.get('MWP:DUKA:XAUUSD'),acceptedSequence:entry.sequence},null,2));
if(calls!==0 || rows.get('MWP:DUKA:XAUUSD').v.fetch_status!==undefined)throw Error('Reproduction changed');
