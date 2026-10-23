// Quote sharing crosses real datafeed consumers, bridge cancellation and reset fences.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers=[],messages=[];
const ctx=vm.createContext({URL,URLSearchParams,Map,Promise,Date,Intl,Error,
  document:{createElement:()=>({}),head:{append:()=>{}}},location:{search:'?parent=http://localhost'},
  parent:{postMessage:m=>messages.push(m)},crypto:{randomUUID:()=> 'quote-sharing'},
  addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn);},setTimeout,clearTimeout,queueMicrotask});
for(const file of ['series.js','price-format.js','composite-display-batches.js','bridge.js'])
  vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
const quotes=()=>messages.filter(m=>m.query?.op==='quotes');
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const finish=async(message,rows,error)=>{
  await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:message.id,result:rows,error}});
  await flush();
};
(async()=>{
  try {
    run(`
      globalThis.a=true;globalThis.b=true;globalThis.received=[];globalThis.errors=[];
      feed.getQuotes(['MWP:EURUSD','MWP:XAUUSD'],rows=>received.push({owner:'a',rows}),e=>errors.push(e),()=>a,true);
      feed.getQuotes(['MWP:XAUUSD','MWP:EURUSD'],rows=>received.push({owner:'b',rows}),e=>errors.push(e),()=>b,true);
      a=false;
    `);
    await new Promise(r=>setTimeout(r,160));
    assert.equal(quotes().length,1,'symbol order does not duplicate a shared snapshot');
    assert.equal(messages.filter(m=>m.type==='cancel-request').length,0,
      'one obsolete consumer cannot cancel a snapshot still needed by another');
    await finish(quotes()[0],[{n:'MWP:EURUSD',s:'ok',v:{lp:1}},{n:'MWP:XAUUSD',s:'ok',v:{lp:2}}]);
    assert.equal(run('received.length'),1);
    assert.equal(run('received[0].owner'),'b');
    assert.equal(run('received[0].rows.map(r=>r.n).join(",")'),'MWP:XAUUSD,MWP:EURUSD',
      'each callback retains its original symbol order');
    assert.equal(run('quoteRequests.size'),0,'completed snapshots release shared state');
    run(`feed.getQuotes(['MWP:XAUUSD','MWP:EURUSD'],rows=>received.push({owner:'fresh',rows}),e=>errors.push(e),()=>true,true);`);
    assert.equal(quotes().length,2,'a completed snapshot is not a quote cache');
    await finish(quotes()[1],[{n:'MWP:EURUSD',s:'ok',v:{lp:3}},{n:'MWP:XAUUSD',s:'ok',v:{lp:4}}]);

    run(`
      quoteResetTokens.set('MWP:EURUSD',{});quoteSnapshotRows.delete('MWP:EURUSD');
      feed.getQuotes(['MWP:EURUSD'],rows=>received.push({owner:'old-reset',rows}),e=>errors.push(e),()=>true,true);
      quoteResetTokens.set('MWP:EURUSD',{});quoteSnapshotRows.delete('MWP:EURUSD');
      feed.getQuotes(['MWP:EURUSD'],rows=>received.push({owner:'new-reset',rows}),e=>errors.push(e),()=>true,true);
    `);
    const old=quotes().at(-1);
    await finish(old,[{n:'MWP:EURUSD',s:'ok',v:{lp:10}}]);
    const current=quotes().at(-1);
    assert.notEqual(current.id,old.id,'object reset generations must create a fresh network snapshot');
    await finish(current,[{n:'MWP:EURUSD',s:'ok',v:{lp:20}}]);
    assert.equal(run("received.some(r=>r.owner==='old-reset')"),false,'late pre-reset rows never return to a current consumer');
    assert.equal(run("quoteSnapshotRows.get('MWP:EURUSD').v.lp"),20);
    assert.equal(run('errors.length'),0);
    assert.equal(run('quoteRequests.size'),0);

    for(const outcome of ['failure','same-time-result','untimed-result']) {
      run(`
        rememberQuoteRows([{n:'MWP:EURUSD',s:'ok',v:{lp:30,read_at:100,fetch_status:'ok'}}]);
        feed.getQuotes(['MWP:EURUSD'],rows=>received.push({owner:'first',rows}),e=>errors.push(e),()=>true,true);
      `);
      const started=quotes().at(-1),count=quotes().length;
      run(`
        rememberQuoteRows([{n:'MWP:EURUSD',s:'ok',v:{lp:31,read_at:200,fetch_status:'ok'}}]);
        feed.getQuotes(['MWP:EURUSD'],rows=>received.push({owner:'late',rows}),e=>errors.push(e),()=>true,true);
      `);
      assert.equal(quotes().length,count,'a late consumer joins the outstanding snapshot');
      await finish(started,outcome==='failure' ? undefined :
        [{n:'MWP:EURUSD',s:'ok',v:{lp:29,fetch_status:'ok',...(outcome==='same-time-result' ? {read_at:200} : {})}}],
        outcome==='failure' ? 'transport failed' : undefined);
      assert.equal(run("quoteSnapshotRows.get('MWP:EURUSD').v.fetch_status"),'ok',
        'a shared HTTP failure cannot invalidate a stream observation received after the request started');
      assert.equal(run("quoteSnapshotRows.get('MWP:EURUSD').v.lp"),31,
        'a late consumer cannot let a shared HTTP result overwrite a subsequent stream observation');
    }
    run(`feed.getQuotes(['MWP:EURUSD'],rows=>received.push({owner:'new-failure',rows}),e=>errors.push(e),()=>true,true);`);
    await finish(quotes().at(-1),undefined,'new transport failure');
    assert.equal(run("quoteSnapshotRows.get('MWP:EURUSD').v.fetch_status"),'fetch_failed',
      'a genuinely new failed read still marks the current observation as failed');
    assert.equal(run('quoteRequests.size'),0);
    console.log('Quote snapshots: independent cancellation, order, fresh reads, reset generations and shared observation fences passed');
  } finally {
    run('for(const e of pending.values()){clearTimeout(e.timer);clearTimeout(e.cancellationTimer);}');
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
