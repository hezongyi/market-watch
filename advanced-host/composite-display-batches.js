/* Hold an accepted parent credential until its Python reads have had a bounded
 * opportunity to commit. Queued events retain one actual candle per minute,
 * using the newest received event's credential. Reset/identity changes fence
 * immediately; this does not claim cross-engine rendering atomicity. */
function chartDisplayBatches({accept,settle,owners,report=()=>{},maxWait=5000,maxBars=2000,maxLanes=64}) {
  const lanes=new Map();let disposed=false;
  function cancel(key){
    const lane=lanes.get(key);if(!lane)return;
    lanes.delete(key);lane.cancel?.();
  }
  function enqueue(key,owner,event,current){
    if(disposed || !current())return;
    let lane=lanes.get(key);
    if(!lane){
      if(lanes.size>=maxLanes){report(key,Error('展示批次超过容量，请重新读取行情'),true);return;}
      lane={pending:new Map()};lanes.set(key,lane);
    }
    if(event.as_of!=null && event.as_of<(lane.asOf ?? -Infinity))return;
    lane.asOf=event.as_of ?? lane.asOf;
    const previous=lane.pending.get(owner),rows=new Map((previous?.event.bars || []).map(bar=>[bar.start,bar]));
    for(const bar of event.bars || [])rows.set(bar.start,bar);
    if(rows.size>maxBars){cancel(key);report(key,Error('展示批次超过容量，请重新读取行情'),true);return;}
    lane.pending.delete(owner);
    lane.pending.set(owner,{owner,current,event:{...event,bars:[...rows.values()].sort((a,b)=>a.start-b.start)}});
    if([...lane.pending.values()].reduce((n,item)=>n+item.event.bars.length,0)>maxBars){
      cancel(key);report(key,Error('展示批次超过容量，请重新读取行情'),true);return;
    }
    if(!lane.running){lane.running=true;void drain(key,lane);}
  }
  async function drain(key,lane){
    try{
      while(!disposed && lanes.get(key)===lane && lane.pending.size){
        const entries=[...lane.pending.values()];lane.pending.clear();
        const valid=entries.filter(entry=>entry.current());
        if(owners && valid.length){
          const rows=new Map();for(const entry of valid)for(const bar of entry.event.bars)rows.set(bar.start,bar);
          if(rows.size>maxBars)throw Error('展示批次超过容量，请重新读取行情');
          const event={...valid.at(-1).event,bars:[...rows.values()].sort((a,b)=>a.start-b.start)};
          // All panes sharing the Python binding must accept the same price
          // credential, even when their subscriptions emit at different times.
          for(const owner of owners(key))accept(owner,event);
        }else for(const entry of valid)accept(entry.owner,entry.event);
        if(lanes.get(key)!==lane)return;
        let timer;
        let waiting=true;
        const interrupted=new Promise(resolve=>{lane.cancel=()=>resolve('cancelled');
          timer=setTimeout(()=>resolve('timeout'),maxWait);});
        try{
          const outcome=await Promise.race([Promise.resolve().then(()=>settle(key,
            ()=>waiting && !disposed && lanes.get(key)===lane)).then(()=> 'settled'),interrupted]);
          if(outcome==='timeout')report(key,Error('指标同步超时，行情继续更新，指标等待恢复'),false);
          else if(outcome==='settled' && lanes.get(key)===lane)report(key,null,false);
        }catch(error){report(key,error,false);}
        finally{waiting=false;clearTimeout(timer);lane.cancel=null;}
      }
    }catch(error){report(key,error,true);}
    finally{if(lanes.get(key)===lane)lanes.delete(key);}
  }
  return {enqueue,cancel,dispose(){disposed=true;for(const key of lanes.keys())cancel(key);},
    diagnostics:()=>({lanes:lanes.size,queued:[...lanes.values()].reduce((n,l)=>n+l.pending.size,0)})};
}
