import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

type Plan = {instrument:string;status:string;start:number;end:number;covered_ms:number;
  total_ms:number;priority:number;pending:number;running:number;failed:number;aggregation_pending?:number;aggregation_failed?:number};
export function HistoryPlansDialog({onClose,readonly}:{onClose:()=>void;readonly:boolean}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [plans,setPlans]=useState<Plan[]>([]),[error,setError]=useState('');
  const [busy,setBusy]=useState('');
  async function refresh(){setPlans(await api<Plan[]>('/market-data/history/plans'));}
  useEffect(()=>{
    dialog.current?.showModal();
    let active=true;
    const update=()=>api<Plan[]>('/market-data/history/plans').then(rows=>{
      if(active){setPlans(rows);setError('');}
    }).catch(e=>{if(active)setError(String(e));});
    void update();const timer=setInterval(update,5000);
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  async function control(instrument:string,action:string){
    setBusy(instrument);
    try{await api('/market-data/history/plans/control',{instrument,action});await refresh();setError('');}
    catch(e){setError(String(e));}finally{setBusy('');}
  }
  const date=(n:number)=>new Date(n).toISOString().slice(0,16).replace('T',' ');
  return <dialog ref={dialog} className="history-plans-dialog" aria-labelledby="history-plans-title"
    onCancel={onClose} onClose={onClose}>
    <header><h2 id="history-plans-title">历史任务</h2><button onClick={onClose}>关闭</button></header>
    <p>关闭图表后，已确定的历史仍会在空闲时继续补齐。取消保留已下载的数据，已入库数据的聚合会继续完成。</p>
    {error&&<p role="alert">{error}</p>}
    {!plans.length&&<p>暂无历史计划</p>}
    <div className="history-plans-scroll"><table><thead><tr><th>品种</th><th>目标区间（UTC）</th><th>进度</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>{plans.map(plan=><tr key={plan.instrument}>
      <td>{plan.instrument}</td><td>{date(plan.start)}<br/>{date(plan.end)}</td>
      <td><progress max={plan.total_ms||1} value={plan.covered_ms} aria-label={`${plan.instrument} 历史覆盖进度`}/><br/>
        {Math.floor(100*plan.covered_ms/Math.max(1,plan.total_ms))}% 时间范围已查询</td>
      <td>{plan.status==='cancelled'?'已取消':plan.status==='complete'?'完成':plan.priority===300?'空闲时补齐':'准备中'}
        {plan.failed>0&&` · ${plan.failed} 项下载失败`}
        {!!plan.aggregation_pending&&` · 待生成 ${plan.aggregation_pending} 个周期区间`}
        {!!plan.aggregation_failed&&` · ${plan.aggregation_failed} 项生成失败，等待重试`}</td>
      <td>{!readonly&&plan.status!=='complete'&&<>
        <button disabled={!!busy} onClick={()=>control(plan.instrument,plan.status==='cancelled'?'resume':'cancel')}>
          {plan.status==='cancelled'?'继续补齐':'取消补数'}</button>
        {(plan.failed>0||!!plan.aggregation_failed)&&<button disabled={!!busy} onClick={()=>control(plan.instrument,'retry')}>重试失败</button>}
      </>}</td>
    </tr>)}</tbody></table></div>
  </dialog>;
}
