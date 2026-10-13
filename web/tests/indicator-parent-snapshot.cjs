// Exercise the shipped parent message branch, including validation and HTTP body.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ts=require('typescript');
const source=fs.readFileSync('src/advanced/AdvancedWorkspace.tsx','utf8');
const start=source.indexOf('} else if (m.type === "data") {');
const end=source.indexOf('} else if (m.type === "snapshot") {',start);
assert.ok(start>0 && end>start);
const branch=source.slice(start+'} else if (m.type === "data") {'.length,end);
const js=ts.transpileModule('async function handle(m) {'+branch+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const requests=[],replies=[];
const context={frames:new Set(['M1']),validIndicatorRead:()=>true,
 historyCapabilities:{current:{}},inflight:{current:0},marketRequests:new Map(),source:{},AbortController,
 reply:r=>replies.push(r),api:async(path,body)=>{requests.push({path,body});return {bars:[]};},apiErrorDetails:()=>({})};
vm.runInNewContext(js,context);
const token='a'.repeat(64),query={instrument:'test-composite',series_kind:'composite',timeframe:'M1',limit:100,
 composite_revision_id:'revision',display_snapshot_id:token,indicators:[]};
(async()=>{
 await context.handle({id:1,query});
 assert.equal(requests[0].body.display_snapshot_id,token,'real parent must forward the accepted price credential');
 for(const bad of [{display_snapshot_id:'bad'},{display_snapshot_id:42},{series_kind:'provider'}]){
  const count=requests.length;
  await context.handle({id:2,query:{...query,...bad}});
  assert.equal(requests.length,count,'invalid or wrong-series credential must not reach HTTP');
  assert.equal(replies.at(-1).errorDetails.code,'INVALID_HISTORY_REQUEST');
 }
 const {display_snapshot_id,...ordinary}=query;
 await context.handle({id:3,query:ordinary});assert.equal(requests.length,2);
 console.log('PASS actual parent snapshot forwarding and identity validation');
})().catch(e=>{console.error(e);process.exitCode=1;});
