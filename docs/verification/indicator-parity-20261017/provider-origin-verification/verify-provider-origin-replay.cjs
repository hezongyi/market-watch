const fs=require('node:fs'),vm=require('node:vm'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root='/home/quant/repos/market-watch-issue74-20261017';
const dir=root+'/docs/verification/indicator-parity-20261017/real-data-review/';
const read=name=>JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+name+'.json.gz')));
const before=read('11-xau-ema20-to-500-after-backfill').result.studies.find(s=>s.name==='EMA');
const after=read('13-reloaded-real-layout').result.studies.find(s=>s.name==='EMA');
const text=fs.readFileSync(root+'/advanced-host/bridge.js','utf8');
const source=text.slice(text.indexOf('function rememberIndicatorBinding('),text.indexOf('function startIndicatorCoordinator('));
const context={decode:()=>({series_kind:'provider'}),indicatorKey:(s,r)=>s+'|'+r,indicatorBindings:new Map(),indicatorCoordinator:undefined};
vm.runInNewContext(source,context);
const symbol=before.commit.identity.main,key=symbol+'|240';
context.rememberIndicatorBinding(symbol,'240',{bars:[{start:before.commit.identity.calculationStart}],
 calculation_origin:before.commit.identity.calculationStart,indicators:[{name:'EMA'}]});
context.rememberIndicatorBinding(symbol,'240',{bars:before.commit.sourceRows.map(r=>({start:r.sourceTime})),
 calculation_origin:before.commit.sourceRows[0].sourceTime});
const live=context.indicatorBindings.get(key);
context.indicatorBindings.clear();
context.rememberIndicatorBinding(symbol,'240',{bars:after.commit.sourceRows.map(r=>({start:r.sourceTime})),
 calculation_origin:after.commit.identity.calculationStart,indicators:[{name:'EMA'}]});
const fresh=context.indicatorBindings.get(key);
console.log(JSON.stringify({source:'actual bridge function replay + retained real XAU evidence',
 availablePriceRows:before.commit.sourceRows.length,liveOrigin:live.calculationStart,earliestVisibleSource:live.firstStart,
 liveFinite:before.commit.finite,reloadOrigin:fresh.calculationStart,reloadFinite:after.commit.finite,
 beforeInputRows:before.commit.executionEvidence[0].execution.input_rows,
 afterInputRows:after.commit.executionEvidence[0].execution.input_rows}));
assert.equal(live.calculationStart,fresh.calculationStart,
 'diagnostic: saved/restored provider study changed its calculation origin after earlier bars arrived');
