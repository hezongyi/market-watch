// Execute the production continuation guards, without modifying native indices.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(process.env.NATIVE_RANGE_SOURCE || 'advanced-host/native-navigation.js','utf8');
const start=source.indexOf('            if (\n              method === "gotoTimeRange"');
const end=source.indexOf('            if (state.depth)',start);
const state={},marks={minIndex:0,maxIndex:634,_marksByIndex:new Map(Array.from({length:525},(_,i)=>[i+110,{time:i}]))};
const scheduled=[];let calls=0,clock=0,rejected=0,notices=0;
const model={timeScale:()=>({tickMarks:()=>marks}),_lastGotoTimeRange:{id:'current'}};
const context={method:'gotoTimeRange',state,models:new Map([[model,state]]),original:{apply:()=>{calls++;}},
  requestAnimationFrame:cb=>scheduled.push(cb),performance:{now:()=>clock},
  clearNativeWait:(model,error)=>{assert.match(error.message,/请重试/);rejected++;model._lastGotoTimeRange=null;},
  CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
  dispatchEvent:event=>{assert.equal(event.type,'mw-navigation-error');notices++;}};
vm.createContext(context);
model.gotoTimeRange=vm.runInContext('(function(...args){'+source.slice(start,end)+'})',context);
const current=model._lastGotoTimeRange;
model.gotoTimeRange(1,2,current);model.gotoTimeRange(1,2,current);
assert.equal(calls,0);assert.equal(scheduled.length,1,'one retry for a retained deferred');
assert.equal(model._lastGotoTimeRange,current);
marks.minIndex=110;
scheduled.shift()();assert.equal(calls,1,'same deferred completes when real bounds are coherent');
marks.minIndex=0;model.gotoTimeRange(1,2,current);
model._lastGotoTimeRange={id:'replacement'};scheduled.shift()();
assert.equal(calls,1,'superseded continuation cannot execute');
model.gotoTimeRange(1,2,current);assert.equal(calls,1,'late completed callback stays fenced');
const timeout=model._lastGotoTimeRange;
model.gotoTimeRange(1,2,timeout);clock=30000;scheduled.shift()();
assert.equal(rejected,1);assert.equal(notices,1);assert.equal(scheduled.length,0);
assert.equal(model._lastGotoTimeRange,null,'persistent incoherence ends with a retryable error');
console.log('Native range continuation waits for coherent indices, retries and rejects superseded deferreds');
