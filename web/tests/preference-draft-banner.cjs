const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const storage=new Map(),localStorage={get length(){return storage.size},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
function drafts(){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/localDrafts.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,crypto:require('node:crypto').webcrypto,localStorage});return exports;}
const env={crypto:require('node:crypto').webcrypto};vm.runInNewContext(fs.readFileSync('../advanced-host/preferences.js','utf8'),env);
const clone=v=>JSON.parse(JSON.stringify(v));
const key=JSON.stringify(['setting','chart.lastUsedTimeBasedResolution','']);
const draft=version=>({key,version,kind:'setting',name:'chart.lastUsedTimeBasedResolution',tool:'',value:'60',operation:'save'});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const a=drafts();assert.equal(typeof a.recoverablePreferenceDrafts,'function','banner must classify recoverable drafts separately from ordinary writes');
 assert.equal(a.recoverablePreferenceDrafts().length,0);
 let remote={id:'one',kind:'setting',name:'chart.lastUsedTimeBasedResolution',tool:'',revision:1,content:{value:'15'}},release,fail=false,conflict=false,attempts=0;
 const gate=()=>new Promise(resolve=>release=resolve);let blocked=gate();
 const rpc=async(op,args)=>{if(op==='read')return [clone(remote)];attempts++;await blocked;if(conflict)throw Object.assign(Error('conflict'),{status:409});if(fail)throw Object.assign(Error('offline'),{status:503});remote={...args,id:'one',revision:remote.revision+1};return clone(remote)};
 const prefs=env.nativePreferences([clone(remote)],rpc,false,()=>{},()=>{},()=>({}),{
  put:async d=>a.putPreferenceDraft(d),drop:async d=>a.dropPreferenceDraft(d),failed:async d=>a.failPreferenceDraft(d)});
 const pending=prefs.savePreference('setting',remote.name,'60');await flush();
 assert.equal(a.preferenceDrafts().length,1,'normal in-flight changes remain durable');
 assert.equal(a.recoverablePreferenceDrafts().length,0,'successful autosave must never flash an action banner');
 release();await pending;assert.equal(a.preferenceDrafts().length,0);
 blocked=gate();fail=true;const failed=prefs.savePreference('setting',remote.name,'240');await flush();
 assert.equal(a.recoverablePreferenceDrafts().length,0);release();await assert.rejects(failed,/未保存/);
 assert.equal(a.recoverablePreferenceDrafts().length,1,'a terminal network failure requires recovery');
 blocked=Promise.resolve();fail=false;await prefs.savePreference('setting',remote.name,'240');assert.equal(a.recoverablePreferenceDrafts().length,0);
 conflict=true;const before=attempts;await assert.rejects(prefs.savePreference('setting',remote.name,'1D'),/未保存/);
 assert.equal(attempts,before+2,'only the terminal conflict is classified as failed after bounded retry');
 assert.equal(a.recoverablePreferenceDrafts().length,1);
 await assert.rejects(prefs.savePreference('setting',remote.name,'1D'),/未保存/);
 assert.equal(a.recoverablePreferenceDrafts().length,1,'deduplicated error notices do not hide a newly failed version');
 a.dropPreferenceDraft(a.preferenceDrafts()[0]);assert.equal(a.recoverablePreferenceDrafts().length,0);
 conflict=false;fail=true;prefs.settings.removeValue(remote.name);await flush();
 assert.equal(a.recoverablePreferenceDrafts()[0]?.operation,'delete','failed deletes also retain an actionable draft');
 a.dropPreferenceDraft(a.preferenceDrafts()[0]);
 a.putPreferenceDraft(draft('older'));a.putPreferenceDraft(draft('newer'));a.failPreferenceDraft(draft('older'));
 assert.equal(a.recoverablePreferenceDrafts().length,0,'a stale failure cannot expose a newer pending version');
 a.dropPreferenceDraft(draft('older'));assert.equal(a.preferenceDrafts().length,1,'a stale success cannot clear a newer draft');
 const other=drafts();assert.equal(other.recoverablePreferenceDrafts().length,1,'reload discovers unfinished drafts even without a terminal outcome');
 other.putPreferenceDraft(draft('other-pending'));assert.equal(a.recoverablePreferenceDrafts().length,0,'another live writer does not flash ordinary in-flight saves');
 other.failPreferenceDraft(draft('other-pending'));assert.equal(a.recoverablePreferenceDrafts().length,1,'another writer terminal failure is recoverable');
 // Persisted drafts from before the classification field remain recoverable.
 storage.set('mw-preference-draft:v1:admin:legacy:'+encodeURIComponent(key),JSON.stringify(draft('legacy')));
 const reopened=drafts();assert.equal(reopened.recoverablePreferenceDrafts().length,3);
 console.log('PASS preference banner: durable pending writes stay quiet; failures/conflicts/reload remain recoverable; cross-tab and stale-version fencing');
})().catch(e=>{console.error(e);process.exitCode=1});
