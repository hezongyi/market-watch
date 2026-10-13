// Exercise the coordinator's shared read seam with independently cancelled
// consumers and the backend's 12-spec limit.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context={queueMicrotask};
vm.runInNewContext(fs.readFileSync('../advanced-host/indicator-coordinator.js','utf8'),context);
const batch=context.chartIndicatorReadBatch;
const spec=period=>({name:'LWMA',params:{period}});
(async()=>{
  let firstAlive=true,secondAlive=true,release,calls=0,started;
  const began=new Promise(resolve=>started=resolve);
  const read=batch(async(ticker,resolution,args,alive)=>{
    calls++;assert.equal(args.indicators.length,2);started();
    await new Promise(resolve=>release=resolve);
    assert.equal(alive(),true,'remaining consumer keeps the shared read alive');
    return {bars:[],indicators:args.indicators,input_revision:1};
  });
  const args={before:1000,limit:2000};
  const first=read('TEST','5',{...args,indicators:[spec(5)]},()=>firstAlive);
  const second=read('TEST','5',{...args,indicators:[spec(7)]},()=>secondAlive);
  const outcomes=Promise.allSettled([first,second]);
  await began;firstAlive=false;release();
  const result=await outcomes;
  assert.equal(calls,1);assert.equal(result[0].status,'rejected');
  assert.equal(result[0].reason.code,'HISTORY_CANCELLED');
  assert.equal(result[1].status,'fulfilled');

  // A main-history restart can replace a consumer while the same source page
  // is still in flight. The replacement must join it and keep it alive.
  let oldAlive=true,newAlive=true,lateCalls=0,lateRelease,lateStarted;
  const lateBegan=new Promise(resolve=>lateStarted=resolve);
  const late=batch(async(ticker,resolution,args,alive)=>{
    lateCalls++;lateStarted();await new Promise(resolve=>lateRelease=resolve);
    assert.equal(alive(),true,'replacement demand preserves the in-flight read');
    return {bars:[],indicators:args.indicators,input_revision:1};
  });
  const old=late('TEST','5',{...args,indicators:[spec(5)]},()=>oldAlive);
  const oldOutcome=old.catch(error=>error);
  await lateBegan;oldAlive=false;
  const replacement=late('TEST','5',{...args,indicators:[spec(5)]},()=>newAlive);
  await Promise.resolve();assert.equal(lateCalls,1,'late replacement shares a dispatched page read');
  lateRelease();assert.equal((await oldOutcome).code,'HISTORY_CANCELLED');
  assert.equal((await replacement).input_revision,1);

  let held,holdStarted,distinctCalls=0;
  const holdBegan=new Promise(resolve=>holdStarted=resolve);
  const distinct=batch(async(ticker,resolution,args)=>{
    distinctCalls++;if(args.indicators[0].params.period===5 && distinctCalls===1){holdStarted();await new Promise(resolve=>held=resolve);}
    return {bars:[],indicators:args.indicators,input_revision:1};
  });
  const heldPage=distinct('TEST','5',{...args,indicators:[spec(5)]},()=>true);
  await holdBegan;
  const distinctPage=await distinct('TEST','5',{...args,indicators:[spec(7)]},()=>true);
  assert.equal(distinctCalls,2,'a new spec cannot join a request without its result');
  assert.equal(distinctPage.indicators[0].params.period,7);held();await heldPage;
  await distinct('TEST','5',{...args,indicators:[spec(5)]},()=>true);
  assert.equal(distinctCalls,3,'settled flights release their demand');

  let versionRelease,versionStarted,versionCalls=0;
  const versionBegan=new Promise(resolve=>versionStarted=resolve);
  const versioned=batch(async()=>{
    versionCalls++;if(versionCalls===1){versionStarted();await new Promise(resolve=>versionRelease=resolve);}
    return {bars:[],indicators:[],input_revision:versionCalls};
  });
  const previousVersion=versioned('TEST','5',{...args,indicators:[spec(5)]},()=>true,'input-1');
  await versionBegan;
  const nextVersion=await versioned('TEST','5',{...args,indicators:[spec(5)]},()=>true,'input-2');
  assert.equal(versionCalls,2,'corrected inputs never join an older in-flight read');
  assert.equal(nextVersion.input_revision,2);versionRelease();await previousVersion;

  let forbiddenCalls=0;
  const cancelled=batch(async()=>{forbiddenCalls++;});
  await assert.rejects(cancelled('TEST','5',{...args,indicators:[spec(5)]},()=>false),e=>e.code==='HISTORY_CANCELLED');
  assert.equal(forbiddenCalls,0);

  const sizes=[];
  const partitioned=batch(async(ticker,resolution,args)=>{
    sizes.push(args.indicators.length);
    return {bars:[],indicators:args.indicators,input_revision:1};
  });
  const merged=await partitioned('TEST','5',{...args,indicators:Array.from({length:13},(_,i)=>spec(i+1))},()=>true);
  assert.deepEqual(sizes,[12,1]);assert.equal(merged.indicators.length,13);
  let revision=0;
  const changed=batch(async()=>({bars:[],indicators:[],input_revision:++revision}));
  await assert.rejects(changed('TEST','5',{...args,indicators:Array.from({length:13},(_,i)=>spec(i+1))},()=>true),/输入在读取期间改变/);
  console.log('PASS shared indicator reads: independent cancellation, no-demand cancellation, bounded batches and revision consistency');
})().catch(error=>{console.error(error);process.exitCode=1;});
