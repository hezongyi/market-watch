// Actual pinned native renderer, delayed reads of exact Python oracle outputs.
const fs=require('node:fs'),assert=require('assert').strict;
const output='/tmp/mw-issue74-20261017/native-transitions';
fs.mkdirSync(output,{recursive:true});
state.page ||= await context.newPage();
state.page.setDefaultTimeout(5000);
const cdp=await getCDPSession({page:state.page});
const timeline=[];let frame=0,lastFrame=0;
const capture=async event=>{
  if(event.metadata.timestamp-lastFrame>.08){
    lastFrame=event.metadata.timestamp;
    fs.writeFileSync(output+'/frame-'+String(frame++).padStart(5,'0')+'.jpg',Buffer.from(event.data,'base64'));
    timeline.push({type:'frame',frame:frame-1,at:event.metadata.timestamp});
  }
  await cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId});
};
cdp.on('Page.screencastFrame',capture);
await cdp.send('Page.startScreencast',{format:'jpeg',quality:60,maxWidth:1280,maxHeight:900});
const evidence=[];
async function observe(label){
  const sample=await state.page.evaluate(()=>parity.sample());
  evidence.push({label,sample});timeline.push({type:'action',label,at:Date.now()/1000});
  console.log({label,size:sample.size,transition:sample.scope.transition});
  console.log(await getLatestLogs({page:state.page,sinceLastCall:true}));
  return sample;
}
try {
  for(const name of ['LWMA','BBANDS','MACD','SUPERTREND_PINE_V1']){
    await state.page.goto('http://127.0.0.1:17474/?initialCount=1000',{waitUntil:'domcontentloaded'});
    console.log(await snapshot({page:state.page}));
    await state.page.waitForFunction(()=>ready && widget.activeChart().dataReady());
    await state.page.evaluate(async name=>{
      parity.initialize();
      window.nativeAccepted=[];
      const apply=MWNativeIndicatorResults.applyBatch;
      MWNativeIndicatorResults.applyBatch=async(handle,batch)=>{
        const accepted=await apply(handle,batch);
        if(accepted)nativeAccepted.push({identity:handle.identity,kind:batch.kind,rows:batch.rows.length,at:performance.now()});
        return accepted;
      };
      await parity.add(name,parityData.catalog[name].params);
    },name);
    await state.page.waitForFunction(()=>parity.sample().size>100);
    const original=await observe(name+' initial');
    const key=name==='MACD'?'fast':'period';
    const old=original.inputs.find(input=>input.id===key).value;
    const next=old+1;
    await state.page.evaluate(({key,next})=>{
      parity.delay=true;
      widget.activeChart().getStudyById(parity.id).setInputValues([{id:key,value:next}]);
    },{key,next});
    await state.page.waitForFunction(({key,next})=>parity.reads.some(read=>read.args.indicators.some(spec=>spec.params[key]===next)),{key,next});
    const delayed=await observe(name+' delayed edit');
    assert.equal(delayed.size,original.size);
    assert.deepEqual(delayed.last,original.last);
    assert.equal(delayed.scope.transition.params[key],old);
    await state.page.evaluate(({key,old})=>widget.activeChart().getStudyById(parity.id).setInputValues([{id:key,value:old}]),{key,old});
    await state.page.waitForFunction(()=>parity.sample().scope.transition===null);
    const returned=await observe(name+' A to B to A');
    assert.deepEqual(returned.last,original.last);
    await state.page.evaluate(()=>parity.release());
    await state.page.waitForFunction(()=>!parity.delay);
    assert.equal(await state.page.evaluate(({key,next})=>nativeAccepted.some(batch=>JSON.parse(batch.identity.paramsFingerprint)[key]===next),{key,next}),false);
    await observe(name+' late B rejected');
    await state.page.evaluate(({key,next})=>{
      parity.delay=true;parity.failures=true;
      widget.activeChart().getStudyById(parity.id).setInputValues([{id:key,value:next}]);
    },{key,next});
    await state.page.waitForFunction(()=>parity.waiting?.length>0);
    await state.page.evaluate(()=>parity.release());
    await state.page.waitForFunction(()=>parity.events.some(event=>event.type==='status' && event.value==='error'));
    const failed=await observe(name+' failure keeps valid old display');
    assert.deepEqual(failed.last,original.last);
    await state.page.evaluate(()=>{parity.failures=false;void parity.coordinator.retry(0);});
    await state.page.waitForFunction(()=>parity.sample().scope.transition===null);
    const updated=await observe(name+' retry atomic replacement');
    assert.equal(updated.last.length,name==='SUPERTREND_PINE_V1'?10:name==='MACD'||name==='BBANDS'?4:2);
    assert.notDeepEqual(updated.last,original.last);
    await state.page.evaluate(({key,old})=>{
      parity.delay=true;
      widget.activeChart().getStudyById(parity.id).setInputValues([{id:key,value:old}]);
      parity.correction++;parity.revision++;
      void parity.coordinator.sync();
    },{key,old});
    await state.page.waitForFunction(()=>parity.sample().size===0);
    await observe(name+' concurrent correction withdrawn');
    await state.page.evaluate(()=>parity.release());
    await state.page.waitForFunction(()=>parity.sample().size>100 && parity.sample().scope.transition===null);
    await observe(name+' current revision restored');
    await state.page.evaluate(()=>parity.coordinator.dispose());
  }
}finally{
  await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',capture);
  fs.writeFileSync(output+'/evidence.json',JSON.stringify({synthetic:true,evidence,timeline},null,2));
}
console.log({passed:true,scenarios:evidence.length,frames:frame,output});
