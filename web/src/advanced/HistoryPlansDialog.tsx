import { useEffect, useRef, useState } from 'react';
import { api as defaultRequest } from '../api';
export type DatasetViews = Record<string,{plot_width:number;bar_spacing:number;threshold:number}>;

type VolumeJob = {id:string;instrument_id:string;status:string;start:number;end:number;cursor:number;
  source:string;unresolved:number;error:string|null;attempts:number};
type Segment = {start:number;end:number;status:string;detail:string|null};
type Plan = {instrument:string;status:string;start:number;end:number;covered_ms:number;
  total_ms:number;priority:number;pending:number;running:number;failed:number;aggregation_pending?:number;aggregation_failed?:number;
  cursor:number|null;realtime_enabled:boolean;realtime_end:number;realtime_quality:string;realtime_error:string|null;
  boundary_error?:string|null;
  download_errors?:{id:string;start:number;end:number;error:string;attempts:number;retry_at:number;status:string}[];
  aggregation_errors?:{id:string;timeframe:string;start:number;end:number;error:string;attempts:number;retry_at:number}[];
  periods:{timeframe:string;start:number|null;end:number|null;complete_count:number;threshold:number;ready:boolean;initialized:boolean}[]};
export function HistoryPlansDialog({onClose,readonly,onRefresh,views={},request:api=defaultRequest}:{request?:typeof defaultRequest;onClose:()=>void;readonly:boolean;onRefresh?:()=>void;views?:DatasetViews}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [plans,setPlans]=useState<Plan[]>([]),[error,setError]=useState('');
  const [busy,setBusy]=useState('');
  const [volumeJobs,setVolumeJobs]=useState<VolumeJob[]>([]);
  const [segments,setSegments]=useState<Record<string,Segment[]>>({});
  async function refresh(){
    const [rows,jobs]=await Promise.all([api<Plan[]>('/market-data/history/plans'),api<VolumeJob[]>('/market-data/history/volume')]);
    setPlans(rows);setVolumeJobs(jobs);
  }
  useEffect(()=>{
    dialog.current?.showModal();
    let active=true;
    const update=()=>Promise.all([api<Plan[]>('/market-data/history/plans'),api<VolumeJob[]>('/market-data/history/volume')]).then(([rows,jobs])=>{
      if(active){setPlans(rows);setVolumeJobs(jobs);setError('');}
    }).catch(e=>{if(active)setError(String(e));});
    void update();const timer=setInterval(update,5000);
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  async function control(instrument:string,action:string){
    setBusy(instrument);
    try{await api('/market-data/history/plans/control',{instrument,action});await refresh();setError('');}
    catch(e){setError(String(e));}finally{setBusy('');}
  }
  async function volumeAction(id:string,action:string){
    setBusy(id);
    try{await api('/market-data/history/volume/control',{id,action});await refresh();setSegments({});setError('');}
    catch(e){setError(String(e));}finally{setBusy('');}
  }
  async function startVolume(instrument:string){
    setBusy(instrument);
    try{await api('/market-data/history/volume/start',{instrument});await refresh();setError('');}
    catch(e){setError(String(e));}finally{setBusy('');}
  }
  async function loadSegments(id:string){
    setBusy(id);
    try{const rows=await api<Segment[]>(`/market-data/history/volume/${id}/segments?offset=${segments[id]?.length||0}`);
      setSegments(old=>({...old,[id]:[...(old[id]||[]),...rows]}));setError('');}
    catch(e){setError(String(e));}finally{setBusy('');}
  }
  const volumeState:Record<string,string>={pending:'等待补量或发布',running:'正在补量',complete:'量已确认并发布',partial:'部分量未取得',failed:'失败',cancelled:'已取消'};
  const segmentState:Record<string,string>={resolved:'量已确认',no_bar:'无已存K线',conflict:'价格冲突，需先修复价格',missing:'来源缺量',unreachable:'来源未返回已存K线',failed:'请求失败',retry:'等待重试'};
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
      </>}
      {!readonly&&<button disabled={!!busy} onClick={()=>startVolume(plan.instrument)}>补采成交量</button>}</td>
    </tr>)}</tbody></table></div>
    <h3>成交量补采</h3>
    <p>Binance 为基础资产成交数量，OANDA 为报价数量。任务只核对并补量；价格冲突保留原行情，缺量显示为空。关闭此页面后任务继续。</p>
    {!volumeJobs.length&&<p>暂无成交量任务</p>}
    {volumeJobs.map(job=><section key={job.id} className="volume-job" aria-label={`${job.instrument_id} 成交量任务`}>
      <strong>{job.instrument_id} · {job.source==='oanda'?'报价量':'成交量'} · {volumeState[job.status]||job.status}</strong>
      <p>{date(job.start)} 至 {date(job.end)}（固定范围）<br/>
        已扫描至 {date(job.cursor)} · {job.unresolved} 个未解决片段</p>
      {job.error&&<p role="alert">{job.error}</p>}
      {!readonly&&<>
        {job.status!=='complete'&&job.status!=='cancelled'&&<button disabled={!!busy} onClick={()=>volumeAction(job.id,'cancel')}>取消补量</button>}
        {job.status==='cancelled'&&<button disabled={!!busy} onClick={()=>volumeAction(job.id,'resume')}>恢复补量</button>}
        {['partial','failed'].includes(job.status)&&<button disabled={!!busy} onClick={()=>volumeAction(job.id,'retry')}>重试未解决片段</button>}
      </>}
      <details><summary>补采范围与冲突详情</summary>
        {(segments[job.id]||[]).map((item,i)=><p key={i}>{date(item.start)} 至 {date(item.end)}：{segmentState[item.status]||item.status}{item.detail&&` · ${item.detail}`}</p>)}
        <button disabled={!!busy} onClick={()=>loadSegments(job.id)}>{segments[job.id]?.length?'继续读取片段':'读取片段'}</button>
      </details>
    </section>)}
  </dialog>;
}
