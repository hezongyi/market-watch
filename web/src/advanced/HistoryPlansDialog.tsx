import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
export type DatasetViews = Record<string,{plot_width:number;bar_spacing:number;threshold:number}>;

type Plan = {instrument:string;status:string;start:number;end:number;covered_ms:number;
  total_ms:number;priority:number;pending:number;running:number;failed:number;aggregation_pending?:number;aggregation_failed?:number;
  cursor:number|null;realtime_enabled:boolean;realtime_end:number;realtime_quality:string;realtime_error:string|null;
  boundary_error?:string|null;
  download_errors?:{id:string;start:number;end:number;error:string;attempts:number;retry_at:number;status:string}[];
  aggregation_errors?:{id:string;timeframe:string;start:number;end:number;error:string;attempts:number;retry_at:number}[];
  periods:{timeframe:string;start:number|null;end:number|null;complete_count:number;threshold:number;ready:boolean;initialized:boolean}[]};
export function HistoryPlansDialog({onClose,readonly,onRefresh,views={}}:{onClose:()=>void;readonly:boolean;onRefresh?:()=>void;views?:DatasetViews}) {
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
    <p>历史按已提交起点从近到远补齐。取消历史补数保留已发布行情，持续维护最新行情继续运行。新增历史通过“刷新历史”载入，保留柱宽和查看位置。</p>
    {onRefresh&&<button onClick={onRefresh}>刷新历史</button>}
    {error&&<p role="alert">{error}</p>}
    {!plans.length&&<p>暂无历史计划</p>}
    <div className="history-plans-scroll"><table><thead><tr><th>品种</th><th>历史起点与实时水位（UTC）</th><th>进度与可用范围</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>{plans.map(plan=><tr key={plan.instrument}>
      <td>{plan.instrument}</td><td>历史起点：{date(plan.start)}<br/>
        已补到：{plan.cursor?date(plan.cursor):'待查询'}<br/>
        实时水位：{plan.realtime_end?date(plan.realtime_end):'尚未发布'}<br/>
        实时维护：{plan.realtime_enabled?'已开启':'已暂停'} · {plan.realtime_quality}
        {plan.realtime_error&&<span role="alert">{plan.realtime_error}</span>}</td>
      <td><progress max={plan.total_ms||1} value={plan.covered_ms} aria-label={`${plan.instrument} 历史覆盖进度`}/><br/>
        {Math.floor(100*plan.covered_ms/Math.max(1,plan.total_ms))}% 初始化范围已查询
        <details><summary>各周期已发布范围与完整根数</summary>
          <p>首次门槛按实际绘图区和柱间距计算。未打开周期的480根为960px、6px示例；指标前置历史另行检查。</p>
          {plan.periods?.map(period=>{
            const view=views[plan.instrument+'|'+period.timeframe],threshold=view?.threshold||480;
            return <p key={period.timeframe}>{period.timeframe}：{period.complete_count} 根完整K线 ·
              {period.complete_count===0&&period.initialized?'当前范围无完整K线':period.complete_count>=threshold||period.initialized?'可查看':'准备中'}<br/>
              首次门槛 {threshold} 根{view?`（${view.plot_width}px / ${view.bar_spacing}px）`:'（示例）'}<br/>
              {period.start!==null&&period.end!==null?`${date(period.start)} 至 ${date(period.end)}`:'尚未发布'}</p>;
          })}
        </details></td>
      <td>{plan.status==='cancelled'?'已取消':plan.status==='complete'?'完成':plan.priority===300?'空闲时补齐':'准备中'}
        {plan.boundary_error&&<p role="alert">{plan.boundary_error}</p>}
        {plan.failed>0&&` · ${plan.failed} 项下载失败`}
        {!!plan.aggregation_pending&&` · 待生成 ${plan.aggregation_pending} 个周期区间`}
        {!!plan.aggregation_failed&&` · ${plan.aggregation_failed} 项生成失败，等待重试`}
        {(!!plan.download_errors?.length||!!plan.aggregation_errors?.length)&&<details><summary>失败详情与重试状态</summary>
          {plan.download_errors?.map(item=><p key={item.id}>M1 {date(item.start)} 至 {date(item.end)}：{item.error}<br/>
            已失败 {item.attempts} 次 · {item.status==='failed'?'等待手动重试':`下次重试 ${date(item.retry_at)}`}</p>)}
          {plan.aggregation_errors?.map(item=><p key={item.id}>{item.timeframe} {date(item.start)} 至 {date(item.end)}：{item.error}<br/>
            已失败 {item.attempts} 次 · 下次重试 {date(item.retry_at)}</p>)}
        </details>}</td>
      <td>{!readonly&&plan.status!=='complete'&&<>
        <button disabled={!!busy} onClick={()=>control(plan.instrument,plan.status==='cancelled'?'resume':'cancel')}>
          {plan.status==='cancelled'?'继续补齐':'取消补数'}</button>
        {(plan.failed>0||!!plan.aggregation_failed)&&<button disabled={!!busy} onClick={()=>control(plan.instrument,'retry')}>重试失败</button>}
      </>}</td>
    </tr>)}</tbody></table></div>
  </dialog>;
}
