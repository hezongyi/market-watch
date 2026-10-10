import { DetailDisclosure } from "./DetailPanel";
import { NativeInput, NativeSelect } from "./NativeControls";
import { centerReturn } from "./navigation";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "./router";
import { api } from "./api";
import { OpenChart } from "./OpenChart";
import { useDirtyForm, useActionLock } from "./router";
import { Feedback, Pager } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { MaintenanceSettings } from "./MaintenanceSettings";
import { DatasetReferences } from "./DatasetReferences";
import { VersionComparison } from "./VersionComparison";
import { names, phase, time, type Dataset, type Period } from "./types";

export function DatasetDetail() {
  const navigate = useNavigate();
  const { id } = useParams(),
    [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [notice, setNotice] = useState(""),
    [calendar, setCalendar] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [rangeKind, setRangeKind] = useState<"backfill" | "recheck">("backfill");
  const [rangeSaved, setRangeSaved] = useState(0);
  useDirtyForm("dataset-maintenance", [calendar, from, to, rangeKind], rangeSaved);
  const submission = useRef<{key: string; request: string} | null>(null);
  const actionLock = useActionLock();
  const section = params.get("section") || "overview",
    frame = params.get("frame") || "M1";
  const result = useSnapshot<Dataset>(
      `/market-data/center/datasets/${id}`,
      refresh,
    ),
    dataset = result.data;
  const versions = useSnapshot<any[]>(
    `/market-data/versions?dataset_id=${id}`,
    refresh,
  );
  const selectedVersion =
    params.get("version") ||
    (section === "chart"
      ? dataset?.periods.find((p) => p.timeframe === frame)
          ?.available_version_id
      : dataset?.latest_version_id);
  useEffect(() => {
    if (section === "chart" && selectedVersion && !params.get("version")) {
      const next = new URLSearchParams(params);
      next.set("version", selectedVersion);
      setParams(next, { replace: true });
    }
  }, [section, selectedVersion, params, setParams]);
  const selectedPeriods = useSnapshot<Period[]>(
    selectedVersion && section === "chart"
      ? `/market-data/versions/${selectedVersion}/artifacts`
      : null,
    refresh,
  );
  const frameReady = selectedPeriods.data?.some(
    (p) => p.timeframe === frame && p.status === "published" && p.rows > 0,
  );
  const lifecycleStatus = dataset?.maintenance.archived
    ? "已归档"
    : dataset?.maintenance.paused
      ? "维护已暂停"
      : dataset?.availability
        ? names[dataset.availability] || dataset.availability
        : "读取中";
  const maintenanceSummary = dataset?.maintenance.configured
    ? dataset.maintenance.paused
      ? "暂停定时维护"
      : dataset.maintenance.frequency === "daily"
        ? "每日维护"
        : "一次性维护"
    : "未配置维护";
  const coveragePage = Math.max(1, Number(params.get("coverage_page")) || 1);
  const requestPage = Math.max(1, Number(params.get("request_page")) || 1);
  const requests = useSnapshot<{
    items: {
      id: string;
      start: number;
      end: number;
      started_at: number;
      finished_at: number | null;
      result: string;
      read_kind: string;
      accepted: boolean;
      observations: number | null;
    }[];
    total: number;
    failed: number;
    evidence_available: boolean;
  }>(
    selectedVersion && section === "coverage"
      ? `/market-data/versions/${selectedVersion}/requests?page=${requestPage}&page_size=25`
      : null,
    refresh,
  );
  const coverage = useSnapshot<{
    items: {
      start: number;
      end: number;
      observed_at: number;
      observed_minutes: number;
      unknown_minutes: number;
      observed_intervals: number[][];
      unknown_intervals: number[][];
      confirmed_closed_minutes: number;
      confirmed_closed_intervals: number[][];
      conflict_minutes: number;
      conflict_intervals: number[][];
      session_evidence: {
        source: string;
        kind: string;
        applicability?: string;
      }[];
    }[];
    total: number;
  }>(
    selectedVersion && section === "coverage"
      ? `/market-data/versions/${selectedVersion}/coverage?page=${coveragePage}&page_size=25`
      : null,
    refresh,
  );
  function select(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    if (name === "section") next.delete("view");
    if (name === "version" || name === "frame") next.delete("before");
    setParams(next);
  }
  async function act(path: string, body: unknown) {
    if (!actionLock.acquire()) return;
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      setRefresh((r) => r + 1);
      setNotice("操作已提交，后台继续处理。");
    } catch (e) {
      setError(String(e));
    } finally {
      actionLock.release();
      setBusy(false);
    }
  }
  async function backfill() {
    if (!from || !to) {
      setError("请选择任务的起止交易日期（结束日不包含）。");
      return;
    }
    if (!actionLock.acquire()) return;
    setBusy(true);
    setError("");
    try {
      const [left, right] = await Promise.all(
        [from, to].map((d) =>
          api<{ start: number }>(
            `/market-data/date-boundary?date=${d}&calendar=${dataset?.aggregation_calendar}`,
          ),
        ),
      );
      const key = JSON.stringify([id, rangeKind, left.start, right.start]);
      if (submission.current?.key !== key) submission.current = {key, request: crypto.randomUUID()};
      await api(`/market-data/datasets/${id}/tasks`, {
        kind: rangeKind,
        start: left.start,
        end: right.start,
        request_id: submission.current.request,
      });
      setRefresh((r) => r + 1);
      setRangeSaved(value => value + 1);
      setNotice(rangeKind === "recheck" ? "指定区间复查已提交，旧版本保持固定。" : "指定区间补数已提交。");
    } catch (e) {
      setError(String(e));
    } finally {
      actionLock.release();
      setBusy(false);
    }
  }
  async function rephase() {
    if (!actionLock.acquire()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ dataset: Dataset }>(
        `/market-data/datasets/${id}/aggregation`,
        {
          aggregation_calendar: calendar,
          version_id: dataset?.latest_version_id,
        },
      );
      navigate(`/market-data/datasets/${result.dataset.id}`, {saved: true});
    } catch (e) {
      setError(String(e));
    } finally {
      actionLock.release();
      setBusy(false);
    }
  }
  return (
    <section className="data-center dc-dataset-detail">
      <Link className="dc-breadcrumb" to={centerReturn(params)}>返回数据中心列表</Link>
      <Feedback
        error={result.error}
        loading={result.loading}
        empty={!dataset}
      />
      {dataset && (
        <>
          <div className="dc-dataset-hero">
            <div>
              <h1>{dataset.display_symbol || dataset.logical_symbol}</h1>
              <p>
                {names[dataset.identity.source]} · Bid ·{" "}
                {phase(dataset.aggregation_calendar)} ·{" "}
                {dataset.provider_display_symbol || dataset.identity.provider_symbol}
              </p>
            </div>
            <div className="dc-dataset-hero-actions" aria-label="行情快捷操作">
              {dataset.usable_timeframes.length > 0 && (
                <OpenChart ticker={`MWH:${dataset.periods.find(p => p.timeframe === "M1")?.available_version_id || dataset.latest_version_id}`} />
              )}
              {dataset.latest_version_id && (
                <Link to={`/replay?dataset_version=${dataset.latest_version_id}`}>用于回测</Link>
              )}
              {dataset.maintenance.configured && (
                <button
                  disabled={busy}
                  onClick={() => void act(`/market-data/datasets/${id}/tasks`, { request_id: crypto.randomUUID() })}
                >
                  立即更新
                </button>
              )}
              <button className="dc-danger-action" onClick={() => {
                const next = new URLSearchParams(params);
                next.set("section", "references"); next.set("view", "delete");
                setParams(next);
              }}>删除历史数据</button>
            </div>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="dc-dataset-statusbar">
            <span className={`dc-status-pill state-${dataset.maintenance.archived ? "archived" : dataset.maintenance.paused ? "paused" : dataset.availability}`}>{lifecycleStatus}</span>
            <span>{maintenanceSummary}</span>
            <span>可用到 {time(dataset.available_end)}</span>
            {dataset.maintenance.task_error && <span className="error">本次更新失败，旧版本仍可使用</span>}
          </div>
          <nav className="dc-tabs dc-dataset-nav" aria-label="自建行情管理">
            {[
              ["overview", "概览"],
              ["coverage", "覆盖与质量"],
              ["versions", "发布版本"],
              ["maintenance", "维护设置"],
              ["references", "组合与引用"],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-current={section === key ? "page" : undefined}
                onClick={() => select("section", key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {section === "overview" && (
            <>
              <div className="dc-table">
                <table>
                  <thead>
                    <tr>
                      <th>周期</th>
                      <th>可用性</th>
                      <th>观测柱</th>
                      <th>覆盖完整柱</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataset.periods.map((p) => (
                      <tr key={p.id}>
                        <td>{p.timeframe}</td>
                        <td>
                          {names[p.status]}
                          {p.available_version_id &&
                            p.available_version_id !== p.version_id && (
                              <span>
                                旧发布仍可用 · {time(p.available_end)}
                              </span>
                            )}
                        </td>
                        <td>{p.rows}</td>
                        <td>{p.complete_rows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                最近尝试：{time(dataset.maintenance.last_attempt)}；最近成功：
                {time(dataset.maintenance.last_success)}
              </p>
              <Link to={`/market-data?tab=tasks&dataset_id=${id}`}>
                查看维护任务
              </Link>
            </>
          )}
          {section === "coverage" && (
            <>
              <h2>已发布 M1 覆盖</h2>
              <label>
                覆盖固定版本
                <NativeSelect
                  value={selectedVersion || ""}
                  onChange={(e) => {
                    const next = new URLSearchParams(params);
                    next.set("version", e.target.value);
                    next.delete("coverage_page");
                    next.delete("request_page");
                    setParams(next);
                  }}
                >
                  {versions.data
                    ?.filter(
                      (v) =>
                        v.status === "published" &&
                        v.payload_available !== false,
                    )
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {time(v.start)} — {time(v.end)}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <p>
                {time(dataset.available_start)} 至 {time(dataset.available_end)}
              </p>
              <p>
                最新M1清单未观测分钟：{dataset.unknown_minutes ?? "尚未发布"}{" "}
                分钟。下表按所选固定版本的来源证据区分未知与已证实闭市；空响应不证明闭市。
              </p>
              <p>
                各周期完整性按该父版本与来源会话证据判断。下列未知区间保存查询事实，不推断闭市或补造价格。
              </p>
              <Feedback
                error={coverage.error}
                loading={coverage.loading}
                empty={!coverage.data}
              />
              {coverage.data && (
                <>
                  <div className="dc-table">
                    <table>
                      <thead>
                        <tr>
                          <th>已查询分区</th>
                          <th>实际观测</th>
                          <th>未知区间</th>
                          <th>已证实闭市</th>
                          <th>证据冲突</th>
                          <th>查询时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {coverage.data.items.map((c) => (
                          <tr key={c.start}>
                            <td>
                              {time(c.start)}
                              <span>至 {time(c.end)}</span>
                            </td>
                            <td>
                              {c.observed_minutes} 分钟
                              <DetailDisclosure title={<>查看实际观测区间</>}>
                                {c.observed_intervals.map(([l, r]) => (
                                  <p key={l}>
                                    {time(l)} 至 {time(r)}
                                  </p>
                                ))}
                              </DetailDisclosure>
                            </td>
                            <td>
                              {c.unknown_minutes} 分钟
                              <DetailDisclosure title={<>查看未知区间</>}>
                                {c.unknown_intervals.length ? (
                                  c.unknown_intervals.map(([l, r]) => (
                                    <p key={l}>
                                      {time(l)} 至 {time(r)}
                                    </p>
                                  ))
                                ) : (
                                  <p>无未知区间</p>
                                )}
                              </DetailDisclosure>
                            </td>
                            <td>
                              {c.confirmed_closed_minutes} 分钟
                              <DetailDisclosure title={<>查看闭市区间与依据</>}>
                                {c.confirmed_closed_intervals.length ? (
                                  c.confirmed_closed_intervals.map(([l, r]) => (
                                    <p key={l}>
                                      {time(l)} 至 {time(r)}
                                    </p>
                                  ))
                                ) : (
                                  <p>无已证实闭市区间</p>
                                )}
                                {c.session_evidence.map((e, i) => (
                                  <p key={i}>
                                    <a
                                      href={e.source}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      来源依据
                                    </a>
                                    {e.applicability
                                      ? ` · ${e.applicability}`
                                      : ""}
                                  </p>
                                ))}
                              </DetailDisclosure>
                            </td>
                            <td>
                              {c.conflict_minutes} 分钟
                              <DetailDisclosure title={<>查看观测冲突</>}>
                                {c.conflict_intervals.length ? (
                                  c.conflict_intervals.map(([l, r]) => (
                                    <p key={l}>
                                      {time(l)} 至 {time(r)}
                                    </p>
                                  ))
                                ) : (
                                  <p>无已知冲突</p>
                                )}
                                <p>
                                  来源观测与闭市依据不一致时保留价格，不能据此认定完整覆盖。
                                </p>
                              </DetailDisclosure>
                            </td>
                            <td>{time(c.observed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager
                    total={coverage.data.total}
                    page={coveragePage}
                    size={25}
                    change={(p) => select("coverage_page", String(p))}
                  />
                </>
              )}
              <h2>历史读取记录</h2>
              <p>
                请求失败范围与最终覆盖分别记录；重试成功不会抹去失败，失败不额外计入未知分钟。
              </p>
              <Feedback
                error={requests.error}
                loading={requests.loading}
                empty={!requests.data}
              />
              {requests.data &&
                (requests.data.evidence_available ? (
                  <>
                    <p>
                      共 {requests.data.total} 次读取，其中失败{" "}
                      {requests.data.failed}{" "}
                      次。共享缓存、父版本复用与上游请求分别标明。
                    </p>
                    <div className="dc-table">
                      <table>
                        <caption>所选固定版本的历史读取与请求失败证据</caption>
                        <thead>
                          <tr>
                            <th>请求范围</th>
                            <th>方式</th>
                            <th>结果</th>
                            <th>实际接纳</th>
                            <th>记录时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {requests.data.items.map((r) => (
                            <tr key={r.id}>
                              <td>
                                {time(r.start)}
                                <span>至 {time(r.end)}</span>
                              </td>
                              <td>
                                {{
                                  supplier_request: "上游请求",
                                  shared_cache: "共享缓存",
                                  parent_reuse: "父版本复用",
                                  shared_wait: "等待共享读取",
                                  pending: "尚未读取",
                                }[r.read_kind] || r.read_kind}
                              </td>
                              <td>
                                {{
                                  data: "返回数据",
                                  empty_success: "成功空响应",
                                  inherited: "继承父版本",
                                  timeout: "超时",
                                  rate_limited: "请求限流",
                                  unauthorized: "授权异常",
                                  unavailable: "来源不可用",
                                  invalid_payload: "数据校验失败",
                                  price_precision_overflow: "价格精度不符",
                                  history_source_configuration: "来源配置异常",
                                  shared_busy: "共享读取未完成",
                                  discarded: "结果未接纳",
                                  interrupted: "进程中断，结果未知",
                                  started: "读取中",
                                }[r.result] || r.result}
                              </td>
                              <td>
                                {r.accepted
                                  ? `${r.observations ?? "继承"} · 已接纳`
                                  : "未接纳"}
                              </td>
                              <td>{time(r.finished_at ?? r.started_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager
                      total={requests.data.total}
                      page={requestPage}
                      size={25}
                      change={(p) => select("request_page", String(p))}
                    />
                  </>
                ) : (
                  <p>
                    该版本没有历史读取证据记录；不能据此认定曾经没有请求失败。
                  </p>
                ))}
            </>
          )}
          {section === "versions" && (
            <>
              <Feedback
                error={versions.error}
                loading={versions.loading}
                empty={!versions.data}
              />
              <div className="dc-table">
                <table>
                  <thead>
                    <tr>
                      <th>固定范围</th>
                      <th>状态</th>
                      <th>发布时间</th>
                      <th>观测/未知分钟</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.data?.map((v) => (
                      <tr key={v.id}>
                        <td>
                          {time(v.start)}
                          <span>至 {time(v.end)}</span>
                        </td>
                        <td>
                          {v.payload_available === false
                            ? "价格已回收 · 清单保留"
                            : names[v.status] || v.status}
                        </td>
                        <td>
                          {time(v.published_at)}
                        </td>
                        <td>
                          {v.manifest?.rows ?? "—"} /{" "}
                          {v.manifest?.unknown_minutes ?? "—"}
                        </td>
                        <td>
                          {v.status === "published" &&
                            v.payload_available !== false && (
                              <><OpenChart ticker={`MWH:${v.id}`} label="打开此版本" />
                              <span><Link to={`/replay?dataset_version=${v.id}`}>用于回测</Link></span></>
                            )}
                          {v.status === "published" && <button onClick={() => select("version", v.id)}>与前版差异</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selectedVersion && <VersionComparison version={selectedVersion} refresh={refresh}/>}
            </>
          )}
          {section === "maintenance" && (
            <div className="dc-fields dc-management-section dc-maintenance-section">
              <h2>维护计划</h2>
              <p className="dc-section-lead">维护计划控制后续数据更新；暂停和归档不会删除已发布历史。</p>
              <MaintenanceSettings
                key={dataset.id}
                dataset={dataset}
                onSaved={() => setRefresh((r) => r + 1)}
              />
              <p>
                {dataset.maintenance.configured
                  ? `${dataset.maintenance.frequency === "daily" ? "每日维护" : "一次性"} · ${dataset.maintenance.timezone}；下次：${time(dataset.maintenance.next_at)}`
                  : "未配置维护"}
              </p>
              {dataset.maintenance.configured && (
                <div className="dc-lifecycle-actions" aria-label="维护生命周期操作">
                  <button
                    className={!dataset.maintenance.archived ? "dc-danger-action" : undefined}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/market-data/datasets/${id}/maintenance/control`,
                        {
                          action: dataset.maintenance.paused
                            ? "resume"
                            : "pause",
                        },
                      )
                    }
                  >
                    {dataset.maintenance.paused ? "恢复维护" : "暂停定时维护"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/market-data/datasets/${id}/maintenance/control`,
                        {
                          action: dataset.maintenance.archived
                            ? "unarchive"
                            : "archive",
                        },
                      )
                    }
                  >
                    {dataset.maintenance.archived ? "取消归档" : "归档条目"}
                  </button>
                </div>
              )}
              <p>
                暂停定时维护保留已发布版本，策略需要的实时行情继续运行。归档隐藏默认列表，引用仍保留。
              </p>
              <fieldset disabled={busy}>
                <legend>指定区间维护</legend>
                <label>任务类型<NativeSelect aria-label="任务类型" value={rangeKind} onChange={e => setRangeKind(e.target.value as "backfill" | "recheck")}>
                  <option value="backfill">补数</option><option value="recheck">复查已有区间</option>
                </NativeSelect></label>
                <label>
                  起始交易日期
                  <NativeInput
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  结束交易日期（不包含）
                  <NativeInput
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <button disabled={busy} onClick={() => void backfill()}>
                  {rangeKind === "recheck" ? "提交复查" : "提交补数"}
                </button>
              </fieldset>
              <fieldset disabled={busy}>
                <legend>按新日界创建数据集</legend>
                <label>
                  目标日界
                  <NativeSelect
                    value={calendar}
                    onChange={(e) => setCalendar(e.target.value)}
                  >
                    <option value="">请选择</option>
                    <option value="ny17">NY17</option>
                    <option value="utc0">UTC0</option>
                  </NativeSelect>
                </label>
                <p>复用最新发布 M1；旧回测和组合保留原口径。</p>
                <button
                  disabled={busy || !calendar}
                  onClick={() => void rephase()}
                >
                  创建新日界数据集
                </button>
              </fieldset>
            </div>
          )}
          {section === "references" && (
            <DatasetReferences
              key={id}
              id={id!}
              refresh={refresh}
              onDone={() => setRefresh((r) => r + 1)}
              deletion={params.get("view") === "delete"}
              archiveAvailable={dataset.maintenance.configured}
              onCancel={() => navigate(centerReturn(params))}
            />
          )}
          {section === "chart" && (
            <>
              <div className="dc-filters">
                <label>
                  周期
                  <NativeSelect
                    value={frame}
                    onChange={(e) => select("frame", e.target.value)}
                  >
                    {!selectedPeriods.data?.some(
                      (p) => p.timeframe === frame,
                    ) && (
                      <option value={frame} disabled>
                        {frame} · 尚未发布
                      </option>
                    )}
                    {selectedPeriods.data?.map((p) => (
                      <option
                        key={p.timeframe}
                        value={p.timeframe}
                        disabled={p.status !== "published" || p.rows === 0}
                      >
                        {p.timeframe}
                        {p.status !== "published"
                          ? " · 准备中"
                          : p.rows === 0
                            ? " · 无观测"
                            : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  固定版本
                  <NativeSelect
                    value={selectedVersion}
                    onChange={(e) => select("version", e.target.value)}
                  >
                    {versions.data
                      ?.filter(
                        (v) =>
                          v.status === "published" &&
                          v.payload_available !== false,
                      )
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {time(v.end)}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
              </div>
              <Feedback
                error={selectedPeriods.error}
                loading={selectedPeriods.loading}
                empty={!selectedPeriods.data}
              />
              {selectedPeriods.data && !frameReady && (
                <p role="status">
                  所选固定版本的该周期尚未发布或没有观测，请选择可用周期。
                </p>
              )}
              <p>将所选固定版本及周期应用到打开窗口时的目标图格。</p>
              {selectedVersion && <OpenChart ticker={`MWH:${selectedVersion}`} frame={frame} label="打开此版本" />}

            </>
          )}
        </>
      )}
    </section>
  );
}
