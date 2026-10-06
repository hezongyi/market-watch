import { useState } from "react";
import { Link, Route, Routes, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { DatasetDetail } from "./DatasetDetail";
import { DatasetCreate } from "./DatasetCreate";
import {
  names,
  phase,
  time,
  type Dataset,
  type Page,
  type Task,
} from "./types";
import { useSnapshot } from "./useSnapshot";

export function Feedback({
  error,
  loading,
  empty,
}: {
  error: string;
  loading: boolean;
  empty: boolean;
}) {
  if (error)
    return (
      <p role="alert" className="error">
        {error}。稍后自动重试；已有结果保留。
      </p>
    );
  if (loading && empty) return <p role="status">正在读取数据…</p>;
  return null;
}
export function Pager({
  total,
  page,
  size,
  change,
}: {
  total: number;
  page: number;
  size: number;
  change: (p: number) => void;
}) {
  return (
    <nav className="dc-actions" aria-label="列表分页">
      <span>
        共 {total} 条 · 第 {page} 页
      </span>
      <button disabled={page <= 1} onClick={() => change(page - 1)}>
        上一页
      </button>
      <button disabled={page * size >= total} onClick={() => change(page + 1)}>
        下一页
      </button>
    </nav>
  );
}
function CenterList() {
  const [params, setParams] = useSearchParams(),
    [refresh, setRefresh] = useState(0),
    [notice, setNotice] = useState("");
  const tab = params.get("tab") || "managed",
    status = params.get("status") || "all";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const query = params.get("query") || "",
    source = params.get("source") || "",
    calendar = params.get("calendar") || "";
  const dataset = params.get("dataset_id") || "";
  const key = new URLSearchParams({
    page: String(page),
    page_size: "25",
    query,
    source,
    calendar,
    status,
  });
  if (dataset) key.set("dataset_id", dataset);
  const endpoint =
    tab === "tasks" ? "tasks" : tab === "platform" ? "platform" : "datasets";
  const result = useSnapshot<Page<any>>(
    `/market-data/center/${endpoint}?${key}`,
    refresh,
  );
  const sources = useSnapshot<any[]>("/market-data/sources");
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    next.delete("page");
    setParams(next);
  }
  const items = result.data?.items || [];
  return (
    <section className="data-center">
      <div className="dc-heading">
        <div>
          <h1>数据中心</h1>
          <p>维护回测历史，查看来源与组合行情。</p>
        </div>
        <Link className="primary dc-button" to="/market-data/datasets/new">
          添加自建行情
        </Link>
      </div>
      <nav className="dc-tabs" aria-label="数据中心分区">
        {[
          ["managed", "自建行情"],
          ["platform", "平台品种"],
          ["composite", "组合行情"],
          ["tasks", "任务与记录"],
        ].map(([key, label]) => (
          <Link
            key={key}
            aria-current={tab === key ? "page" : undefined}
            to={`/market-data?tab=${key}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <details className="dc-source">
        <summary>来源状态与能力</summary>
        <p>此处显示已接入能力；连接和实际历史范围仍按品种查询结果判断。</p>
        {sources.data?.map((s) => (
          <p key={s.source}>
            {names[s.source] || s.source}：原生周期{" "}
            {s.native_periods.join("、") || "尚未接入"}；M1 历史
            {s.history_m1 ? "支持" : "未开放"}；实时流
            {s.stream ? "支持" : "未开放"}
          </p>
        ))}
        <Feedback
          error={sources.error}
          loading={sources.loading}
          empty={!sources.data}
        />
      </details>
      {tab === "managed" && (
        <nav className="dc-filters" aria-label="自建状态">
          {[
            ["all", "全部"],
            ["available", "可用"],
            ["preparing", "准备中"],
            ["attention", "需处理"],
            ["paused", "已暂停"],
            ["archived", "已归档"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={status === key}
              onClick={() => filter("status", key)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {tab !== "composite" && (
        <div className="dc-filters">
          <label>
            搜索品种
            <input
              value={query}
              onChange={(e) => filter("query", e.target.value)}
            />
          </label>
          {tab !== "tasks" && (
            <label>
              来源
              <select
                value={source}
                onChange={(e) => filter("source", e.target.value)}
              >
                <option value="">全部来源</option>
                {["dukascopy", "oanda", "binance", "yahoo"].map((s) => (
                  <option key={s} value={s}>
                    {names[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {tab === "managed" && (
            <label>
              聚合日界
              <select
                value={calendar}
                onChange={(e) => filter("calendar", e.target.value)}
              >
                <option value="">全部日界</option>
                <option value="ny17">NY17</option>
                <option value="utc0">UTC0</option>
              </select>
            </label>
          )}
          <button onClick={() => setRefresh((v) => v + 1)}>刷新</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === "composite" ? (
        <p>
          组合接续正在开发；当前未建立组合，不启动实时采集。已有历史可在自建行情中查看。
        </p>
      ) : (
        <>
          <Feedback
            error={result.error}
            loading={result.loading}
            empty={!result.data}
          />
          {result.data && (
            <p className="dc-subtle">
              快照：{time(result.at)}
              {result.error ? " · 刷新失败" : ""}
            </p>
          )}
          {result.data && !items.length && (
            <div className="dc-empty">
              <h2>
                {query || source || status !== "all"
                  ? "没有符合筛选的条目"
                  : tab === "managed"
                    ? "开始维护你的回测历史"
                    : "暂无记录"}
              </h2>
              <p>
                {tab === "managed"
                  ? "选择行情源与品种，设定日界和历史范围，后台完成下载与发布。"
                  : "已有缓存目录与任务会显示在此处。"}
              </p>
            </div>
          )}
          {!!items.length && (
            <div className="dc-table">
              <table>
                <thead>
                  <tr>
                    {(tab === "managed"
                      ? ["品种与口径", "可用历史", "周期", "维护与状态", "操作"]
                      : tab === "tasks"
                        ? ["对象", "任务范围", "阶段与进度", "错误", "操作"]
                        : [
                            "来源品种",
                            "原生周期",
                            "M1 历史",
                            "目录更新时间",
                            "操作",
                          ]
                    ).map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tab === "managed" &&
                    (items as Dataset[]).map((d) => (
                      <tr key={d.id}>
                        <td>
                          <strong>{d.logical_symbol}</strong>
                          <span>
                            {names[d.identity.source]} · {d.identity.basis} ·{" "}
                            {phase(d.aggregation_calendar)}
                          </span>
                        </td>
                        <td>
                          {d.available_end ? (
                            <>
                              {time(d.available_start)}
                              <span>至 {time(d.available_end)}</span>
                              {!!d.unknown_minutes && (
                                <span>
                                  含未知区间 · {d.unknown_minutes} 分钟
                                </span>
                              )}
                            </>
                          ) : (
                            "尚未发布"
                          )}
                        </td>
                        <td>
                          {d.usable_timeframes.join(" · ") || "尚无可用周期"}
                        </td>
                        <td>
                          {names[d.availability]}
                          <span>
                            {d.maintenance.configured
                              ? d.maintenance.paused
                                ? "定时维护已暂停"
                                : d.maintenance.frequency === "daily"
                                  ? "每日维护"
                                  : "一次性维护"
                              : "未配置维护"}
                          </span>
                          {d.maintenance.task_error && (
                            <span className="error">
                              本次维护：{d.maintenance.task_error}
                            </span>
                          )}
                        </td>
                        <td>
                          <Link to={`/market-data/datasets/${d.id}`}>查看</Link>
                          {d.latest_version_id &&
                            d.usable_timeframes.length > 0 && (
                              <Link
                                to={`/market-data/datasets/${d.id}?section=chart`}
                              >
                                打开历史图表
                              </Link>
                            )}
                        </td>
                      </tr>
                    ))}
                  {tab === "tasks" &&
                    (items as Task[]).map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Link to={`/market-data/datasets/${t.dataset_id}`}>
                            {t.dataset.logical_symbol}
                          </Link>
                          <span>{names[t.dataset.identity.source]}</span>
                        </td>
                        <td>
                          {time(t.start)}
                          <span>至 {time(t.end)}</span>
                        </td>
                        <td>
                          {names[t.status] || t.status}
                          <span>已查询至 {time(t.cursor)}</span>
                          {t.desired_state &&
                            t.desired_state !== "running" &&
                            t.status === "running" && <span>正在安全停止</span>}
                        </td>
                        <td>{t.error || "—"}</td>
                        <td>
                          {t.controllable && (
                            <TaskActions
                              task={t}
                              onDone={() => setRefresh((v) => v + 1)}
                              onError={setNotice}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  {tab === "platform" &&
                    items.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.label}</strong>
                          <span>
                            {names[p.source]} · {p.provider_symbol}
                          </span>
                        </td>
                        <td>
                          {p.capabilities.native_periods.join(" · ") ||
                            "尚未接入"}
                        </td>
                        <td>{p.capabilities.history_m1 ? "支持" : "未开放"}</td>
                        <td>{time(p.updated_at)}</td>
                        <td>
                          {p.capabilities.history_m1 && (
                            <Link
                              to={`/market-data/datasets/new?source=${p.source}&symbol=${encodeURIComponent(p.provider_symbol)}&precision=${p.precision}`}
                            >
                              添加为自建行情
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {result.data && (
            <Pager
              total={result.data.total}
              page={page}
              size={25}
              change={(p) => {
                const next = new URLSearchParams(params);
                next.set("page", String(p));
                setParams(next);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
export function TaskActions({
  task,
  onDone,
  onError,
}: {
  task: Task;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function action(value: string) {
    setBusy(true);
    try {
      await api(`/market-data/tasks/${task.id}/control`, { action: value });
      onDone();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dc-actions">
      {task.status === "paused" ? (
        <button disabled={busy} onClick={() => action("resume")}>
          恢复任务
        </button>
      ) : (
        <button disabled={busy} onClick={() => action("pause")}>
          暂停任务
        </button>
      )}
      {["retrying", "configuration_error"].includes(task.status) && (
        <button disabled={busy} onClick={() => action("retry")}>
          重试失败范围
        </button>
      )}
      <button disabled={busy} onClick={() => action("cancel")}>
        取消任务
      </button>
    </div>
  );
}
export default function Center() {
  return (
    <Routes>
      <Route index element={<CenterList />} />
      <Route path="datasets/new" element={<DatasetCreate />} />
      <Route path="datasets/:id" element={<DatasetDetail />} />
    </Routes>
  );
}
