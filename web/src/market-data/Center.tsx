import { NativeInput, NativeSelect } from "./NativeControls";
import { useState } from "react";
import { Link, useLocation, useSearchParams, useActionLock } from "./router";
import { OpenChart } from "./OpenChart";
import { api } from "./api";
import { DatasetDetail } from "./DatasetDetail";
import { DatasetCreate } from "./DatasetCreate";
import { CompositeDetail, CompositeList, MappingForm } from "./Composites";
import {
  names,
  phase,
  time,
  type Dataset,
  type Page,
  type Task,
  taskKind,
  taskError,
} from "./types";
import { useSnapshot } from "./useSnapshot";
import { NativeConfigure } from "./NativeConfigure";
import { centerLink, useCenterRowRestore } from "./navigation";

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
export function CenterList() {
  const [params, setParams] = useSearchParams(),
    [refresh, setRefresh] = useState(0),
    [notice, setNotice] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const tab = params.get("tab") || "managed",
    status = params.get("status") || (tab === "tasks" ? "active" : "all");
  const page = Math.max(1, Number(params.get("page")) || 1);
  const query = params.get("query") || "",
    source = params.get("source") || "",
    calendar = params.get("calendar") || "",
    asset = params.get("asset_class") || "";
  const dataset = params.get("dataset_id") || "";
  const key = new URLSearchParams({
    page: String(page),
    page_size: "25",
    query,
    source,
    calendar,
    asset_class: asset,
    status,
  });
  if (dataset) key.set("dataset_id", dataset);
  const endpoint =
    tab === "tasks" ? "tasks" : tab === "platform" ? "platform" : "datasets";
  const result = useSnapshot<Page<any>>(
    ["composite", "sources"].includes(tab) ? null : `/market-data/center/${endpoint}?${key}`,
    refresh,
  );

  function filter(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    next.delete("page");
    setParams(next);
  }
  const items = result.data?.items || [];
  useCenterRowRestore(result.data);
  return (
    <section className="data-center dc-list">
      <div className="dc-heading">
        <h1>{{ managed: "自建行情", platform: "平台品种", composite: "组合行情", tasks: "任务与记录" }[tab] || "自建行情"}</h1>
        {tab === "managed" && <Link className="primary dc-button" to={centerLink("/market-data/datasets/new", params)}>添加行情</Link>}
      </div>
      {tab !== "composite" && <button className="dc-filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>筛选与搜索</button>}
      {tab !== "composite" && <div className={`dc-list-filter-group${filtersOpen ? " is-open" : ""}`}>
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
      {tab === "tasks" && (
        <nav className="dc-filters" aria-label="任务状态">
          {[["active", "运行及需处理"], ["attention", "需处理"], ["paused", "已暂停"],
            ["history", "历史记录"], ["all", "全部任务"]].map(([key, label]) => (
            <button key={key} aria-pressed={status === key} onClick={() => filter("status", key)}>{label}</button>
          ))}
        </nav>
      )}
      {dataset && tab === "tasks" && <p>已限定自建行情。<button onClick={() => filter("dataset_id", "")}>查看全部对象</button></p>}
      {tab !== "composite" && (
        <div className="dc-filters">
          <label>
            搜索品种
            <NativeInput type="search" maxLength={100} placeholder="品种代码或名称"
              value={query}
              onChange={(e) => filter("query", e.target.value)}
            />
          </label>
          {(
            <label>
              来源
              <NativeSelect aria-label="来源"
                value={source}
                onChange={(e) => filter("source", e.target.value)}
              >
                <option value="">全部来源</option>
                {["dukascopy", "oanda", "binance", "yahoo"].map((s) => (
                  <option key={s} value={s}>
                    {names[s]}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          {["managed","platform"].includes(tab) && <label>资产类别<NativeSelect value={asset} onChange={e => filter("asset_class", e.target.value)}>
            <option value="">全部类别</option><option value="forex">外汇</option><option value="metal">金属</option>
            <option value="crypto">加密</option><option value="index">指数</option>{tab === "platform" && <><option value="equity">股票</option><option value="etf">基金</option><option value="future">期货</option></>}<option value="other">其他</option>
          </NativeSelect></label>}
          {tab === "managed" && (
            <label>
              聚合日界
              <NativeSelect
                value={calendar}
                onChange={(e) => filter("calendar", e.target.value)}
              >
                <option value="">全部日界</option>
                <option value="ny17">NY17</option>
                <option value="utc0">UTC0</option>
              </NativeSelect>
            </label>
          )}
          <button onClick={() => setRefresh((v) => v + 1)}>刷新</button>
        </div>
      )}
      </div>}
      {notice && <p role="status">{notice}</p>}
      {tab === "composite" ? (
        <CompositeList />
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
                {query || source || asset || status !== "all"
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
                        ? ["对象与类型", "固定任务范围", "阶段与进度", "时间与重试", "错误与处理", "操作"]
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
                      <tr key={d.id} id={`dataset-${d.id}`} tabIndex={-1}>
                        <td>
                          <strong>{d.display_symbol || d.logical_symbol}</strong>
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
                          {d.maintenance.frequency === "daily" && !d.maintenance.paused && d.maintenance.next_at != null && <span>下次维护：{time(d.maintenance.next_at)}</span>}
                          {d.maintenance.task_error && (
                            <span className="error">
                              本次维护：{d.maintenance.task_error}
                            </span>
                          )}
                        </td>
                        <td>
                          <Link to={centerLink(`/market-data/datasets/${d.id}`, params, `dataset-${d.id}`)}>查看</Link>
                          <Link to={centerLink(`/market-data/datasets/${d.id}?section=references&view=delete`, params, `dataset-${d.id}`)}>删除历史数据</Link>
                          {d.latest_version_id &&
                            d.usable_timeframes.length > 0 && (
                              <OpenChart ticker={`MWH:${d.periods.find(p => p.timeframe === d.usable_timeframes[0])?.available_version_id || d.latest_version_id}`} frame={d.usable_timeframes[0]} />
                            )}
                        </td>
                      </tr>
                    ))}
                  {tab === "tasks" &&
                    (items as Task[]).map((t) => (
                      <tr key={t.id} id={`task-${t.id}`} tabIndex={-1}>
                        <td>
                          <Link to={centerLink(`/market-data/datasets/${t.dataset_id}`, params, `task-${t.id}`)}>
                            {t.dataset.display_symbol || t.dataset.logical_symbol}
                          </Link>
                          <span>{names[t.dataset.identity.source]} · {phase(t.dataset.aggregation_calendar)}</span>
                          <span>{taskKind(t.task_kind)}</span>
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
                        <td>
                          创建：{time(t.created_at)}
                          <span>开始：{time(t.started_at)}</span>
                          <span>更新：{time(t.updated_at)}{t.updated_at == null ? "（尚无记录）" : ""}</span>
                          {t.status === "retrying" && <span>下次尝试：{time(t.next_at)}</span>}
                          {t.completed_at != null && <span>完成：{time(t.completed_at)}</span>}
                        </td>
                        <td>
                          {t.error ? <>
                            {taskError(t.error, t.status)}
                            <details><summary>技术错误详情</summary><code>{t.error}</code>
                              <p>仅显示安全错误类型，不显示凭据或供应商响应内容。</p></details>
                            {t.status === "configuration_error" && <Link to="/market-data?tab=sources&connection=oanda">查看连接配置说明</Link>}
                          </> : "—"}
                        </td>
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
                      <tr key={p.id} id={`platform-${p.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`} tabIndex={-1}>
                        <td>
                          <strong>{p.display_symbol || p.provider_symbol}</strong>
                          <span>
                            {p.label === p.provider_symbol ? names[p.source] : p.label + " · " + names[p.source]}
                          </span>
                        </td>
                        <td>
                          {p.capabilities.native_periods.join(" · ") ||
                            "尚未接入"}
                          {p.capabilities.native_confirmation === "not_supplied" && (
                            <span>来源未提供确认标记；按周期结束时间显示</span>
                          )}
                        </td>
                        <td>{p.capabilities.history_m1 ? "支持" : "未开放"}</td>
                        <td>{time(p.updated_at)}</td>
                        <td>
                          {p.available && p.capabilities.native_periods.length > 0 && (
                            <OpenChart ticker={`MWP:${p.id}`} frame={p.capabilities.native_periods.includes("H1") ? "H1" : p.capabilities.native_periods[0]} label="打开平台图表" />
                          )}
                          {p.available && p.source === "oanda" && (
                            <Link to={centerLink(`/market-data/platform/configure?instrument=${encodeURIComponent(p.id)}`, params, `platform-${p.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`)}>
                              配置原生参数
                            </Link>
                          )}
                          {p.capabilities.history_m1 &&
                            (!p.logical_symbol || p.logical_symbol.length <= 10) && (
                            <Link
                              to={centerLink(`/market-data/datasets/new?source=${p.source}&symbol=${encodeURIComponent(p.provider_symbol)}${p.history_precision == null ? "" : `&precision=${p.history_precision}`}`, params, `platform-${p.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`)}
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
  const actionLock = useActionLock();
  async function action(value: string) {
    if (!actionLock.acquire()) return;
    setBusy(true);
    try {
      await api(`/market-data/tasks/${task.id}/control`, { action: value });
      onDone();
    } catch (e) {
      onError(String(e));
    } finally {
      actionLock.release();
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
export function Sources() {
  const result = useSnapshot<any[]>("/market-data/sources");
  return <section className="data-center"><h1>来源与能力</h1>
    <p>已接入能力与实际连接健康分别判断；此处不推测连接状态。</p>
    <Feedback error={result.error} loading={result.loading} empty={!result.data} />
    {result.data?.map(s => <div className="dc-source" key={s.source}><h2>{names[s.source] || s.source}</h2>
      <p>原生周期：{s.native_periods.join("、") || "尚未接入"}</p><p>M1 历史：{s.history_m1 ? "支持" : "未开放"}；实时流：{s.stream ? "支持" : "未开放"}</p></div>)}
    <p>OANDA Practice 连接由管理员在部署配置中维护。授权异常时核对账户环境与访问授权，更新连接后重试失败范围。此处不显示账户或密钥。</p>
  </section>;
}
export default function Center() {
  const { pathname } = useLocation(), [params] = useSearchParams();
  if (pathname === "/market-data/platform/configure") return <NativeConfigure key={params.get("instrument")} />;
  if (pathname === "/market-data/datasets/new") return <DatasetCreate />;
  if (pathname.endsWith("/mapping")) return <MappingForm key={pathname} />;
  if (pathname.includes("/datasets/")) return <DatasetDetail key={pathname + ":" + params.get("section")} />;
  if (pathname.includes("/composites/")) return <CompositeDetail key={pathname} />;
  if (params.get("tab") === "sources") return <Sources />;
  return <CenterList />;
}
