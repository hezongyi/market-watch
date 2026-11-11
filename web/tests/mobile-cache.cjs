const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {indexedDB}=require('fake-indexeddb');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/mobile/cache.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:exportsObject,indexedDB,Promise,Error,Date,Array,Object,window:{location:{origin:'https://one.example'}}});
(async()=>{
  const cache=exportsObject;
  // Upgrade an actual v1 phone DB; preserve its last successful layout.
  const old=await new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',1);
    r.onupgradeneeded=()=>{r.result.createObjectStore('records');r.result.createObjectStore('profiles');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise((resolve,reject)=>{const tx=old.transaction('records','readwrite');
    tx.objectStore('records').put({value:'v1-kept',readAt:1},['https://one.example','admin',1,'upgrade']);tx.oncomplete=resolve;tx.onerror=reject;});old.close();
  const noticeExports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/notifications/store.ts','utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports:noticeExports,indexedDB,Promise,Error,Date,Array,Object,TextEncoder});
  const notices=new noticeExports.NoticeStore(cache.openMobileDatabase);await notices.open();
  await notices.update('meta','admin:receipt','admin',()=>({seen:true}));
  assert.equal((await notices.get('meta','admin:receipt')).seen,true);
  assert.deepEqual((await indexedDB.databases()).map(row=>row.name),['mw-mobile'],'no second notification database');
  const a=await cache.rememberProfile('https://one.example','admin');
  const b=await cache.rememberProfile('https://two.example','admin');
  const other=await cache.rememberProfile('https://one.example','other');
  await cache.writeSnapshot(a,'chart',{value:'last complete'});
  await cache.writeSnapshot(b,'chart',{value:'other server'});
  await cache.writeSnapshot(other,'chart',{value:'other subject'});
  assert.equal((await cache.readSnapshot(a,'chart')).value.value,'last complete');
  assert.equal((await cache.readSnapshot(b,'chart')).value.value,'other server');
  assert.equal((await cache.readSnapshot(other,'chart')).value.value,'other subject');
  await assert.rejects(cache.writeSnapshot(a,'chart',{invalid:()=>{}}));
  assert.equal((await cache.readSnapshot(a,'chart')).value.value,'last complete','failed transaction retains previous complete snapshot');
  assert.equal(await cache.readSnapshot({...a,schema:2},'chart'),undefined,'new schema cannot read old data');
  await cache.writeSnapshot(a,'recent-composites',[{ticker:'MWC:'+ 'a'.repeat(64)}]);
  await cache.dropSnapshot(a,'chart');
  assert.equal((await cache.readSnapshot(a,'recent-composites')).value.length,1,'chart reset preserves business cache');
  assert.equal(cache.validChartDocument({engine:'tv31',schemaVersion:1,state:{charts:[{}]}}),true);
  assert.equal(cache.validChartDocument({engine:'tv31',schemaVersion:1,state:{charts:[{},{}]}}),false);
  assert.equal(cache.validChartDocument({engine:'old',schemaVersion:1}),false);
  assert.equal((await cache.readSnapshot(a,'upgrade')).value,'v1-kept','IDB migration retains layout');
  await cache.clearOrigin(a.origin);
  assert.equal(await notices.get('meta','admin:receipt'),undefined,'logout also clears notification receipts');notices.close();
  assert.equal(await cache.lastProfile(a.origin),undefined);
  assert.equal(await cache.locallySignedOut(a.origin),true,'offline logout blocks silent session reuse');
  await cache.allowSession(a.origin);assert.equal(await cache.locallySignedOut(a.origin),false);
  assert.equal(await cache.readSnapshot(a,'recent-composites'),undefined);
  assert.equal(await cache.readSnapshot(other,'chart'),undefined);
  assert.equal((await cache.readSnapshot(b,'chart')).value.value,'other server','logout is scoped to selected server');
  console.log('PASS mobile cache: identity/schema isolation, atomic failure, selective chart reset and origin logout');
})().catch(error=>{console.error(error);process.exitCode=1;});
