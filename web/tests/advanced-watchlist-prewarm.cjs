// Replay the shipped startup handoff: saved watchlists must not start optional
// metadata requests before init. Names are resolved by the native sidebar later.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync('src/advanced/ChartApplicationPage.tsx','utf8');
const start=source.indexOf('          const prepared = startupInputs.current;');
const end=source.indexOf('        } catch (e) {',start);
assert(start>=0&&end>start);
const code=ts.transpile('(async()=>{'+source.slice(start,end)+'})()',
  {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
const tickers=Array.from({length:32},(_,i)=>'MWP:TEST'+i);
const preferences=[{kind:'setting',name:'mw.watchlists.v1',content:{value:{active:'a',lists:[{id:'a',symbols:tickers}]}}}];
(async()=>{
  const calls=[],replies=[],capabilities={startup_preparation:true};
  const workspace={id:'workspace',document:{symbol:'MWP:TEST0'},initial_symbol:{ticker:'MWP:TEST0',metadata:{source:'binance'}}};
  const startupInputs={current:Promise.resolve([[],preferences,capabilities])};
  const context={startupInputs,historyCapabilities:{current:null},current:{current:workspace},mobile:false,
    api:async path=>{calls.push(path);if(path.includes('resolve'))throw Error('optional startup resolve');
      return path.includes('preferences')?preferences:path.includes('capabilities')?capabilities:[];},
    reply:value=>replies.push(value),alertUiSession:{current:'session'},noticeStateRef:{current:[]},
    readAlertDraft:()=>null,historyLoadAvailable:4,startupHistoryQuery:()=>({instrument:'TEST0'}),
    localStorage:{getItem:()=>null},appRef:{current:{theme:'dark'}}};
  await vm.runInNewContext(code,context);
  assert.equal(calls.length,0,'prepared inputs reach init without watchlist metadata HTTP');
  assert.equal(replies.length,1);
  assert.equal(replies[0].preferences,preferences,'all saved sidebar symbols remain available');
  assert.equal(Object.keys(replies[0].watchlist_metadata).length,0,'optional names do not gate widget init');
  assert.equal(replies[0].initial_symbol,workspace.initial_symbol,'current chart metadata is preserved');
  assert.equal(context.historyCapabilities.current,capabilities);
  assert.equal(startupInputs.current,null,'startup inputs are consumed once');
  await vm.runInNewContext(code,context);
  assert.deepEqual(calls,['/advanced-charts/catalog','/advanced-charts/preferences?migrate=true','/charts/history-capabilities'],
    'a widget reload refreshes required inputs without warming every saved symbol');
  assert.equal(replies.length,2);
  console.log('PASS widget startup skips optional watchlist prewarm, preserves saved symbols and refreshes reload inputs');
})().catch(error=>{console.error(error);process.exitCode=1});
