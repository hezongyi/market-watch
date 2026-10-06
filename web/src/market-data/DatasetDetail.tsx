import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, type Bar } from "../api";
import Chart from "../Chart";
import { Feedback, Pager } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { MaintenanceSettings } from "./MaintenanceSettings";
import { DatasetReferences } from "./DatasetReferences";
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
  const before = params.get("before");
  const coveragePage = Math.max(1, Number(params.get("coverage_page")) || 1);
  const coverage = useSnapshot<{
    items: {
      start: number;
      end: number;
      observed_at: number;
      observed_minutes: number;
      unknown_minutes: number;
      observed_intervals: number[][];
      unknown_intervals: number[][];
    }[];
    total: number;
  }>(
    selectedVersion && section === "coverage"
      ? `/market-data/versions/${selectedVersion}/coverage?page=${coveragePage}&page_size=25`
      : null,
    refresh,
  );
  const bars = useSnapshot<{ bars: Bar[]; next_before: number | null }>(
    selectedVersion && section === "chart" && frameReady
      ? `/market-data/versions/${selectedVersion}/chart?timeframe=${frame}&count=2000${before !== null ? `&before=${encodeURIComponent(before)}` : ""}`
      : null,
    refresh,
  );
  function select(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    if (name === "version" || name === "frame") next.delete("before");
    setParams(next);
  }
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      setRefresh((r) => r + 1);
      setNotice("操作已提交，后台继续处理。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function backfill() {
    if (!from || !to) {
      setError("请选择补数的起止交易日期（结束日不包含）。");
      return;
    }
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
      await api(`/market-data/datasets/${id}/tasks`, {
        kind: "backfill",
        start: left.start,
        end: right.start,
        request_id: crypto.randomUUID(),
      });
      setRefresh((r) => r + 1);
      setNotice("指定区间补数已提交。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function rephase() {
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
      navigate(`/market-data/datasets/${result.dataset.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="data-center">
      <Link to="/market-data">返回自建行情</Link>
      <Feedback
        error={result.error}
        loading={result.loading}
        empty={!dataset}
      />
      {dataset && (
        <>
          <div className="dc-heading">
            <div>
              <h1>{dataset.logical_symbol}</h1>
              <p>
                {names[dataset.identity.source]} · Bid ·{" "}
                {phase(dataset.aggregation_calendar)} ·{" "}
                {dataset.identity.provider_symbol}
              </p>
            </div>
            <div className="dc-actions">
              {dataset.usable_timeframes.length > 0 && (
                <Link to={`?section=chart`}>打开历史图表</Link>
              )}
              {dataset.latest_version_id && (
                <Link
                  to={`/replay?dataset_version=${dataset.latest_version_id}`}
                >
                  用于回测
                </Link>
              )}
              {dataset.maintenance.configured && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(`/market-data/datasets/${id}/tasks`, {
                      request_id: crypto.randomUUID(),
                    })
                  }
                >
                  立即更新
                </button>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <p>
            可用到 {time(dataset.available_end)}
            {dataset.maintenance.task_error
              ? " · 本次更新失败，旧版本仍可使用"
              : ""}
          </p>
          <nav className="dc-tabs" aria-label="自建行情详情">
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
              <p>
                {time(dataset.available_start)} 至 {time(dataset.available_end)}
              </p>
              <p>
                未知区间合计：{dataset.unknown_minutes ?? "尚未发布"}{" "}
                分钟。空响应不证明闭市；范围摘要不代表中间连续。
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
                              <details>
                                <summary>查看实际观测区间</summary>
                                {c.observed_intervals.map(([l, r]) => (
                                  <p key={l}>
                                    {time(l)} 至 {time(r)}
                                  </p>
                                ))}
                              </details>
                            </td>
                            <td>
                              {c.unknown_minutes} 分钟
                              <details>
                                <summary>查看未知区间</summary>
                                {c.unknown_intervals.length ? (
                                  c.unknown_intervals.map(([l, r]) => (
                                    <p key={l}>
                                      {time(l)} 至 {time(r)}
                                    </p>
                                  ))
                                ) : (
                                  <p>无未知区间</p>
                                )}
                              </details>
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
                          {v.manifest?.rows ?? "—"} /{" "}
                          {v.manifest?.unknown_minutes ?? "—"}
                        </td>
                        <td>
                          {v.status === "published" &&
                            v.payload_available !== false && (
                              <Link
                                to={`?section=chart&version=${v.id}&frame=M1`}
                              >
                                查看固定版本
                              </Link>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {section === "maintenance" && (
            <div className="dc-fields">
              <h2>维护计划</h2>
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
                <div className="dc-actions">
                  <button
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
              <fieldset>
                <legend>指定区间补数</legend>
                <label>
                  起始交易日期
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  结束交易日期（不包含）
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <button disabled={busy} onClick={() => void backfill()}>
                  提交补数
                </button>
              </fieldset>
              <fieldset>
                <legend>按新日界创建数据集</legend>
                <label>
                  目标日界
                  <select
                    value={calendar}
                    onChange={(e) => setCalendar(e.target.value)}
                  >
                    <option value="">请选择</option>
                    <option value="ny17">NY17</option>
                    <option value="utc0">UTC0</option>
                  </select>
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
            />
          )}
          {section === "chart" && (
            <>
              <div className="dc-filters">
                <label>
                  周期
                  <select
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
                  </select>
                </label>
                <label>
                  固定版本
                  <select
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
                  </select>
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
              <Feedback
                error={bars.error}
                loading={bars.loading}
                empty={Boolean(frameReady) && !bars.data}
              />
              <p>
                当前读取固定版本；每页最多 2000
                根，默认显示最新观测。切换周期保留固定版本。
              </p>
              <div className="dc-actions">
                <button
                  disabled={bars.loading || bars.data?.next_before == null}
                  onClick={() =>
                    select("before", String(bars.data?.next_before))
                  }
                >
                  更早历史
                </button>
                {before !== null && (
                  <button
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.delete("before");
                      setParams(next);
                    }}
                  >
                    返回最新
                  </button>
                )}
                {selectedVersion && (
                  <Link to={`/replay?dataset_version=${selectedVersion}`}>
                    用此版本回测
                  </Link>
                )}
              </div>
              {bars.data?.bars.length ? (
                <p>
                  {time(bars.data.bars[0].start)} —{" "}
                  {time(bars.data.bars[bars.data.bars.length - 1].end)}
                </p>
              ) : null}
              {bars.data?.bars && (
                <Chart
                  key={`${selectedVersion}:${frame}:${before ?? "latest"}`}
                  bars={bars.data.bars.map((b) => ({ ...b, revision: 1 }))}
                  precision={dataset.precision}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
