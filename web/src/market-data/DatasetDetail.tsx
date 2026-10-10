import { NativeInput, NativeSelect } from "./NativeControls";
import { centerReturn, datasetTaskLocation, useReturnNavigation } from "./navigation";
import { PeriodOverview, CoverageView, PublishedVersions } from "./DatasetViews";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useCenter,
} from "./router";
import { api } from "./api";
import { OpenChart } from "./OpenChart";
import { useDirtyForm, useActionLock } from "./router";
import { Feedback } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { MaintenanceSettings } from "./MaintenanceSettings";
import { DatasetReferences } from "./DatasetReferences";
import { names, phase, time, type Dataset, type Period } from "./types";

export function DatasetDetail() {
  const navigate = useNavigate();
  const navigation = useReturnNavigation();
  const workspace = useCenter().workspace;
  const more = useRef<HTMLDetailsElement>(null);
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
  function select(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    if (name === "section") {
      const storageKey = `mw-dataset-sections:${workspace}:${id}`;
      const fields = ["view", "version", "frame", "before", "coverage_page", "request_page"];
      let memory: Record<string, Record<string, string>> = {};
      try { memory = JSON.parse(sessionStorage.getItem(storageKey) || "{}"); } catch { /* empty window memory */ }
      memory[section] = Object.fromEntries(fields.flatMap(key => params.has(key) ? [[key, params.get(key)!]] : []));
      if (memory[section].view === "delete") delete memory[section].view;
      for (const key of fields) { next.delete(key); if (memory[value]?.[key]) next.set(key, memory[value][key]); }
      sessionStorage.setItem(storageKey, JSON.stringify(memory));
    }
    if (name === "version" || name === "frame") next.delete("before");
    if (name === "version") { next.delete("coverage_page"); next.delete("request_page"); }
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
  const back = navigation.back?.location || centerReturn(params);
  const chosen = versions.data?.find(v => v.id === (params.get("version") || dataset?.periods.find(p=>p.timeframe === "M1")?.available_version_id || dataset?.latest_version_id));
  function closeMore() { if (more.current) more.current.open = false; }
  return <section className="data-center dc-dataset-detail">
    <div className="dc-dataset-top">
      <Link className="dc-breadcrumb" to={back}>{navigation.back ? `← 返回 ${navigation.back.label}` : "返回数据中心列表"}</Link>
      <Feedback error={result.error} loading={result.loading} empty={!dataset}/>
      {dataset && <>
        <div className="dc-dataset-hero">
          <div><h1>{dataset.display_symbol || dataset.logical_symbol}</h1>
            <p>{names[dataset.identity.source]} · {dataset.identity.basis.toUpperCase()} · {phase(dataset.aggregation_calendar)} · {dataset.provider_display_symbol || dataset.identity.provider_symbol}</p>
            <div className="dc-dataset-statusbar"><span className="dc-status-pill">{lifecycleStatus}</span><span>{maintenanceSummary}</span><span>可用到 {time(dataset.available_end)}</span></div>
          </div>
          <div className="dc-dataset-hero-actions" aria-label="行情快捷操作">
            {chosen?.status === "published" && chosen.payload_available !== false && <OpenChart ticker={`MWH:${chosen.id}`} label="打开图表"/>}
            <details ref={more} className="dc-more"><summary>更多操作</summary><div className="dc-more-actions">
              {chosen?.status === "published" && chosen.payload_available !== false && <Link to={`/replay?dataset_version=${chosen.id}`} onClick={closeMore}>用于回测</Link>}
              {dataset.maintenance.configured && <button disabled={busy} onClick={()=>{closeMore();void act(`/market-data/datasets/${id}/tasks`,{request_id:crypto.randomUUID()});}}>立即更新</button>}
              <div className="dc-more-danger"><button className="dc-danger-action" disabled={busy} onClick={()=>{closeMore();const next=new URLSearchParams(params);next.set("section","references");next.set("view","delete");setParams(next);}}>删除历史数据</button></div>
            </div></details>
          </div>
        </div>
        <nav className="dc-tabs dc-dataset-nav" aria-label="自建行情管理">
          {[["overview","概览"],["coverage","覆盖与质量"],["versions","发布版本"],["maintenance","维护设置"],["references","组合与引用"]].map(([key,label])=><button id={`dc-dataset-section-${key}`} key={key} aria-current={section===key?"page":undefined} onClick={()=>select("section",key)}>{label}</button>)}
        </nav>
      </>}
    </div>
    {dataset && <div className="dc-dataset-body">
      {busy && <p role="status">正在提交操作…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {dataset.maintenance.task_error && <p className="error">本次更新失败，旧版本仍可使用</p>}
      {section === "overview" && <section className="dc-management-section">
        <PeriodOverview dataset={dataset}/>
        <p>最近尝试：{time(dataset.maintenance.last_attempt)}；最近成功：{time(dataset.maintenance.last_success)}</p>
        <button id="dc-dataset-tasks" className="dc-text-link" onClick={()=>navigation.go(datasetTaskLocation(dataset),`${dataset.display_symbol || dataset.logical_symbol} 行情管理`)}>查看此行情的维护任务与记录</button>
      </section>}
      {section === "coverage" && <><Feedback error={versions.error} loading={versions.loading} empty={!versions.data}/><CoverageView versions={versions.data || []} selected={selectedVersion} view={params.get("view") || "partitions"} page={coveragePage} requestPage={requestPage} refresh={refresh} select={select}/></>}
      {section === "versions" && <><Feedback error={versions.error} loading={versions.loading} empty={!versions.data}/><PublishedVersions versions={versions.data || []} refresh={refresh} select={select}/></>}
          {section === "maintenance" && (
            <div className="dc-management-section dc-maintenance-section">
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
              <section className="dc-maintenance-state" aria-label="维护状态"><h2>维护状态</h2>
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
              </section>
              <fieldset className="dc-range-maintenance" disabled={busy}>
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
              <details className="dc-advanced-fields"><summary>按新日界创建数据集</summary>
              <fieldset disabled={busy}>
                <legend>独立日界</legend>
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
              </fieldset></details>
            </div>
          )}
      {section === "references" && <DatasetReferences key={id} id={id!} refresh={refresh} onDone={()=>setRefresh(r=>r+1)} deletion={params.get("view") === "delete"} archiveAvailable={dataset.maintenance.configured} onCancel={()=>{const next=new URLSearchParams(params);next.delete("view");setParams(next);}}/>}
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
    </div>}
  </section>;
}
