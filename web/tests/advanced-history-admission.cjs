// Replay the real bridge and history loader across their message seam. Slow
// successful cleanup must leave unsent work in the queue that knows live focus.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for(let index=0;index<12;index++) await tick(); }

(async () => {
  const submitted = [], cleanups = new Map(), controllers = new Map(), handlers = [];
  const loading = new Set(), exports = {};
  let stopped = false;
  const api = async (path, body) => {
    if (path === '/charts/history-loads') {
      assert.equal(body.query.history_client,undefined,'transport admission identity stays off API bodies');
      const id = String(submitted.length + 1);
      submitted.push(body.query.instrument);
      return {load:{id,state:'ready',pages:1}};
    }
    if (path.endsWith('/result')) return {result:{bars:[{close:1}]}};
    if (path.endsWith('/cancel'))
      return new Promise(resolve => cleanups.set(path.split('/')[3], resolve));
    throw Error('Unexpected API path: ' + path);
  };
  class ApiError extends Error {
    constructor(message, status, code) { super(message); Object.assign(this,{status,code}); }
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/nativeHistoryLoads.ts','utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText, {exports,require:()=>({api,ApiError}),Date,DOMException,AbortSignal,
    crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout});

  const deliver = value => new Promise((resolve,reject)=>setImmediate(()=>
    Promise.resolve(handlers[0]({source:ctx.parent,origin:'http://localhost',
      data:{channel:'mw-chart-v1',...value}})).then(resolve,reject)));
  const ctx = vm.createContext({URL,URLSearchParams,Map,Promise,Date,Intl,Error,
    document:{createElement:()=>({}),head:{append:()=>{}}},
    location:{search:'?parent=http://localhost'},
    parent:{postMessage:message=>setImmediate(()=>{
      if (stopped || message.type !== 'data') return;
      const controller = new AbortController();
      controllers.set(message.id,controller);
      const work = exports.loadNativeHistory(message.query,controller.signal,{task_seconds:600},()=>{}, {},
        available=>deliver({type:'history-load-admitted',id:message.id,available,
          history_client:message.history_client}))
        .then(result=>deliver({type:'result',id:message.id,result,history_client:message.history_client}),
          error=>deliver({type:'result',id:message.id,error:String(error),history_client:message.history_client}))
        .finally(()=>{controllers.delete(message.id);loading.delete(work);});
      loading.add(work);
    })},
    crypto:{randomUUID:()=> 'history-admission-test'},
    addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn);},setTimeout,clearTimeout});
  for(const file of ['series.js','composite-display-batches.js','chart-runtime.js'])
    vm.runInContext(require("./fixtures/direct-runtime.cjs").read('../advanced-host/'+file,'utf8'),ctx);
  const run = code => vm.runInContext(code,ctx);
  // The conditional keeps this regression red-capable on the pre-fix loader.
  const unsubscribe = exports.subscribeHistoryLoadCapacity?.(available=>
    deliver({type:'history-load-capacity',available}));
  try {
    run(`
      globalThis.focus='old';
      globalThis.prices=[];
      globalThis.read=(name,focused)=>request({instrument:name,series_kind:'provider',native_history:{},
        firstDataRequest:true},'data',undefined,{purpose:'first-screen',focused})
        .then(()=>prices.push(name),()=>{});
      for(let i=0;i<4;i++) void read('initial'+i,()=>false);
    `);
    await flush();
    assert.equal(run('prices.length'),4,'prices reach bridge consumers before their cleanup completes');
    assert.equal(cleanups.size,4);
    run(`
      for(let i=0;i<4;i++) void read('old'+i,()=>focus==='old');
      void read('new',()=>focus==='new');
      focus='new';
    `);
    await flush();
    cleanups.get('1')();
    cleanups.delete('1');
    await flush();
    assert.equal(submitted[4],'new',
      'a cleanup release must select live focus before old requests that have not reached HTTP');
    assert.equal(exports.historyLoadDiagnostics().queued,0,
      'normal bridge traffic must not form a second FIFO admission queue');
    assert.equal(submitted.length,5,'one released lifecycle admits exactly one additional load');
    assert.equal(exports.historyLoadDiagnostics().admitted,4);
    assert.equal(run('requests.length'),4,'reusable old reads remain queued rather than cancelled');
    // Stale acknowledgements from a replaced frame must not release a current
    // frame's provisional credit, even when request IDs are reused.
    await deliver({type:'history-load-admitted',id:999,available:4,history_client:'old-frame'});
    assert.equal(submitted.length,5,'stale frame acknowledgements cannot grant extra history capacity');
    assert.equal(exports.historyLoadDiagnostics().queued,0,'stale acknowledgements cannot create a hidden queue');
    console.log('History admission: immediate prices, live-focus selection through cleanup and bounded lifetimes passed');
  } finally {
    stopped = true;
    unsubscribe?.();
    for(const controller of controllers.values()) controller.abort();
    for(const finish of cleanups.values()) finish({});
    await Promise.allSettled([...loading]);
    await tick();
    for(const finish of cleanups.values()) finish({});
    run('for(const entry of pending.values()){clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer);}');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
