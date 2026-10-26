import { DetailDisclosure, DetailPanel, useDetailPanel } from "./DetailPanel";
import { NativeSelect } from "./NativeControls";
import { OpenChart } from "./OpenChart";
import { Feedback, Pager } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { VersionComparison } from "./VersionComparison";
import { names, time, type Dataset, type Period } from "./types";
import { useState } from "react";

const periodNames: Record<string, string> = {M1:"1分钟",M5:"5分钟",M15:"15分钟",M30:"30分钟",H1:"1小时",H4:"4小时",D1:"日线",W1:"周线",MN:"月线"};
const groups = [["分钟",["M1","M5","M15","M30"]],["小时",["H1","H4"]],["日周月",["D1","W1","MN"]]] as const;

export function PeriodOverview({dataset}: {dataset: Dataset}) {
  return <div className="dc-period-list" role="table" aria-label="实际周期产物">
    <div className="dc-period-columns" role="row"><span role="columnheader">周期</span><span role="columnheader">状态</span><span role="columnheader">观测柱</span><span role="columnheader">覆盖完整柱</span></div>
    {groups.map(([label, frames]) => {
      const rows = frames.flatMap(frame => dataset.periods.filter(p => p.timeframe === frame));
      return rows.length ? <div role="rowgroup" key={label} aria-label={label}>
        <p className="dc-period-group">{label}</p>
        {rows.map(p => <PeriodRow key={p.id} period={p} />)}
      </div> : null;
    })}
    {!dataset.periods.length && <p role="status">尚无周期产物；已配置周期不代表已有数据。</p>}
  </div>;
}
function PeriodRow({period: p}: {period: Period}) {
  return <div className="dc-period-row" role="row">
    <div role="rowheader">{periodNames[p.timeframe] || p.timeframe}<small>{p.timeframe}</small></div>
    <div role="cell" className="dc-period-state">{names[p.status] || p.status}
      {p.freshness && <small>{names[p.freshness] || p.freshness}</small>}
      {p.available_start != null && <small>{time(p.available_start)} — {time(p.available_end)}</small>}
      {p.available_version_id && p.available_version_id !== p.version_id && <small>旧发布仍可用 · {time(p.available_end)}（{p.available_rows ?? "—"} 柱）</small>}
      <DetailDisclosure title={<>{periodNames[p.timeframe] || p.timeframe}产物详情</>}>
        <dl className="dc-detail-facts">
          <div><dt>周期</dt><dd>{p.timeframe}</dd></div><div><dt>产物状态</dt><dd>{names[p.status] || p.status}</dd></div>
          {p.freshness && <><div><dt>更新状态</dt><dd>{names[p.freshness] || p.freshness}</dd></div><div><dt>最近观测</dt><dd>{time(p.observed_at)}</dd></div><div><dt>最近成功</dt><dd>{time(p.last_success)}</dd></div></>}
          <div><dt>产物版本</dt><dd>{p.version_id || "未提供"}</dd></div>
          <div><dt>产物观测柱</dt><dd>{p.rows}</dd></div><div><dt>覆盖完整柱</dt><dd>{p.complete_rows}</dd></div>
          <div><dt>可用固定版本</dt><dd>{p.available_version_id || "尚无可用发布"}</dd></div>
          {p.available_version_id && <><div><dt>可用版本观测柱</dt><dd>{p.available_rows ?? "—"}</dd></div><div><dt>可用范围</dt><dd>{time(p.available_start)} — {time(p.available_end)}</dd></div></>}
        </dl>
        <p>观测柱与完整柱属于上述产物；可用固定版本可能是此前已发布产物。查看详情不启动维护。</p>
      </DetailDisclosure>
    </div>
    <div role="cell" className="dc-period-count"><span className="dc-mobile-label">观测柱</span>{p.rows}</div>
    <div role="cell" className="dc-period-count"><span className="dc-mobile-label">覆盖完整柱</span>{p.complete_rows}</div>
  </div>;
}

type Version = {id: string; status: string; start: number; end: number; published_at: number | null; payload_available?: boolean; manifest?: {mode?: string; rows?: number; unknown_minutes?: number; price_precision?: number; price_rule_version?: string}};
function versionObservations(v: Version) {
  return v.manifest?.mode && v.manifest.mode !== "base_m1"
    ? `${v.manifest.rows ?? "—"} 根 · 不按分钟推断缺口`
    : `${v.manifest?.rows ?? "—"} / ${v.manifest?.unknown_minutes ?? "—"} 分钟`;
}
type Coverage = {timeframe?:string;observed_bars?:number;complete_bars?:number;start:number;end:number;observed_at:number;observed_minutes:number;unknown_minutes:number;confirmed_closed_minutes:number;conflict_minutes:number;observed_intervals:number[][];unknown_intervals:number[][];confirmed_closed_intervals:number[][];conflict_intervals:number[][];session_evidence:{source:string;kind:string;applicability?:string}[]};
const readKinds:Record<string,string> = {supplier_request:"上游请求",shared_cache:"共享缓存",parent_reuse:"父版本复用",shared_wait:"等待共享读取",pending:"尚未读取"};
const readResults:Record<string,string> = {data:"返回数据",empty_success:"成功空响应",inherited:"继承父版本",timeout:"超时",rate_limited:"请求限流",unauthorized:"授权异常",unavailable:"来源不可用",invalid_payload:"数据校验失败",price_precision_overflow:"价格超出旧规则精度，需显式重试后按数据集精度四舍五入",history_source_configuration:"来源配置异常",shared_busy:"共享读取未完成",discarded:"结果未接纳",interrupted:"进程中断，结果未知",started:"读取中"};

