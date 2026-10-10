import { DetailDisclosure } from "./DetailPanel";
import { useContext } from "react";
import { NativeUiContext } from "./NativeControls";
import { useEffect, useRef, useState } from "react";
import { Link, useActionLock, useMounted, useSearchParams } from "./router";
import { api, ApiError } from "./api";
import { Feedback, Pager } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { names, phase, time } from "./types";

type ReferenceReport = {
  items: { kind: string; id: string; detail: string }[];
  can_reclaim: boolean;
  requires_archive: boolean;
  retains: string;
  impact: {
    dataset: {display_symbol?: string; provider_display_symbol?: string; logical_symbol: string; aggregation_calendar: string;
      identity: {source: string; provider_symbol: string; basis: string; environment: string}};
    versions: {version_id: string; start: number; end: number; status: string;
      disposition: string; observed_minutes: number | null; unknown_minutes: number | null;
      periods: {timeframe: string; status: string; rows: number}[]}[];
    review_revision: string; space_meaning: string;
    payload_totals: {target_versions: number; inline_m1_payload_bytes: number;
      period_payload_bytes: number; indicator_payload_bytes: number; unique_source_payload_bytes: number;
      retained_shared_source_blobs: number; retained_shared_source_payload_bytes: number};
  };
};

export function DatasetReferences({
  id,
  refresh,
  onDone,
  deletion = false,
  archiveAvailable = false,
  onCancel,
}: {
  id: string;
  refresh: number;
  onDone: () => void;
  deletion?: boolean;
  archiveAvailable?: boolean;
  onCancel?: () => void;
}) {
  const nativeUi=useContext(NativeUiContext);
  const report = useSnapshot<ReferenceReport>(
    `/market-data/datasets/${id}/references`,
    refresh,
  );
  const mappings = useSnapshot<{items: {id: string; current_account: boolean;
    target_display_symbol?: string; target_identity: {provider_symbol: string; environment: string}; match: {rationale: string}}[]}>(`/market-data/datasets/${id}/mappings`, refresh);
  const [page, setPage] = useState(1);
  const composites = useSnapshot<{items: {id: string; calendar: string; active_revision_id: string;
    historical_source: string; mapping: {target_display_symbol?: string; target_identity: {provider_symbol: string}}}[]; total: number}>(
    `/market-data/center/composites?dataset_id=${id}&page=${page}&page_size=25`, refresh);
  const [review, setReview] = useState<ReferenceReport | null>(null),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [result, setResult] = useState<any>(null);
  const request = useRef(crypto.randomUUID());
  const [params] = useSearchParams();
  const referencesParams = new URLSearchParams(params);
  referencesParams.delete("view"); referencesParams.set("section", "references");
  const maintenanceParams = new URLSearchParams(referencesParams);
  maintenanceParams.set("section", "maintenance");
  const actionLock = useActionLock();
  const mounted = useMounted(), startedReview = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null), errorBox = useRef<HTMLParagraphElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [conflict, setConflict] = useState<ReferenceReport | null>(null);
  const current = conflict || report.data;
  useEffect(() => {
    if (!deletion) { startedReview.current = false; return; }
    if (!deletion || startedReview.current || !report.data) return;
    startedReview.current = true;
    setReview(report.data); request.current = crypto.randomUUID();
    requestAnimationFrame(() => reviewHeading.current?.focus());
  }, [deletion, report.data]);
  async function openReview() {
    if (!actionLock.acquire()) return;
    setBusy(true); setError("");
    try {
      const latest = await api<ReferenceReport>(`/market-data/datasets/${id}/references`);
      if (!mounted.current) return;
      setConflict(null); setReview(latest); request.current = crypto.randomUUID();
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e)); requestAnimationFrame(() => errorBox.current?.focus());
    } finally {actionLock.release(); if (mounted.current) setBusy(false);}
  }
  async function archive() {
    if (!actionLock.acquire()) return;
    setBusy(true); setError("");
    // Both commands are idempotent. Stop scheduling before hiding the entry;
    // active tasks/references remain protected by the final server review.
    try {
      await api(`/market-data/datasets/${id}/maintenance/control`, { action: "pause" });
      await api(`/market-data/datasets/${id}/maintenance/control`, { action: "archive" });
      const latest = await api<ReferenceReport>(`/market-data/datasets/${id}/references`);
      if (!mounted.current) return;
      setConflict(latest); setReview(latest); request.current = crypto.randomUUID(); onDone();
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e)); setReview(null); onDone();
      requestAnimationFrame(() => errorBox.current?.focus());
    } finally {actionLock.release(); if (mounted.current) setBusy(false);}
  }
  async function reclaim() {
    if (!review || !actionLock.acquire()) return;
    if(nativeUi && !await nativeUi.confirm({title:"确认删除历史数据",body:`将删除清单中的 ${review.impact.payload_totals.target_versions} 个版本的价格数据。此操作不能撤销；身份和发布清单保留。`})) {actionLock.release();return;}
    setBusy(true);
    setError("");
    try {
      const response = await api(`/market-data/datasets/${id}/reclaim`, {
        request_id: request.current,
        expected_review_revision: review.impact.review_revision,
      });
      if (!mounted.current) return;
      setResult(response);
      setReview(null); setConflict(null);
      onDone();
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e));
      if (e instanceof ApiError && e.code === "RECLAMATION_CHANGED") {
        setReview(null);
        try {
          const latest = await api<ReferenceReport>(`/market-data/datasets/${id}/references`);
          if (!mounted.current) return;
          setConflict(latest);
        } catch {
          if (!mounted.current) return;
          setError("回收影响已变化，所列数据未删除；暂时无法读取最新清单，请稍后重新查看影响。");
        }
      }
      requestAnimationFrame(() => errorBox.current?.focus());
    } finally {
      actionLock.release();
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="dc-management-section dc-reference-section">
      <h2>{deletion ? "删除历史数据" : "引用与历史回收"}</h2>
      <Feedback
        error={report.error}
        loading={report.loading}
        empty={!report.data}
      />
      {error && (
        <p ref={errorBox} tabIndex={-1} role="alert" className="error">
          {error}
        </p>
      )}
      {current && (
        <>
          <p>暂停维护并归档后，条目从默认列表移除，可在“已归档”列表查看；确认删除后才回收历史价格及周期。来源身份、发布清单和引用记录保留。</p>
          {deletion && <Link to={`/market-data/datasets/${id}?${referencesParams}`}>查看组合与引用</Link>}
          {!deletion && <>
          <p>管理此数据集的实时映射与组合；查看引用不会建立实时需求。</p>
          <Link to={`/market-data/datasets/${id}/mapping`}>配置与查看实时映射</Link>
          <Feedback error={mappings.error} loading={mappings.loading} empty={!mappings.data}/>
          {mappings.data && <DetailDisclosure title={<>已保存映射（{mappings.data.items.length}）</>}>
            {mappings.data.items.length ? mappings.data.items.map(m => <p key={m.id}>
              OANDA · {m.target_display_symbol || m.target_identity.provider_symbol} · Bid · {m.target_identity.environment} · {m.current_account ? "当前账户" : "其他账户，需重新配置"}<br/>{m.match.rationale}
            </p>) : <p>尚未保存实时映射，查看此页不会建立组合。</p>}
          </DetailDisclosure>}
          <Feedback error={composites.error} loading={composites.loading} empty={!composites.data}/>
          {composites.data && <><h3>组合引用（{composites.data.total}）</h3>
            {composites.data.items.length ? composites.data.items.map(c => <p key={c.id}>
              <Link to={`/market-data/composites/${c.id}`}>{c.historical_source} → OANDA {c.mapping.target_display_symbol || c.mapping.target_identity.provider_symbol} · {c.calendar.toUpperCase()} · 查看组合与固定修订</Link>
            </p>) : <p>尚未建立组合；首次实际使用时准备。</p>}
            <Pager total={composites.data.total} page={page} size={25} change={setPage}/>
          </>}
          </>}
          <section aria-label="删除保护引用"><h3>删除保护</h3><p>以下接口返回的引用与任务会阻止删除历史价格，直到依赖按现有业务流程解除。</p>
            {current.items.length ? [...new Set(current.items.map(item=>item.kind))].map(kind=><section key={kind}>
              <h4>{({composite:"组合引用",replay:"回测引用",task:"维护任务",chart_alert:"预警版本引用",strategy:"策略引用",workspace:"工作区引用",signal:"策略事件",derivation:"其他派生版本",demand:"有效使用需求",live:"实时采集"} as Record<string,string>)[kind] || kind}（{current.items.filter(item=>item.kind===kind).length}）</h4>
              <div className="dc-reference-list">{current.items.filter(item=>item.kind===kind).map((item,i)=><div className="dc-reference-row" key={`${item.id}:${i}`}>
                <div>{item.detail}<small>阻止当前删除操作</small></div>
                <DetailDisclosure title={<>引用详情</>}><dl className="dc-detail-facts"><div><dt>引用类型</dt><dd>{item.kind}</dd></div><div><dt>对象身份</dt><dd>{item.id}</dd></div><div><dt>实际引用说明</dt><dd>{item.detail}</dd></div></dl><p>该接口未提供独立版本字段；版本信息以实际引用说明为准。</p></DetailDisclosure>
                {item.kind === "replay" ? <Link to="/replay">查看历史演练</Link> : item.kind === "task" ? <Link to={`/market-data?tab=tasks&status=all&dataset_id=${id}`}>查看任务</Link> : null}
              </div>)}</div>
            </section>) : <p>当前未发现阻止回收的引用。</p>}
          </section>
          {current.requires_archive && (
            <div className="dc-fields">
              <p>删除前需要暂停定时维护并归档。已有价格和引用会保留，正在运行的任务不会被取消。</p>
              {archiveAvailable ? <button disabled={busy || !!report.error} onClick={() => void archive()}>
                {busy ? "正在处理…" : "暂停维护并归档"}
              </button> : <Link to={`/market-data/datasets/${id}?${maintenanceParams}`}>查看维护设置</Link>}
            </div>
          )}
          <p>
            {current.retains}。共享来源缓存和其他数据集仍引用的分块保留。
          </p>
          {!review ? (
            <div className="dc-actions"><button
              ref={reviewButton}
              disabled={busy || !!report.error}
              onClick={() => void openReview()}
            >
              查看回收影响
            </button>
            {deletion && <button disabled={busy} onClick={onCancel}>返回列表</button>}
            </div>
          ) : (
            <section className="panel" aria-label="确认历史回收">
              <h3 ref={reviewHeading} tabIndex={-1}>删除影响清单</h3>
              <p>{review.impact.dataset.display_symbol || review.impact.dataset.logical_symbol} · {names[review.impact.dataset.identity.source]} · {review.impact.dataset.provider_display_symbol || review.impact.dataset.identity.provider_symbol} · {review.impact.dataset.identity.basis.toUpperCase()} · {phase(review.impact.dataset.aggregation_calendar)} · {review.impact.dataset.identity.environment}</p>
              <div className="dc-table"><table><caption>所列固定版本与价格范围</caption>
                <thead><tr><th>版本与范围</th><th>观测 / 未知分钟</th><th>周期</th><th>处理</th></tr></thead>
                <tbody>{review.impact.versions.map(v => <tr key={v.version_id}>
                  <td>{v.version_id}<span>{time(v.start)} 至 {time(v.end)}</span></td>
                  <td>{v.observed_minutes ?? "—"} / {v.unknown_minutes ?? "—"}</td>
                  <td>{v.periods.map(p => `${p.timeframe} · ${names[p.status] || p.status} (${p.rows})`).join("； ") || "无周期产物"}</td>
                  <td>{v.disposition === "delete_payload" ? "删除价格及周期，保留清单" : v.disposition === "already_reclaimed" ? "已回收，保留清单" : "受保护，不能删除"}</td>
                </tr>)}</tbody>
              </table></div>
              <p>压缩内容统计：独立M1 {review.impact.payload_totals.inline_m1_payload_bytes} 字节；周期 {review.impact.payload_totals.period_payload_bytes} 字节；指标 {review.impact.payload_totals.indicator_payload_bytes} 字节；唯一来源内容 {review.impact.payload_totals.unique_source_payload_bytes} 字节。其中共享内容保留 {review.impact.payload_totals.retained_shared_source_blobs} 块 / {review.impact.payload_totals.retained_shared_source_payload_bytes} 字节。</p>
              <p>{review.impact.space_meaning}</p>
              {review.impact.payload_totals.target_versions === 0 && <p role="status">没有可删除的历史价格。归档后可在“已归档”列表查看保留记录。</p>}
              <p>
                回收此数据集全部无引用历史价格及周期产物。此操作不能撤销；原版本仅保留身份和发布清单，不能再用于图表或回测。以后重新维护会产生新版本。
              </p>
              <div className="dc-actions">
                <button
                  disabled={busy || !!report.error || !review.can_reclaim || review.impact.payload_totals.target_versions === 0}
                  onClick={() => void reclaim()}
                >
                  删除所列数据
                </button>
                <button disabled={busy} onClick={() => {if (deletion) onCancel?.(); else {setReview(null); requestAnimationFrame(() => reviewButton.current?.focus());}}}>
                  {deletion ? "取消删除" : "取消回收"}
                </button>
              </div>
            </section>
          )}
          {result && (
            <p role="status">
              已回收 {result.versions}{" "}
              个版本的价格数据。身份和发布清单保留；数据库空间可供后续写入复用。
            </p>
          )}
        </>
      )}
    </div>
  );
}
