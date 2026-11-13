const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {indexedDB}=require('fake-indexeddb');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const cache={};vm.runInNewContext(compile('src/mobile/cache.ts'),{exports:cache,indexedDB,Promise,Error,Date,Array,Object,window:{location:{origin:'https://phone.test'}}});
const identity={};vm.runInNewContext(compile('src/mobile/chartIdentity.ts'),{exports:identity});
const preview={};vm.runInNewContext(compile('src/mobile/chartPreview.ts'),{exports:preview,require:name=>name==='./chartIdentity'?identity:cache,Promise,Error,Date,Array,Object,JSON});
const pending=[],timers=new Map();let nextTimer=0,configReads=0,resources=0;
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const runTimer=async()=>{const tasks=[...timers.values()];timers.clear();tasks.forEach(f=>f());await flush();};
const history={startupHistoryQuery:({symbol,interval})=>symbol.startsWith('MWP:')?{instrument:symbol.slice(4),timeframe:interval==='5'?'M5':'H1',limit:1,countBack:1,indicators:[],native_history:{chart_count:1,focused:true}}:null,
 loadNativeHistory:(query,signal,cap,progress,notice,admitted,prepare)=>new Promise((resolve,reject)=>{pending.push({query,signal,prepare,resolve});signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});})};
const preparation={};vm.runInNewContext(compile('src/mobile/chartPreparation.ts'),{exports:preparation,require:name=>name==='./chartIdentity'?identity:name==='../api'?{api:async path=>{configReads++;return path.includes('capabilities')?{startup_preparation:true}:{SMA:{}};}}:name==='../runtime/chart'?{prepareChart:async()=>{resources++;}}:name==='./cache'?{profileActive:()=>true,readSnapshot:async()=>undefined}:history,
 AbortController,DOMException,Promise,Set,Map,Object,Boolean,document:{hidden:false,querySelector:()=>null},setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
(async()=>{
 const profile=cache.profileFor('https://phone.test','admin');
 const album=preview.chartPreviews(profile);await album.load();
 for(let i=0;i<9;i++)album.put({symbol:'MWP:OANDA:'+i,resolution:'60',theme:'dark',image:'data:image/webp;base64,AA',at:i,layout:'layout-a',top:46,bottom:26});
 // Read waits for real serialized IDB transactions, not a mocked storage map.
 await new Promise(r=>setTimeout(r,50));
 const restored=preview.chartPreviews(profile);await restored.load();
 assert.equal(restored.find({symbol:'MWP:OANDA:0',resolution:'60',theme:'dark'}),undefined,'album evicts oldest entries');
 const target={symbol:'MWP:OANDA:8',resolution:'60',theme:'dark'};
 assert(restored.find(target,'layout-a'));assert.equal(restored.find(target,'layout-b'),undefined);assert.equal(restored.find({...target,resolution:'5'}),undefined);assert.equal(restored.find({...target,theme:'light'}),undefined);
 assert.equal((await cache.readSnapshot(profile,'chart-previews')).value.length,6);
 const lower='MWP:DUKA:'+ 'a1'.repeat(16),upper=lower.toUpperCase();
 restored.put({...target,symbol:lower,image:'data:image/webp;base64,AA',at:10,layout:'layout-a',top:46,bottom:0});
 assert(restored.find({...target,symbol:upper},'layout-a'),'native uppercase identity must reuse picker lowercase preview');
 assert.equal(restored.find({...target,symbol:upper.replace('DUKA','YAHOO')}),undefined,'provider identity must remain isolated');
 const other=preview.chartPreviews(cache.profileFor(profile.origin,'other'));await other.load();assert.equal(other.find(target),undefined);
 await cache.clearOrigin(profile.origin);await assert.rejects(cache.writeSnapshot(profile,'chart-previews',[]));
 const manager=preparation.mobileChartPreparation(profile);
 manager.update('MWP:OANDA:A','MWP:OANDA:B',false);await runTimer();
 assert.equal(pending.length,1);assert.equal(pending[0].query.instrument,'OANDA:A');assert.equal(pending[0].query.native_history.focused,false);assert.equal(pending[0].query.countBack,1);assert.equal(pending[0].prepare,true);
 manager.update('MWP:OANDA:A','MWP:OANDA:B',true);manager.foreground('MWP:OANDA:A','H1');assert.equal(pending[0].signal.aborted,false,'matching foreground reuses preparation');assert(manager.startup.current);
 manager.foreground('MWP:OANDA:C','M5');assert.equal(pending[0].signal.aborted,true,'different foreground cancels background');await flush();assert.equal(pending.length,1,'foreground blocks next candidate');
 manager.update('MWP:OANDA:C','MWP:OANDA:B',false);await runTimer();assert.equal(pending.length,2);assert.equal(pending[1].query.timeframe,'M5');assert.equal(pending[1].query.instrument,'OANDA:C');
 pending[1].resolve({prepared:true});await flush();assert.equal(pending.length,3);assert.equal(pending[2].query.instrument,'OANDA:B','second candidate is serial');
 manager.visibility(true);assert.equal(pending[2].signal.aborted,true);await flush();manager.visibility(false);await runTimer();assert.equal(pending.length,3,'completed/attempted candidates are bounded, not repeatedly fetched');
 manager.update('MWP:OANDA:D','MWP:OANDA:D',false);await runTimer();assert.equal(pending.length,4);pending[3].resolve({prepared:true});await flush();assert.equal(pending.length,4,'duplicate last and first prepare only once');
 assert.equal(configReads,2,'catalog/capabilities preparation deduplicated');manager.dispose();
 const aliases=preparation.mobileChartPreparation(profile),beforeAliases=pending.length;
 aliases.update(lower,upper,false);await runTimer();assert.equal(pending.length,beforeAliases+1);
 aliases.update(upper,lower,true);aliases.foreground(upper,'H1');assert.equal(pending.at(-1).signal.aborted,false,'native uppercase foreground reuses lowercase preparation');
 pending.at(-1).resolve({prepared:true});await flush();aliases.update(upper,lower,false);await runTimer();assert.equal(pending.length,beforeAliases+1,'case aliases do not create a second candidate');aliases.dispose();
 console.log('PASS chart preparation: bounded serial candidates, foreground cancellation/matching reuse, background pause, deduplicated configuration; preview identity/layout/theme isolation, six-entry eviction, logout fence');
})().catch(error=>{console.error(error);process.exitCode=1;});