export function CoverageView({versions,selected,view,page,requestPage,refresh,select}: {
  versions:Version[];selected?:string;view:string;page:number;requestPage:number;refresh:number;select:(key:string,value:string)=>void;
}) {
  const applicable = versions.filter(v=>v.status === "published" && v.payload_available !== false);
  const version = applicable.find(v=>v.id === selected) || applicable[0];
  const showingRequests = view === "requests";
  const coverage = useSnapshot<{items:Coverage[];total:number}>(version && !showingRequests ? `/market-data/versions/${version.id}/coverage?page=${page}&page_size=25` : null,refresh);
  const requests = useSnapshot<{items:{id:string;start:number;end:number;started_at:number;finished_at:number|null;result:string;read_kind:string;accepted:boolean;observations:number|null}[];total:number;failed:number;evidence_available:boolean}>(version && showingRequests ? `/market-data/versions/${version.id}/requests?page=${requestPage}&page_size=25` : null,refresh);
  return <section className="dc-management-section" aria-label="覆盖与质量内容">
    <div className="dc-evidence-tools"><label>覆盖固定版本<NativeSelect aria-label="覆盖固定版本" value={version?.id || ""} onChange={e=>select("version",e.target.value)}>
      {!applicable.length && <option value="">尚无适用发布版本</option>}
      {applicable.map(v=><option key={v.id} value={v.id}>{time(v.published_at)} · {v.id.slice(0,8)}</option>)}
    </NativeSelect></label><p>所选固定范围：{time(version?.start)} — {time(version?.end)}</p></div>
    <nav className="dc-tabs" aria-label="覆盖证据分类">{[["partitions","覆盖分区"],["requests","历史读取记录"]].map(([key,label])=><button key={key} aria-pressed={showingRequests === (key === "requests")} onClick={()=>select("view",key)}>{label}</button>)}</nav>
    <p className="dc-section-lead">未知、已证实闭市与冲突按所选版本的来源证据区分；空响应不证明闭市，请求失败次数不计入未知分钟。</p>
    {!version && <p role="status">尚无可读取覆盖证据的发布版本。</p>}
    {version && !showingRequests && <>
      <Feedback error={coverage.error} loading={coverage.loading} empty={!coverage.data}/>
      {coverage.data && <><div className="dc-evidence-list">
        <div className="dc-coverage-columns dc-business-head"><span>已查询分区</span><span>观测</span><span>未知</span><span>已证实闭市</span><span>冲突</span><span>详情</span></div>
        {coverage.data.items.map(c=><div className="dc-coverage-columns dc-business-row" key={`${c.timeframe || "M1"}:${c.start}`}>
          <div>{c.timeframe || "M1"} · {time(c.start)}<small>至 {time(c.end)}</small></div>
          <div><span className="dc-mobile-label">观测</span>{c.timeframe ? `${c.observed_bars} 根` : `${c.observed_minutes} 分钟`}</div><div><span className="dc-mobile-label">未知</span>{c.timeframe ? "不按分钟推断" : `${c.unknown_minutes} 分钟`}</div>
          <div><span className="dc-mobile-label">已证实闭市</span>{c.timeframe ? "—" : `${c.confirmed_closed_minutes} 分钟`}</div><div><span className="dc-mobile-label">冲突</span>{c.timeframe ? "—" : `${c.conflict_minutes} 分钟`}</div>
          <DetailDisclosure title={<>分区详情</>}>
            <p>固定版本：{version.id}</p><p>{time(c.start)} — {time(c.end)}；查询记录：{time(c.observed_at)}</p>
            {[["实际观测",c.observed_intervals],["未知区间",c.unknown_intervals],["已证实闭市",c.confirmed_closed_intervals],["证据冲突",c.conflict_intervals]].map(([label,intervals])=><section key={String(label)}><h3>{String(label)}</h3>{(intervals as number[][] | undefined)?.length ? (intervals as number[][]).map(([l,r])=><p key={l}>{time(l)} — {time(r)}</p>) : <p>无{String(label)}区间</p>}</section>)}
            <h3>来源会话依据</h3>{c.session_evidence?.length ? c.session_evidence.map((e,i)=><p key={i}><a href={e.source} target="_blank" rel="noreferrer">来源依据</a> · {e.kind} {e.applicability || ""}</p>) : <p>未提供来源会话证据；不据此推断闭市。</p>}
          </DetailDisclosure>
        </div>)}
        {!coverage.data.items.length && <p role="status">所选版本暂无覆盖分区记录。</p>}
      </div><Pager total={coverage.data.total} page={page} size={25} change={p=>select("coverage_page",String(p))}/></>}
    </>}
    {version && showingRequests && <>
      <Feedback error={requests.error} loading={requests.loading} empty={!requests.data}/>
      {requests.data && (requests.data.evidence_available ? <>
        <p>所选版本累计记录请求失败 {requests.data.failed} 次；共享缓存、父版本复用与上游请求分别标明。</p>
        <div className="dc-evidence-list"><div className="dc-request-columns dc-business-head"><span>请求范围</span><span>方式</span><span>结果</span><span>实际接纳</span><span>记录时间</span></div>
          {requests.data.items.map(r=><div key={r.id} className="dc-request-columns dc-business-row"><div>{time(r.start)}<small>至 {time(r.end)}</small></div><div><span className="dc-mobile-label">方式</span>{readKinds[r.read_kind] || r.read_kind}</div><div><span className="dc-mobile-label">结果</span>{readResults[r.result] || r.result}</div><div><span className="dc-mobile-label">实际接纳</span>{r.accepted ? `${r.observations ?? "继承"} · 已接纳` : "未接纳"}</div><time>{time(r.finished_at ?? r.started_at)}</time></div>)}
          {!requests.data.items.length && <p role="status">当前页暂无历史读取记录。</p>}
        </div><Pager total={requests.data.total} page={requestPage} size={25} change={p=>select("request_page",String(p))}/>
      </> : <p>该版本没有历史读取证据记录；不能据此认定曾经没有请求失败。</p>)}
    </>}
  </section>;
}

