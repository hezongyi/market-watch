const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context=vm.createContext({Map,Set,Promise,Date,JSON});
vm.runInContext(fs.readFileSync('../advanced-host/progressive-history.js','utf8'),context);
(async()=>{
  let calls=0;
  const calculate=async()=>{
    calls++;
    return {bars:[{start:1},{start:2},{start:3}],indicators:[{series:[]} ]};
  };
  const empty=await context.progressiveIndicatorPage({bars:[]},calculate);
  assert.equal(calls,0,'empty history must return without indicator calculation');
  assert.equal(empty.bars.length,0);
  const partial=await context.progressiveIndicatorPage({bars:[{start:3}]},calculate);
  assert.equal(calls,1);
  assert.equal(JSON.stringify(partial.bars),'[{"start":3}]',
    'indicator history must not expose incomplete bars or disconnected cached islands');
  assert.equal(partial.indicators.length,1);
  const expanded=await context.progressiveIndicatorPage({bars:[{start:2},{start:3}]},calculate);
  assert.equal(expanded.bars.length,2);
  console.log('Progressive studies use only ready raw history; empty pages skip calculation');
})().catch(e=>{console.error(e);process.exit(1)});
