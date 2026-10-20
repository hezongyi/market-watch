import { useEffect, useRef, useState } from 'react';
import { api as defaultRequest } from '../api';

export function MaintenanceDialog({instrument,onClose,onSubmitted,request:api=defaultRequest}:{
  request?:typeof defaultRequest;
  instrument:string;onClose:()=>void;onSubmitted:()=>void;
}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [start,setStart]=useState(''),[calendar,setCalendar]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    dialog.current?.showModal();
    let active=true;
    api<{calendar:string}>('/market-data/resolve',{instrument,timeframe:'M1'})
      .then(meta=>{if(active)setCalendar(meta.calendar);})
      .catch(e=>{if(active)setError(String(e));});
    return ()=>{active=false;};
  },[instrument]);
  async function submit(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError('');
    try {await api('/market-data/maintenance',{instrument,start_date:start});onSubmitted();}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <dialog ref={dialog} className="history-plans-dialog" aria-labelledby="maintenance-title"
    onCancel={onClose} onClose={onClose}>
    <h2 id="maintenance-title">{instrument} · 维护自建行情</h2>
    <p>加入后台维护后，系统从近期向历史起点分段补数，并持续维护最新行情。关闭网页或取消历史补数不会停止实时维护。</p>
    <form onSubmit={submit}>
      <label>历史补数起点 <input type="date" required value={start}
        onChange={e=>setStart(e.target.value)} disabled={busy}/></label>
      <p>{calendar==='ny17'?'按纽约交易日期解析：所选日期的前一天纽约17:00开始（自动适配夏令时）。':calendar==='utc0'?'按UTC交易日期解析：所选日期00:00开始。':'正在核对品种交易日界线。'}</p>
      {start&&<p>从 {start} 开始补齐历史，并持续维护后续行情。各周期达到三屏完整K线后可刷新查看；全部补到起点后允许查看真实已有的较少K线。</p>}
      {error&&<p role="alert">{error}</p>}
      <button type="button" onClick={onClose} disabled={busy}>暂不维护</button>
      <button type="submit" disabled={busy||!calendar}>{busy?'提交中':'确认加入维护'}</button>
    </form>
  </dialog>;
}
