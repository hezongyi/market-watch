import { useRef, useState } from "react";
import { Link, useDirtyForm, useActionLock } from "./router";
import { api, ApiError } from "./api";
import { Feedback } from "./Center";
import { time } from "./types";
import { useSnapshot } from "./useSnapshot";

type Choice = {version_id:string;dataset_id:string;calendar:string;start:number;end:number;
  recommended_seam:number|null;mappings:{id:string;display_symbol?:string;provider_symbol:string;environment:string}[]};
type Revision = {id:string;request_id:string;parent_revision_id:string|null;history_version_id:string;
  seam:number;rules:{aggregation_calendar:string};reason:string;activated_at:number|null;
  change:{affected_rules:{id:string;name:string;revision_id:string}[]}|null;
  preparation:{ready:boolean;status:string;cutoff:number;input_revision:number|null;
    periods_ready:boolean;query_error:string|null;indicators:{timeframe:string;spec:{name:string};status:string}[]}};
const statuses:Record<string,string>={confirming_m1:"查询接续M1",publishing_periods:"准备九周期产物",
  initializing_indicators:"完整初始化指标",algorithm_changed:"算法已改变，需重新准备",ready:"可启用"};
const utcInput=(at:number)=>new Date(at).toISOString().slice(0,16);

export function CompositeRevisions({id,active,onChanged}:{id:string;active:string;onChanged:()=>void}) {
  const [refresh,setRefresh]=useState(0),[listPage,setListPage]=useState(1),[version,setVersion]=useState(""),[mapping,setMapping]=useState(""),
    [seam,setSeam]=useState(""),[reason,setReason]=useState(""),[nonDay,setNonDay]=useState(false),
    [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [saved, setSaved] = useState(0);
  const actionLock = useActionLock();
  useDirtyForm("composite-revision", [version, mapping, seam, reason, nonDay], saved);
  const options=useSnapshot<{items:Choice[]}>(`/market-data/composites/${id}/revision-options`,refresh),
    revisions=useSnapshot<{items:Revision[];total:number;page_size:number}>(`/market-data/composites/${id}/revisions?page=${listPage}`,refresh);
  const submission=useRef<{signature:string;body:any}|null>(null),activationIds=useRef(new Map<string,string>());
  const selected=options.data?.items.find(row=>row.version_id===version);
  function choose(value:string) {
    const row=options.data?.items.find(item=>item.version_id===value);
    setVersion(value);setMapping(row?.mappings[0]?.id || "");
    setSeam(row?.recommended_seam!=null ? utcInput(row.recommended_seam) : "");
  }
  async function prepare(event:React.FormEvent) {
    event.preventDefault();if(!actionLock.acquire())return;setBusy(true);setError("");setMessage("");
    const fields={history_version_id:version,mapping_id:mapping,seam:Date.parse(seam+":00Z"),
      reason,allow_non_day_boundary:nonDay},signature=JSON.stringify(fields);
    if(submission.current?.signature!==signature)submission.current={signature,body:{...fields,
      expected_revision_id:active,request_id:crypto.randomUUID()}};
    function submitted(row:Revision) {
      setMessage("新修订已提交后台准备。当前图表与已有规则保持原输入，请准备完成后明确启用。");
      setSaved(value => value + 1);
      submission.current=null;setListPage(1);setRefresh(v=>v+1);onChanged();
      document.getElementById("composite-revision-"+row.id)?.focus();
    }
    try {
      const row=await api<Revision>(`/market-data/composites/${id}/revisions`,submission.current.body);
      submitted(row);
    }catch(e){
      if(e instanceof ApiError&&e.status<500){submission.current=null;setError(String(e));}
      else {
        try {
          const found=await api<{items:Revision[]}>(`/market-data/composites/${id}/revisions?request_id=${encodeURIComponent(submission.current!.body.request_id)}`);
          if(found.items.length)submitted(found.items[0]);else setError(String(e));
        }catch{setError("提交结果暂时无法确认。再次提交会使用相同请求编号核对结果。");}
      }
    }finally{actionLock.release();setBusy(false);}
  }
  async function activate(row:Revision) {
    if(!actionLock.acquire())return;
    setBusy(true);setError("");setMessage("");
    const token=activationIds.current.get(row.id)||crypto.randomUUID();activationIds.current.set(row.id,token);
    try {
      await api(`/market-data/composites/${id}/revisions/${row.id}/activate`,{
        request_id:token,expected_revision_id:row.parent_revision_id});
      setMessage("新修订已启用。已有规则仍绑定原修订，可在规则表单中明确编辑并重新初始化。");
      setRefresh(v=>v+1);onChanged();
    }catch(e){
      try {
        const current=await api<Revision>(`/market-data/composites/${id}/revisions/${row.id}`);
        if(current.activated_at){setMessage("已核对：此修订已经启用。已有规则保持原输入。");setRefresh(v=>v+1);onChanged();}
        else setError(String(e));
      }catch{setError("启用结果暂时无法确认。请刷新核对；再次启用仍使用相同请求编号。");}
    }finally{actionLock.release();setBusy(false);}
  }
  return <section aria-label="显式组合修订">
    <h2>准备新修订</h2>
    <p>更新基线、更换已审核映射或采用另一日界的自建版本，先完成后台准备，再启用。每日维护不会自动切换。</p>
    <Feedback error={error||options.error||revisions.error} loading={options.loading||revisions.loading} empty={false}/>
    {message&&<p role="status">{message}</p>}
    <form className="dc-form" onSubmit={prepare}>
      <label>新历史基线<select required value={version} onChange={e=>choose(e.target.value)} disabled={busy}>
        <option value="">选择已发布固定M1版本</option>
        {options.data?.items.map(row=><option key={row.version_id} value={row.version_id}>
          {row.calendar.toUpperCase()} · {time(row.start)} — {time(row.end)} · {row.version_id.slice(0,8)}</option>)}
      </select></label>
      <label>实时映射版本<select required value={mapping} onChange={e=>setMapping(e.target.value)} disabled={busy||!selected}>
        <option value="">选择已审核映射</option>
        {selected?.mappings.map(row=><option key={row.id} value={row.id}>
          OANDA {row.environment} · {row.display_symbol || row.provider_symbol} · {row.id.slice(0,8)}</option>)}
      </select></label>
      {selected&&!selected.mappings.length&&<p>该日界数据集尚无明确映射。<Link to={`/market-data/datasets/${selected.dataset_id}/mapping`}>保存实时映射</Link></p>}
      <label>拼接时刻（UTC）<input type="datetime-local" required value={seam} onChange={e=>setSeam(e.target.value)} disabled={busy}/></label>
      <label className="dc-inline-check"><input type="checkbox" checked={nonDay} onChange={e=>setNonDay(e.target.checked)} disabled={busy}/>
        明确使用非日界分钟拼接规则</label>
      <label>修订原因<textarea required minLength={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy}/></label>
      <div className="dc-actions"><button className="primary" disabled={busy||!!options.error||!selected||!mapping}>
        {busy?"处理中…":"提交修订准备"}</button></div>
    </form>
    <h2>修订与启用记录</h2>
    {revisions.data?.items.map(row=><article key={row.id} id={"composite-revision-"+row.id} tabIndex={-1} className="dc-source">
      <h3>{row.id===active?"当前启用":row.activated_at?"曾启用":row.change?"待启用":"初始修订"} · {row.rules.aggregation_calendar.toUpperCase()}</h3>
      <p>{row.reason} · 拼接 {time(row.seam)} · {statuses[row.preparation.status]||row.preparation.status}</p>
      {row.preparation.query_error&&<p role="status">查询需处理：{row.preparation.query_error}</p>}
      {row.preparation.indicators.map((item,index)=><p key={index}>{item.timeframe} {item.spec.name}：{item.status==="complete"?"初始化完成":"后台初始化中"}</p>)}
      {row.change&&<p>创建时已有 {row.change.affected_rules.length} 条规则，保持原修订。
        {row.change.affected_rules.map(item=><span key={item.id}> {item.name}；</span>)}</p>}
      <details><summary>查看固定输入依据</summary><p>修订 {row.id} · 历史 {row.history_version_id}</p>
        <p>准备截止 {time(row.preparation.cutoff)} · 固定输入 {row.preparation.input_revision??"等待M1查询"}</p></details>
      {row.change&&!row.activated_at&&row.id!==active&&<button type="button"
        disabled={busy||!row.preparation.ready||!!revisions.error||row.parent_revision_id!==active}
        onClick={()=>void activate(row)}>启用此修订</button>}
      {row.change&&!row.activated_at&&row.parent_revision_id!==active&&<p>其他修订已启用，本候选不能覆盖并发切换；请基于当前修订重新准备。</p>}
    </article>)}
    {revisions.data&&<nav className="dc-actions" aria-label="组合修订分页"><span>共 {revisions.data.total} 条 · 第 {listPage} 页</span>
      <button type="button" disabled={listPage===1} onClick={()=>setListPage(v=>v-1)}>上一页</button>
      <button type="button" disabled={listPage*revisions.data.page_size>=revisions.data.total} onClick={()=>setListPage(v=>v+1)}>下一页</button></nav>}
  </section>;
}
