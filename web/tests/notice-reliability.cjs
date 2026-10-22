const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const clone=v=>JSON.parse(JSON.stringify(v));
const sandbox={Map,Set,Promise,JSON,Error,crypto:require('node:crypto').webcrypto};
vm.runInNewContext(fs.readFileSync('../advanced-host/preferences.js','utf8'),sandbox);
const key=JSON.stringify(['setting','widgetbar.layout-settings','']);
const row=value=>({id:'one',kind:'setting',name:'widgetbar.layout-settings',tool:'',revision:1,content:{value:JSON.stringify({width:value})}});
(async()=>{
 let remote=row(300),saved=new Map(),writes=0,reports=[];
 const durability={current:async d=>saved.get(d.key)?.version===d.version,put:async d=>saved.set(d.key,clone(d)),drop:async d=>{if(saved.get(d.key)?.version===d.version)saved.delete(d.key)}};
 const rpc=async(op,args)=>{if(op==='read')return [clone(remote)];if(op==='save'){writes++;assert.equal(args.revision,remote.revision);remote={...clone(args),id:'one',revision:remote.revision+1};return clone(remote)}};
 const make=blocked=>sandbox.nativePreferences([clone(remote)],rpc,false,(...args)=>reports.push(args),()=>{},()=>({}),{...durability,blocked});
 const old=make([]);remote=row(500);remote.revision=2;
 for(let n=0;n<2;n++)await assert.rejects(old.savePreference('setting',remote.name,JSON.stringify({width:600})),/未保存/);
 assert.equal(writes,0);assert.equal(saved.size,1);assert.equal(reports.length,1,'duplicate failed callbacks produce one error');
 const draft=clone(saved.get(key)),restored=make([key]);
 await assert.rejects(restored.savePreference('setting',remote.name,remote.content.value),/本地草稿/);
 assert.equal(saved.get(key).version,draft.version,'fresh boot cannot erase the unresolved draft');
 await assert.rejects(restored.resolveDraft(draft,'local',1),/再次变化/);assert.equal(writes,0);
 await restored.resolveDraft(draft,'local',2);assert.equal(JSON.parse(remote.content.value).width,600);assert.equal(saved.size,0);
 const failed=sandbox.nativePreferences([clone(remote)],rpc,false,()=>{},()=>{},()=>({}),{put:async()=>{throw Error('quota')},drop:async()=>{}});
 await assert.rejects(failed.savePreference('setting',remote.name,'{"width":700}'),/本机草稿写入失败/);assert.equal(writes,1);
 let release;const gate=new Promise(r=>release=r);
 const queued=sandbox.nativePreferences([clone(remote)],async(op,args)=>{if(op==='save')await gate;return rpc(op,args)},false,()=>{},()=>{},()=>({}),durability);
 const first=queued.savePreference('setting',remote.name,'{"width":700}');await new Promise(r=>setImmediate(r));
 const second=queued.savePreference('setting',remote.name,'{"width":800}');const latest=clone(saved.get(key));release();await first;
 assert.ok(!saved.has(key) || saved.get(key).version===latest.version);await second;assert.equal(JSON.parse(remote.content.value).width,800);assert.equal(saved.size,0);
 const exports={};let checks=0,registrations=0,ready=false;const timers=new Map();let tid=0;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/providerSubscriptions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Map,Set,Promise,JSON,Error,setTimeout:fn=>{timers.set(++tid,fn);return tid},clearTimeout:id=>timers.delete(id)});
 const transport=exports.providerSubscriptions(async path=>{if(path.endsWith('/subscribe'))registrations++},()=>({close(){},onmessage:null}),()=>{},()=>{},undefined,()=>{},async()=>{checks++;return ready});
 const args={client:'page',listener:'candidate',generation:1,kind:'quotes',query:{series_kind:'composite',instrument:'a'.repeat(64)}};
 await transport.subscribe(args);assert.equal(registrations,0);assert.equal(timers.size,0);
 ready=true;await transport.established(args.query.instrument);assert.equal(registrations,1);assert.equal(checks,2);
 ready=false;await transport.subscribe({...args,generation:2});await transport.unsubscribe({...args,generation:2});ready=true;await transport.established(args.query.instrument);assert.equal(registrations,1);
 await transport.dispose();
 const displayExports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/notifications/types.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:displayExports});
 const notice={instrument:'a'.repeat(64),source_kind:'market',context:{series_kind:'composite'}};
 assert.equal(displayExports.noticeInstrument(notice),'组合行情（名称不可用）· aaaaaaaa');
 assert.equal(displayExports.noticeInstrument({...notice,instrument_display:{series_kind:'composite',symbol:'EURUSD',provenance:'event_snapshot'}}),'EURUSD · 组合行情 · aaaaaaaa');
 console.log('PASS preference durable conflicts/reload/CAS/quota/queued versions; first-use/cancellation; name fallback');
})().catch(e=>{console.error(e);process.exitCode=1});
// Additional regression: establish hint arrives while stale metadata is in flight.
(async()=>{
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/providerSubscriptions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Map,Set,Promise,JSON,Error,setTimeout,clearTimeout});
 let release,first=true,registers=0;const stale=new Promise(r=>release=r);
 const transport=exports.providerSubscriptions(async path=>{if(path.endsWith('/subscribe'))registers++},()=>({close(){},onmessage:null}),()=>{},()=>{},undefined,()=>{},async()=>{if(first){first=false;return stale;}return true});
 const args={client:'race',listener:'quote',generation:1,query:{series_kind:'composite',instrument:'b'.repeat(64)}};
 const pending=transport.subscribe(args);await new Promise(r=>setImmediate(r));
 const wake=transport.established(args.query.instrument);release(false);await Promise.all([pending,wake]);assert.equal(registers,1,'establishment during in-flight metadata cannot lose the wakeup');await transport.dispose();
 // Per-document IDs survive cloned sessionStorage without sharing draft keys;
 // all old writer drafts stay discoverable after browser restart.
 const storage=new Map(),localStorage={get length(){return storage.size},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 function drafts(){const e={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/localDrafts.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:e,crypto:require('node:crypto').webcrypto,localStorage});return e;}
 const a=drafts(),b=drafts();assert.notEqual(a.sessionId(),b.sessionId());
 a.putWorkspaceDraft('workspace',JSON.stringify({engine:'tv31',state:{width:1}}),3);
 b.putWorkspaceDraft('workspace',JSON.stringify({engine:'tv31',state:{width:2}}),3);
 const reopened=drafts(),entries=reopened.workspaceDraftEntries('workspace');assert.equal(entries.length,2);assert.ok(reopened.workspaceDraft('workspace'));
 a.putWorkspaceDraft('workspace',JSON.stringify({engine:'tv31',state:{width:3}}),3);a.dropWorkspaceDraft(entries.find(e=>e.storageKey===a.workspaceDraftKey('workspace')));assert.equal(a.workspaceDraftEntries('workspace').length,2,'older success cannot clear a newer workspace draft');
 console.log('PASS in-flight establishment hint; cloned tabs/restart and workspace version fencing');
})().catch(e=>{console.error(e);process.exitCode=1});
// Recovery is serialized, and an old widget cannot undo a choice.
(async()=>{
 for(const action of ['local','remote']) {
  let remote=row(500),stored=new Map(),release,paused=false;
  const durability={put:async d=>stored.set(d.key,clone(d)),drop:async d=>{if(stored.get(d.key)?.version===d.version)stored.delete(d.key)},current:async d=>stored.get(d.key)?.version===d.version};
  const rpc=async(op,args)=>{if(op==='read'){if(paused){paused=false;await new Promise(r=>release=r)}return [clone(remote)]}if(op==='save'){remote={...remote,...args,revision:remote.revision+1};return clone(remote)}};
  const prefs=sandbox.nativePreferences([row(300)],rpc,false,()=>{},()=>{},()=>({}),durability);
  await assert.rejects(prefs.savePreference('setting',remote.name,'{"width":600}'));
  const draft=clone(stored.get(key));paused=true;
  const resolving=prefs.resolveDraft(draft,action,1);await new Promise(r=>setImmediate(r));
  await assert.rejects(prefs.savePreference('setting',remote.name,'{"width":700}'),/正在处理/);
  prefs.settings.setValue(remote.name,'{"width":300}');release();await resolving;
  assert.equal(JSON.parse(remote.content.value).width,action==='local'?600:500);
  prefs.settings.setValue(remote.name,'{"width":300}');prefs.settings.removeValue(remote.name);
  await assert.rejects(prefs.savePreference('setting',remote.name,'{"width":300}'),/重新打开/);
  assert.equal(stored.size,0);assert.equal(JSON.parse(remote.content.value).width,action==='local'?600:500);
 }
 let remote=row(500),selected={key,version:'old',kind:'setting',name:remote.name,tool:'',value:'{"width":600}',operation:'save'};
 let current={...selected,version:'new',value:'{"width":700}'},writes=0;
 const prefs=sandbox.nativePreferences([remote],async(op)=>{if(op==='read')return [remote];writes++;},false,()=>{},()=>{},()=>({}),{current:async d=>current.version===d.version,put:async()=>{},drop:async()=>{throw Error('must preserve newer draft')}});
 await assert.rejects(prefs.resolveDraft(selected,'local',1),/本地草稿再次变化/);
 assert.equal(writes,0);assert.equal(current.version,'new');
 console.log('PASS serialized recovery; stale widget blocked after local/remote choice; replaced draft preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
