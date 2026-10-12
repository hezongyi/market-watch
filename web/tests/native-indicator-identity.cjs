// Replay the actual resolver with colliding native/Python names and stable IDs.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('advanced-host/native-indicator-dialog.js','utf8');
const resolver=source.slice(source.indexOf('  function entryFor(row)'),source.indexOf('  function annotate(row)'));
const ids=['SMA','EMA','LWMA','BBANDS','RSI','MACD','ATR','STOCH','SWING_SR_V1','SUPERTREND_PINE_V1'];
const entries=[{name:'MACD',id:'MACD',label:'MACD',source:'内置',aliases:[]},
  ...ids.map(id=>({name:'守望 Python '+id,id,label:id,source:'Python',aliases:[id]}))];
const context=vm.createContext({state:{entries,names:new Map(ids.map(id=>['MWPython'+id+'@market-watch','守望 Python '+id]))}});
vm.runInContext(resolver,context);
context.state.names.delete('MWPythonSWING_SR_V1@market-watch');
for(const id of ids) {
  context.row={id:'MWPython'+id+'@market-watch',title:'守望 Python '+id,studyData:{id:'MWPython'+id+'@market-watch'}};
  assert.equal(vm.runInContext('entryFor(row)?.source',context),'Python',id);
  assert.equal(vm.runInContext('entryFor(row)?.id',context),id);
  context.row.title='MACD';
  assert.equal(vm.runInContext('entryFor(row)?.id',context),id,'Stable ID takes priority over stale title');
}
context.row={id:'unrecognized-custom',title:'Python MACD',studyData:{id:'unrecognized-custom'}};
assert.equal(vm.runInContext('entryFor(row)?.source',context),'Python','Restricted fallback stays in Python namespace');
context.row={id:'unrecognized-custom',title:'Python MISSING',studyData:{id:'unrecognized-custom'}};
assert.equal(vm.runInContext('entryFor(row)',context),null);
context.row={id:'unknown',title:'Python SUPERTREND_PINE_V1'};
assert.equal(vm.runInContext('entryFor(row)?.id',context),'SUPERTREND_PINE_V1');
console.log('Ten Python identities, colliding native MACD, versioned Supertrend, stale title and unknown identity passed');
