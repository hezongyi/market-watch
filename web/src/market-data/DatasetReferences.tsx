import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Feedback, Pager } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { names, phase, time } from "./types";

type ReferenceReport = {
  items: { kind: string; id: string; detail: string }[];
  can_reclaim: boolean;
  requires_archive: boolean;
  retains: string;
  impact: {
    dataset: {logical_symbol: string; aggregation_calendar: string;
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
}: {
  id: string;
  refresh: number;
  onDone: () => void;
}) {
  const report = useSnapshot<ReferenceReport>(
    `/market-data/datasets/${id}/references`,
    refresh,
  );
  const mappings = useSnapshot<{items: {id: string; current_account: boolean;
    target_identity: {provider_symbol: string; environment: string}; match: {rationale: string}}[]}>(`/market-data/datasets/${id}/mappings`, refresh);
  const [page, setPage] = useState(1);
  const composites = useSnapshot<{items: {id: string; calendar: string; active_revision_id: string;
    historical_source: string; mapping: {target_identity: {provider_symbol: string}}}[]; total: number}>(
    `/market-data/center/composites?dataset_id=${id}&page=${page}&page_size=25`, refresh);
  const [review, setReview] = useState<ReferenceReport | null>(null),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [result, setResult] = useState<any>(null);
  const request = useRef(crypto.randomUUID());
  const reviewButton = useRef<HTMLButtonElement>(null), errorBox = useRef<HTMLParagraphElement>(null);
  const [conflict, setConflict] = useState<ReferenceReport | null>(null);
  const current = conflict || report.data;
  async function openReview() {
    setBusy(true); setError("");
    try {
      const latest = await api<ReferenceReport>(`/market-data/datasets/${id}/references`);
      setConflict(null); setReview(latest); request.current = crypto.randomUUID();
    } catch (e) {
      setError(String(e)); requestAnimationFrame(() => errorBox.current?.focus());
    } finally {setBusy(false);}
  }
  async function reclaim() {
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      const response = await api(`/market-data/datasets/${id}/reclaim`, {
        request_id: request.current,
        expected_review_revision: review.impact.review_revision,
      });
      setResult(response);
      setReview(null); setConflict(null);
      onDone();
    } catch (e) {
      setError(String(e));
      if (e instanceof ApiError && e.code === "RECLAMATION_CHANGED") {
        setReview(null);
        try {setConflict(await api<ReferenceReport>(`/market-data/datasets/${id}/references`));}
        catch {setError("回收影响已变化，所列数据未删除；暂时无法读取最新清单，请稍后重新查看影响。");}
      }
      requestAnimationFrame(() => errorBox.current?.focus());
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dc-fields">
      <h2>引用与历史回收</h2>
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
          <p>管理此数据集的实时映射与组合；查看引用不会建立实时需求。</p>
          <Link to={`/market-data/datasets/${id}/mapping`}>配置与查看实时映射</Link>
          <Feedback error={mappings.error} loading={mappings.loading} empty={!mappings.data}/>
          {mappings.data && <details><summary>已保存映射（{mappings.data.items.length}）</summary>
            {mappings.data.items.length ? mappings.data.items.map(m => <p key={m.id}>
              OANDA · {m.target_identity.provider_symbol} · Bid · {m.target_identity.environment} · {m.current_account ? "当前账户" : "其他账户，需重新配置"}<br/>{m.match.rationale}
            </p>) : <p>尚未保存实时映射，查看此页不会建立组合。</p>}
          </details>}
          <Feedback error={composites.error} loading={composites.loading} empty={!composites.data}/>
          {composites.data && <><h3>已建立组合</h3>
            {composites.data.items.length ? composites.data.items.map(c => <p key={c.id}>
              <Link to={`/market-data/composites/${c.id}`}>{c.historical_source} → OANDA {c.mapping.target_identity.provider_symbol} · {c.calendar.toUpperCase()} · 查看组合与固定修订</Link>
            </p>) : <p>尚未建立组合；首次实际使用时准备。</p>}
            <Pager total={composites.data.total} page={page} size={25} change={setPage}/>
          </>}
          {current.items.length > 0 ? (
            <div className="dc-table">
              <table>
                <caption>阻止历史回收的引用与任务</caption>
                <thead>
                  <tr>
                    <th>依赖</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((item, i) => (
                    <tr key={`${item.kind}:${item.id}:${i}`}>
                      <td>{item.detail}</td>
                      <td>
                        {item.kind === "replay" ? (
                          <a href="/replay">查看历史演练</a>
                        ) : item.kind === "task" ? (
                          <a href={`/market-data?tab=tasks&dataset_id=${id}`}>
                            查看任务
                          </a>
                        ) : (
                          "保留引用，禁止回收"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>当前未发现阻止回收的引用。</p>
          )}
          {current.requires_archive && (
            <p>回收前请先在维护设置中暂停定时维护并归档。</p>
          )}
          <p>
            {current.retains}。共享来源缓存和其他数据集仍引用的分块保留。
          </p>
          {!review ? (
            <button
              ref={reviewButton}
              disabled={busy || !!report.error}
              onClick={() => void openReview()}
            >
              查看回收影响
            </button>
          ) : (
            <section className="panel" aria-label="确认历史回收">
              <h3>删除影响清单</h3>
              <p>{review.impact.dataset.logical_symbol} · {names[review.impact.dataset.identity.source]} · {review.impact.dataset.identity.provider_symbol} · {review.impact.dataset.identity.basis.toUpperCase()} · {phase(review.impact.dataset.aggregation_calendar)} · {review.impact.dataset.identity.environment}</p>
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
                <button disabled={busy} onClick={() => {setReview(null); requestAnimationFrame(() => reviewButton.current?.focus());}}>
                  取消回收
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
