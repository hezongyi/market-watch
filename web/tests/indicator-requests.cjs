const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/indicatorRequests.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {validIndicatorRead}=context.exports;
assert.equal(validIndicatorRead(undefined),true);
assert.equal(validIndicatorRead([{name:'LWMA',params:{period:5}},{name:'SWING_SR_V1'},{name:'SUPERTREND_PINE_V1'}]),true,'product bridge must permit coordinated plots');
assert.equal(validIndicatorRead(Array.from({length:12},()=>({name:'LWMA'}))),true);
for(const value of [Array.from({length:13},()=>({name:'LWMA'})),{},[null],[['LWMA']],[{name:''}],[{name:'LWMA',params:{bad:'x'.repeat(20001)}}]])assert.equal(validIndicatorRead(value),false);
console.log('PASS parent indicator guard: coordinated reads, backend 12-spec bound and payload validation');