export function PublishedVersions({versions,refresh,select}: {versions:Version[];refresh:number;select:(key:string,value:string)=>void}) {
  const panel=useDetailPanel(), [selectedId,setSelected]=useState<string|null>(null), [comparison,setComparison]=useState(false);
  const selected=versions.find(v=>v.id===selectedId);
  return <section className="dc-management-section" aria-label="发布版本内容">
    <div className="dc-evidence-list"><div className="dc-version-columns dc-business-head"><span>发布时间</span><span>固定范围</span><span>状态</span><span>观测与覆盖</span><span>详情</span></div>
      {versions.map(v=><div className="dc-version-columns dc-business-row" key={v.id} id={`version-${v.id}`}>
        <time>{time(v.published_at)}</time><div>{time(v.start)}<small>至 {time(v.end)}</small></div><div>{v.payload_available === false ? "价格已回收，清单保留" : names[v.status] || v.status}</div><div><span className="dc-mobile-label">观测与覆盖</span>{versionObservations(v)}</div>
        <button aria-label={`查看版本 ${v.id.slice(0,8)} 详情`} onClick={()=>{setSelected(v.id);setComparison(false);select("version",v.id);panel.open();}}>详情</button>
      </div>)}
      {!versions.length && <p role="status">尚无发布版本。</p>}
    </div>
    {panel.opened && selected && <DetailPanel key={selected.id + (comparison ? "comparison" : "version")} title={comparison ? "与前版差异" : "固定版本详情"} close={panel.close}>
      {comparison ? <><button onClick={()=>setComparison(false)}>返回版本详情</button><VersionComparison version={selected.id} refresh={refresh}/></> : <VersionDetails version={selected} refresh={refresh} compare={()=>setComparison(true)}/>}
    </DetailPanel>}
  </section>;
}
function VersionDetails({version:v,refresh,compare}: {version:Version;refresh:number;compare:()=>void}) {
  const artifacts=useSnapshot<Period[]>(`/market-data/versions/${v.id}/artifacts`,refresh);
  return <>
    <dl className="dc-detail-facts"><div><dt>固定版本身份</dt><dd>{v.id}</dd></div><div><dt>发布时间</dt><dd>{time(v.published_at)}</dd></div><div><dt>固定范围</dt><dd>{time(v.start)} — {time(v.end)}</dd></div><div><dt>状态</dt><dd>{v.payload_available === false ? "价格已回收，清单保留" : names[v.status] || v.status}</dd></div><div><dt>观测与覆盖</dt><dd>{versionObservations(v)}</dd></div></dl>
    <p>{v.manifest?.price_rule_version === "dataset-precision-half-up-v1"
      ? `价格精度：${v.manifest.price_precision} 位；超出设定精度的价格自动四舍五入，未超精度的价格保持原值。`
      : v.manifest?.price_rule_version
        ? "此版本使用其他价格处理规则，请核对版本记录。"
        : "此版本沿用旧价格规则，保持已保存价格。"}</p>
    <h3>周期产物</h3><Feedback error={artifacts.error} loading={artifacts.loading} empty={!artifacts.data}/>
    {artifacts.data?.map(p=><p key={p.id}>{p.timeframe} · {names[p.status] || p.status} · 观测 {p.rows} / 完整 {p.complete_rows}</p>)}
    {v.status === "published" && <div className="dc-detail-actions">
      {v.payload_available !== false && <><OpenChart ticker={`MWH:${v.id}`} frame={artifacts.data?.find(p => p.rows > 0)?.timeframe} label="打开此版本"/></>}
      <button onClick={compare}>与前版差异</button>
    </div>}
  </>;
}
