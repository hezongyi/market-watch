const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('../advanced-host/bridge.js','utf8');
const code=source.slice(source.indexOf('const requests = [];'),source.indexOf('function dateAt('));
const sent=[],ctx=vm.createContext({Map,Promise,Error,send:value=>sent.push(value),setTimeout:()=>1,clearTimeout(){}});
vm.runInContext('const pending=new Map();let seq=0;'+code,ctx);
vm.runInContext(`
 for(let i=0;i<4;i++) request({op:'slow-history'},'data');
 request({op:'draftWrite'},'preferences');
 request({op:'read'},'preferences');
 request({op:'draftCheck'},'preferences');
`,ctx);
assert.equal(vm.runInContext('pending.size',ctx),6,'four slow market reads cannot block preference durability/recovery');
assert.equal(vm.runInContext('[...pending.values()].filter(e=>e.management).length',ctx),2,'preferences share the existing two management slots');
assert.equal(vm.runInContext('requests.length',ctx),1,'third management RPC remains queued');
vm.runInContext(`pending.delete([...pending].find(([,entry])=>entry.management)[0]);drain();`,ctx);
assert.equal(sent.at(-1).query.op,'draftCheck');
assert.equal(vm.runInContext('pending.size',ctx),6);
console.log('PASS preference draft RPCs remain available behind slow market reads, bounded to two management slots');
