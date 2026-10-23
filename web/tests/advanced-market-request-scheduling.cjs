// Exercise production bridge admission with real competing request lifetimes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const messages = [], handlers = [];
  let reserveRead;
  const ctx = vm.createContext({URL, URLSearchParams, Map, Promise, Date, Intl, Error,
    document:{createElement:()=>({}),head:{append:()=>{}}},
    location:{search:'?parent=http://localhost'}, parent:{postMessage:m=>messages.push(m)},
    crypto:{randomUUID:()=> 'test'},
    MWNativeReserve:{configure:read=>{reserveRead=read;},enabled:()=>false},
    addEventListener:(name,fn)=>{if(name==='message') handlers.push(fn);}, setTimeout, clearTimeout});
  for (const file of ['series.js','composite-display-batches.js','bridge.js'])
    vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
  const run = code => vm.runInContext(code,ctx);
  const sent = () => messages.filter(m=>['data','indicator-demand-release','indicator-demand-update'].includes(m.type));
  async function finish(message) {
    assert.ok(message,'request must have been dispatched');
    await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{
      channel:'mw-chart-v1',type:'result',id:message.id,result:{bars:[],indicators:[]}}});
  }
  function dispose() {
    run('for(const entry of pending.values()){clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer);}');
  }
  return {run,sent,finish,dispose,reserveRead:()=>reserveRead};
}

(async()=>{
  let h = harness();
  try {
    h.run(`
      for(let i=0;i<3;i++) void request({name:'release'+i},'indicator-demand-release');
      void request({op:'quotes',name:'quotes'});
      void request({name:'active'},'data',undefined,{purpose:'first-screen',focused:()=>true});
      void request({name:'peer'},'data',undefined,{purpose:'first-screen',focused:()=>false});
    `);
    assert.ok(h.sent().some(m=>m.query.name==='active'),
      'release and quote traffic cannot occupy all slots before active first-screen prices');
    assert.equal(h.run('pending.size'),4,'ordinary concurrency remains four');
    assert.ok(h.run('[...pending.values()].filter(e=>e.background).length')<=2,
      'auxiliary and reserve traffic share a bounded background budget');
  } finally { h.dispose(); }

  h = harness();
  try {
    h.run(`
      for(let i=0;i<4;i++) void request({name:'renew'+i},'indicator-demand-update');
      void request({name:'active'},'data',undefined,{purpose:'first-screen',focused:()=>true});
    `);
    assert.ok(h.sent().some(m=>m.query.name==='active'),
      'indicator lease renewals cannot occupy all slots before active first-screen prices');
    assert.equal(h.run('[...pending.values()].filter(e=>e.background).length'),2);
  } finally { h.dispose(); }

  h = harness();
  try {
    h.run(`
      globalThis.focus='old';
      for(let i=0;i<4;i++) void request({name:'busy'+i});
      void request({name:'old'},'data',undefined,{purpose:'first-screen',focused:()=>focus==='old'});
      void request({name:'new'},'data',undefined,{purpose:'first-screen',focused:()=>focus==='new'});
      focus='new';
    `);
    await h.finish(h.sent()[0]);
    assert.equal(h.sent().at(-1).query.name,'new',
      'queued priority follows current focus rather than enqueue-time focus');
    assert.equal(h.sent().at(-1).query.purpose,undefined,'local scheduling metadata stays off the wire');
  } finally { h.dispose(); }

  h = harness();
  try {
    h.run(`
      for(let i=0;i<4;i++) void request({name:'busy'+i});
      void request({name:'reserve-old',native_reserve:{screen_bars:10,batch_screens:1}});
      void request({name:'peer-old'},'data',undefined,{purpose:'first-screen',focused:()=>false});
      for(let i=0;i<12;i++) void request({name:'active'+i},'data',undefined,
        {purpose:'first-screen',focused:()=>true});
    `);
    const completed = new Set();
    for(let turn=0;turn<8;turn++) {
      const next=h.sent().find(m=>!completed.has(m.id));
      completed.add(next.id);
      await h.finish(next);
    }
    assert.ok(h.sent().some(m=>m.query.name==='reserve-old'),'background receives service under foreground pressure');
    assert.ok(h.sent().some(m=>m.query.name==='peer-old'),'other visible charts receive service under foreground pressure');
    assert.ok(h.run('pending.size')<=4);
  } finally { h.dispose(); }

  h = harness();
  try {
    const read=h.reserveRead();
    const symbol=h.run("MWSeries.encode('00000000-0000-0000-0000-000000000001','history')");
    const work=[1,2,3].map(before=>read({symbol,resolution:'60',before,
      screen_bars:10,batch_screens:1,warmup_bars:0}));
    assert.equal(h.sent().length,2,'fixed reserve obeys the same two-request budget as provider reserve');
    assert.equal(h.run('[...pending.values()].filter(e=>e.reserve).length'),2);
    assert.ok(h.sent().every(m=>m.query.native_reserve===undefined),
      'fixed history does not receive provider-only reserve parameters');
    await h.finish(h.sent()[0]);
    assert.equal(h.sent().length,3,'queued fixed reserve progresses after capacity returns');
    await h.finish(h.sent()[1]);
    await h.finish(h.sent()[2]);
    await Promise.all(work);
    assert.equal(h.run('pending.size+requests.length'),0);
  } finally { h.dispose(); }
  console.log('Market scheduling: foreground room, live focus, fairness and fixed/provider reserve parity passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
