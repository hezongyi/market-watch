const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {IDBFactory}=require('fake-indexeddb'),{webcrypto}=require('node:crypto');
const indexedDB=new IDBFactory(), pause=ms=>new Promise(r=>setTimeout(r,ms));
function session(deny=false){
 const loaded={},events=new EventTarget(), sandbox={indexedDB:deny?{open(){throw Error('denied')}}:indexedDB,location:{origin:'https://one.test'},window:{location:{origin:'https://one.test'}},crypto:webcrypto,Date,Error,Map,Set,Promise,JSON,DOMException,Event,setTimeout,clearTimeout,addEventListener:events.addEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)};
 function load(name){if(loaded[name])return loaded[name];const exports=loaded[name]={};const source=ts.transpileModule(fs.readFileSync('src/mobile/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(source,{...sandbox,exports,require:n=>load(n.replace('./',''))});return exports;}
 return {logs:load('logs'),cache:load('cache')};
}
(async()=>{
 let a=session();const profile=a.cache.profileFor('https://one.test','alice');
 await a.cache.writeSnapshot(profile,'watchlists',{keep:true});
 a.logs.setLogProfile(profile);
 assert(!a.logs.safeLogText('Cookie: session=abc; auth=multiSecret').includes('multiSecret'),'whole cookie header');
 const jsonSecret=a.logs.safeLogText('{"password":"7777","token":"abcSecret","api_key":"keySecret"}');for(const secret of ['7777','abcSecret','keySecret'])assert(!jsonSecret.includes(secret),'quoted key '+secret);
 a.logs.logEvent({module:'数据',action:'开启实时',object:'XAUUSD',message:'authentication failed token=supersecret password:7777 https://secret.test?q=key',level:'error',result:'failure',path:'/api/read?token=hidden',secret:'unlisted-body'});
 a.logs.logEvent({module:'数据',action:'开启实时',object:'XAUUSD',message:'authentication failed token=supersecret password:7777 https://secret.test?q=key',level:'error',result:'failure',path:'/api/read?token=hidden'});
 assert.equal(a.logs.logSnapshot().rows[0].count,2);
 await pause(220);assert.equal(a.logs.logSnapshot().memoryOnly,false);
 a=session();a.logs.setLogProfile(a.cache.profileFor('https://one.test','alice'));await pause(200);
 assert.equal(a.logs.logSnapshot().rows[0].count,2,'reload persistence');
 const serialized=JSON.stringify(a.logs.logSnapshot());for(const value of ['supersecret','7777','secret.test','unlisted-body','hidden'])assert(!serialized.includes(value),value);
 assert.equal(a.logs.logSnapshot().rows[0].path,'/api/read');
 assert.equal((await a.cache.readSnapshot(a.cache.profileFor('https://one.test','alice'),'watchlists')).value.keep,true,'existing v2 snapshot survives');
 a.logs.logEvent({module:'数据',action:'开启实时',object:'XAUUSD',path:'/api/read',message:'已恢复',result:'recovery'});
 assert(a.logs.logSnapshot().rows[0].relatedId,'recovery links actual failure');
 a.logs.setLogProfile(a.cache.profileFor('https://one.test','bob'));await pause(160);assert.equal(a.logs.logSnapshot().rows.length,0,'account isolation');
 a.logs.logEvent({module:'数据',action:'迟到请求',message:'旧账号异步失败'},profile);assert.equal(a.logs.logSnapshot().rows.length,0,'late old-profile log cannot cross accounts');
 a.logs.setLogProfile(a.cache.profileFor('https://two.test','alice'));await pause(160);assert.equal(a.logs.logSnapshot().rows.length,0,'server isolation');
 a.logs.setLogProfile();await pause(160);assert.equal(a.logs.logSnapshot().rows.length,0,'anonymous isolation');
 const now=Date.now(),rows=Array.from({length:1200},(_,i)=>({id:String(i),at:now-i,firstAt:now-i,count:1,module:'test',action:'test',message:'test'}));rows.push({...rows[0],id:'expired',at:now-8*86400000});assert.equal(a.logs.pruneLogs(rows,now).length,1000);assert(!a.logs.pruneLogs(rows,now).some(r=>r.id==='expired'));
 const denied=session(true);denied.logs.setLogProfile();for(let i=0;i<1100;i++)denied.logs.logEvent({module:'test',action:'storm',object:String(i),message:'offline'});await pause(200);assert.equal(denied.logs.logSnapshot().memoryOnly,true);assert.equal(denied.logs.logSnapshot().rows.length,1000,'bounded memory fallback');
 a.logs.setLogProfile();a.logs.logEvent({module:"匿名",action:"旧故障",message:"old anonymous failure"});await pause(180);
 a.logs.setLogProfile(a.cache.profileFor('https://one.test','alice'));await pause(180);assert(a.logs.logSnapshot().rows.length);await a.cache.clearOrigin('https://one.test');await pause(180);assert.equal(a.logs.logSnapshot().rows.length,0,'logout clears memory');
 const anon=a.cache.profileFor('https://one.test','anonymous');assert.equal(await a.cache.readSnapshot(anon,'application-logs-v1'),undefined,'old anonymous logs cannot resurrect after logout');
 const old=a.cache.profileFor('https://one.test','alice');assert.equal(await a.cache.readSnapshot(old,'application-logs-v1'),undefined,'logout clears persisted logs');
 console.log('mobile logs: persistence, v2 compatibility, isolation, bounds, aggregation/recovery, redaction, fallback and logout passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
