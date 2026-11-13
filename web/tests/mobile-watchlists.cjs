const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/mobile/watchlists.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText, {exports:exportsObject,structuredClone,crypto:require('node:crypto').webcrypto,Map,Set,JSON,Error});
const {saveWatchlists,watchContent,addSymbol,removeSymbol,removeGroup,allSymbols} = exportsObject;
const native = {kind:'setting',name:'mw.watchlists.v1',tool:'',revision:3,
  content:{unknown:'keep-envelope',value:{active:'desktop-a',unknown:'keep-value',lists:[
    {id:'a',title:'A',symbols:['MWP:TEST','MWC:'+'a'.repeat(64)],unknown:'keep-list'},
    {id:'b',title:'B',symbols:['MWP:TEST','MWH:fixed']}
  ]}}};
(async()=>{
  let remote=structuredClone(native),writes=[];
  const request=async(path,body)=>{
    if(!body)return [structuredClone(remote)];
    writes.push(body);assert.equal(body.revision,remote.revision);
    remote={...remote,...body,revision:remote.revision+1};return remote;
  };
  remote.content.value.active='desktop-b';remote.revision++;
  const result=await saveWatchlists(request,native,addSymbol(watchContent(native),'NEW','a'));
  assert.equal(result.content.value.active,'desktop-b','mobile preserves newest desktop active');
  assert.equal(result.content.unknown,'keep-envelope');assert.equal(result.content.value.unknown,'keep-value');
  assert.equal(result.content.value.lists[0].unknown,'keep-list');
  const before=writes.length;
  await assert.rejects(saveWatchlists(request,native,native.content.value.lists),error=>error.status===409);
  assert.equal(writes.length,before,'remote content conflicts never overwrite');
  const content=watchContent(native);
  assert(removeSymbol(content,'MWP:TEST','a')[1].symbols.includes('MWP:TEST'),'group remove keeps other membership');
  assert(removeSymbol(content,'MWP:TEST','').every(list=>!list.symbols.includes('MWP:TEST')),'all remove affects all groups');
  assert.deepEqual([...allSymbols({lists:removeGroup(content,'b')})].sort(),[...allSymbols(content)].sort(),'deleting group keeps every favorite');
  const unknownConflict=async()=>{throw Object.assign(Error('concurrent revision'),{status:409});};
  await assert.rejects(saveWatchlists(unknownConflict,native,content.lists),error=>error.status===409);
  console.log('PASS mobile watchlists: latest desktop active, unknown fields, 409, membership and group deletion');
})().catch(error=>{console.error(error);process.exitCode=1;});
