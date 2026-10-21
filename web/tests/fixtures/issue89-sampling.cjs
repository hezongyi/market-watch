// Acceptance-only sampling. A native lifecycle change invalidates an observation;
// a stable wrong value is a failure, never a reason to try again.
async function withinDeadline(deadline,run,{now=Date.now,reason='operation'}={}){
  const remaining=deadline-now();
  if(remaining<=0)throw Error('native sampling deadline exhausted: '+reason);
  let timer;
  try{return await Promise.race([run(remaining),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('native sampling deadline exhausted: '+reason)),remaining);
  })]);}finally{clearTimeout(timer);}
}
async function sampleNative({deadline,read,reference,compare,record=()=>{},
  now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  let attempt=0,lastReason='no candidate';
  const bounded=run=>withinDeadline(deadline,run,{now,reason:lastReason});
  while(now()<deadline){
    const before=await bounded(()=>read());attempt++;
    record({event:'candidate',attempt,...before.summary});
    if(!before.eligible){
      lastReason=before.reason;
      await pause(Math.min(50,Math.max(0,deadline-now())));continue;
    }
    const expected=await bounded(remaining=>reference(before,remaining));
    const after=await bounded(()=>read());
    if(!after.eligible||before.fingerprint!==after.fingerprint){
      lastReason=after.reason||'state changed during reference read';
      record({event:'invalidated',attempt,reason:lastReason,before:before.summary,after:after.summary});
      continue;
    }
    // Persist the result before its assertions can throw.
    const result=compare(after,expected);
    record({event:'comparison',attempt,result});
    return {candidate:after,result,attempts:attempt};
  }
  throw Error('native sampling deadline exhausted: '+lastReason);
}
module.exports={sampleNative,withinDeadline};
