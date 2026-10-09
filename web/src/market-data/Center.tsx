import { DetailDisclosure } from "./DetailPanel";
import { NativeInput, NativeSelect } from "./NativeControls";
import { useState } from "react";
import { Link, useLocation, useSearchParams, useActionLock } from "./router";
import { api } from "./api";
import { DatasetDetail } from "./DatasetDetail";
import { DatasetCreate } from "./DatasetCreate";
import { CompositeDetail, CompositeList, MappingForm } from "./Composites";
import {
  names,
  phase,
  time,
  type Page,
  type Task,
  taskKind,
  taskError,
} from "./types";
import { useSnapshot } from "./useSnapshot";
import { NativeConfigure } from "./NativeConfigure";
import { centerLink, useCenterRowRestore } from "./navigation";
import { PlatformMarket } from "./PlatformMarket";
import { ManagedMarket } from "./ManagedMarket";

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
  const status = params.get("status") || "active",
    page = Math.max(1, Number(params.get("page")) || 1);
  const query = params.get("query") || "",
    source = params.get("source") || "",
    dataset = params.get("dataset_id") || "";
  const key = new URLSearchParams({
    page: String(page),
    page_size: "25",
    query,
    source,
    status,
  });
  if (dataset) key.set("dataset_id", dataset);
  const result = useSnapshot<Page<Task>>(
      `/market-data/center/tasks?${key}`,
      refresh,
    ),
    items = result.data?.items || [];
  useCenterRowRestore(result.data);
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    next.delete("page");
    setParams(next);
  }
  return (
    <section className="data-center dc-list">
      <h1>任务与记录</h1>
      <button
        className="dc-filter-toggle"
        aria-expanded={filtersOpen}
        onClick={() => setFiltersOpen((value) => !value)}
      >
        筛选与搜索
      </button>
      <div className={`dc-list-filter-group${filtersOpen ? " is-open" : ""}`}>
        <nav className="dc-filters" aria-label="任务状态">
          {[
            ["active", "运行及需处理"],
            ["attention", "需处理"],
            ["paused", "已暂停"],
            ["history", "历史记录"],
            ["all", "全部任务"],
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
        {dataset && (
          <p>
            已限定自建行情。
            <button onClick={() => filter("dataset_id", "")}>
              查看全部对象
            </button>
          </p>
        )}
        <div className="dc-filters">
          <label>
            搜索品种
            <NativeInput
              type="search"
              maxLength={100}
              placeholder="品种代码或名称"
              value={query}
              onChange={(event) => filter("query", event.target.value)}
            />
          </label>
          <label>
            来源
            <NativeSelect
              aria-label="来源"
              value={source}
              onChange={(event) => filter("source", event.target.value)}
            >
              <option value="">全部来源</option>
              {["dukascopy", "oanda", "binance", "yahoo"].map((source) => (
                <option key={source} value={source}>
                  {names[source]}
                </option>
              ))}
            </NativeSelect>
          </label>
          <button onClick={() => setRefresh((value) => value + 1)}>刷新</button>
        </div>
      </div>
      {notice && <p role="status">{notice}</p>}
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
          <h2>暂无记录</h2>
          <p>已有缓存目录与任务会显示在此处。</p>
        </div>
      )}
      {!!items.length && (
        <div className="dc-table">
          <table>
            <thead>
              <tr>
                {[
                  "对象与类型",
                  "固定任务范围",
                  "阶段与进度",
                  "时间与重试",
                  "错误与处理",
                  "操作",
                ].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(items as Task[]).map((t) => (
                <tr key={t.id} id={`task-${t.id}`} tabIndex={-1}>
                  <td>
                    <Link
                      to={centerLink(
                        `/market-data/datasets/${t.dataset_id}`,
                        params,
                        `task-${t.id}`,
                      )}
                    >
                      {t.dataset.display_symbol || t.dataset.logical_symbol}
                    </Link>
                    <span>
                      {names[t.dataset.identity.source]} ·{" "}
                      {phase(t.dataset.aggregation_calendar)}
                    </span>
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
                    <span>
                      更新：{time(t.updated_at)}
                      {t.updated_at == null ? "（尚无记录）" : ""}
                    </span>
                    {t.status === "retrying" && (
                      <span>下次尝试：{time(t.next_at)}</span>
                    )}
                    {t.completed_at != null && (
                      <span>完成：{time(t.completed_at)}</span>
                    )}
                  </td>
                  <td>
                    {t.error ? (
                      <>
                        {taskError(t.error, t.status)}
                        <DetailDisclosure title={<>技术错误详情</>}>
                          <code>{t.error}</code>
                          <p>
                            仅显示安全错误类型，不显示凭据或供应商响应内容。
                          </p>
                        </DetailDisclosure>
                        {t.status === "configuration_error" && (
                          <Link to="/market-data?tab=sources&connection=oanda">
                            查看连接配置说明
                          </Link>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
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
            </tbody>
          </table>
        </div>
      )}
      {result.data && (
        <Pager
          total={result.data.total}
          page={page}
          size={25}
          change={(value) => {
            const next = new URLSearchParams(params);
            next.set("page", String(value));
            setParams(next);
          }}
        />
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
  return (
    <section className="data-center">
      <h1>来源与能力</h1>
      <p>已接入能力与实际连接健康分别判断；此处不推测连接状态。</p>
      <Feedback
        error={result.error}
        loading={result.loading}
        empty={!result.data}
      />
      {result.data?.map((s) => (
        <div className="dc-source" key={s.source}>
          <h2>{names[s.source] || s.source}</h2>
          <p>原生周期：{s.native_periods.join("、") || "尚未接入"}</p>
          <p>
            M1 历史：{s.history_m1 ? "支持" : "未开放"}；实时流：
            {s.stream ? "支持" : "未开放"}
          </p>
        </div>
      ))}
      <p>
        OANDA Practice
        连接由管理员在部署配置中维护。授权异常时核对账户环境与访问授权，更新连接后重试失败范围。此处不显示账户或密钥。
      </p>
    </section>
  );
}
export default function Center() {
  const { pathname } = useLocation(),
    [params] = useSearchParams();
  if (pathname === "/market-data/platform/configure")
    return <NativeConfigure key={params.get("instrument")} />;
  if (pathname === "/market-data/datasets/new") return <DatasetCreate />;
  if (pathname.endsWith("/mapping")) return <MappingForm key={pathname} />;
  if (pathname.includes("/datasets/"))
    return <DatasetDetail key={pathname + ":" + params.get("section")} />;
  if (pathname.includes("/composites/"))
    return <CompositeDetail key={pathname} />;
  if (params.get("tab") === "sources") return <Sources />;
  if (params.get("tab") === "platform") return <PlatformMarket />;
  if ((params.get("tab") || "managed") === "managed") return <ManagedMarket />;
  if (params.get("tab") === "composite") return <CompositeList />;
  return <CenterList />;
}
