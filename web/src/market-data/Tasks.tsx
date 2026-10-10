import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useActionLock, useSearchParams } from "./router";
import { NativeSelect } from "./NativeControls";
import { DetailPanel, useDetailPanel } from "./DetailPanel";
import { MarketListHeader, MarketTabs } from "./MarketList";
import { centerLink } from "./navigation";
import { useTaskRows } from "./useTaskRows";
import { api } from "./api";
import { names, phase, time, taskKind, taskError, type Task } from "./types";

const states = [
  ["active", "当前任务"],
  ["attention", "需处理"],
  ["paused", "已暂停"],
  ["history", "历史记录"],
  ["all", "全部"],
] as const;
export function Tasks() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "active",
    query = params.get("query") || "",
    source = params.get("source") || "",
    dataset = params.get("dataset_id") || "";
  const filters = new URLSearchParams({ status, query, source });
  if (dataset) filters.set("dataset_id", dataset);
  const rows = useTaskRows(filters);
  const detail = useDetailPanel(),
    [selected, select] = useState<string | null>(null);
  const task = rows.items.find((row) => row.id === selected);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    detail.close();
    select(null);
    setParams(next, { replace: true });
  };
  const show = (task: Task) => {
    select(task.id);
    detail.open();
  };
  return (
    <section className="data-center dc-market-page dc-task-page">
      <MarketListHeader
        title="任务与记录"
        query={query}
        onQuery={(value) => change("query", value)}
        refresh={() => {
          detail.close();
          select(null);
          rows.restart();
        }}
      />
      <p className="dc-task-scope">历史行情维护任务与记录 · 状态每 10 秒更新</p>
      <MarketTabs
        label="任务状态"
        value={status}
        items={states}
        change={(value) => change("status", value)}
      />
      {dataset && (
        <div className="dc-task-context">
          当前仅查看此行情的任务{" "}
          <button onClick={() => change("dataset_id", "")}>查看全部对象</button>
        </div>
      )}
      <div className="dc-task-table-head">
        <span>品种与任务</span>
        <span>状态与进度</span>
        <span>更新时间</span>
        <div className="dc-market-head-filters">
          <NativeSelect
            aria-label="来源"
            value={source}
            onChange={(event) => change("source", event.target.value)}
          >
            <option value="">全部来源</option>
            {["dukascopy", "oanda", "binance", "yahoo"].map((source) => (
              <option key={source} value={source}>
                {names[source]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {rows.newCount > 0 && (
        <div className="dc-task-new" role="status">
          有 {rows.newCount} 条新记录{" "}
          <button
            onClick={() => {
              detail.close();
              select(null);
              rows.restart();
            }}
          >
            刷新查看
          </button>
        </div>
      )}
      {rows.stateError && (
        <div className="dc-task-message" role="alert">
          状态刷新失败，保留上次结果。
          <button onClick={rows.refreshStates}>重试刷新</button>
        </div>
      )}
      <div className="dc-market-list" ref={rows.list}>
        {rows.items.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={detail.opened && selected === task.id}
            show={() => show(task)}
            refresh={rows.refreshStates}
          />
        ))}
        <div
          ref={rows.sentinel}
          className="dc-market-status"
          role={rows.error ? "alert" : "status"}
        >
          {rows.error ? (
            <>
              {rows.error}
              <button onClick={rows.retry}>重试</button>
            </>
          ) : rows.loading ? (
            "正在加载…"
          ) : !rows.items.length ? (
            status === "active" ? (
              "暂无当前任务。已完成及已取消任务可在历史记录中查看。"
            ) : (
              "没有符合筛选的任务记录。"
            )
          ) : rows.complete ? (
            `已全部加载 · ${rows.items.length} 条`
          ) : (
            `已加载 ${rows.items.length} 条 · 继续下滚加载`
          )}
        </div>
      </div>
      {rows.at && (
        <p className="dc-task-snapshot">
          最近更新：{time(rows.at)} ·
          已加载任务保持原位，刷新列表重新应用状态筛选。
        </p>
      )}
      {detail.opened && task && (
        <DetailPanel
          title={`${task.dataset.display_symbol || task.dataset.logical_symbol} · ${taskKind(task.task_kind)}`}
          close={detail.close}
        >
          <TaskDetails
            key={task.id}
            task={task}
            params={params}
            refresh={rows.refreshStates}
          />
        </DetailPanel>
      )}
    </section>
  );
}
function TaskRow({
  task,
  selected,
  show,
  refresh,
}: {
  task: Task;
  selected: boolean;
  show: () => void;
  refresh: () => void;
}) {
  return (
    <div
      className="dc-task-row"
      id={`task-${task.id}`}
      tabIndex={-1}
      data-selected-detail={selected || undefined}
    >
      <div className="dc-task-identity">
        <button className="dc-market-name" onClick={show}>
          {task.dataset.display_symbol || task.dataset.logical_symbol}
        </button>
        <small>
          {names[task.dataset.identity.source]} ·{" "}
          {phase(task.dataset.aggregation_calendar)} ·{" "}
          {taskKind(task.task_kind)}
        </small>
      </div>
      <div className="dc-task-state">
        <span className={`dc-task-badge state-${task.status}`}>
          {names[task.status] || task.status}
        </span>
        <small>
          {stopping(task)
            ? "正在安全停止"
            : task.status === "retrying"
              ? `下次尝试：${time(task.next_at)}`
              : task.status === "configuration_error"
                ? taskError(task.error || "", task.status)
                : `已查询至 ${time(task.cursor)}`}
        </small>
      </div>
      <time className="dc-task-updated">{time(task.updated_at)}</time>
      <div className="dc-task-row-actions">
        <button onClick={show} aria-label="查看任务详情">
          详情
        </button>
        <TaskActions task={task} onDone={refresh} compact />
      </div>
    </div>
  );
}
function stopping(task: Task) {
  return (
    !!task.desired_state &&
    task.desired_state !== "running" &&
    ["pending", "running", "deriving", "retrying"].includes(task.status)
  );
}
function TaskDetails({
  task,
  params,
  refresh,
}: {
  task: Task;
  params: URLSearchParams;
  refresh: () => void;
}) {
  const [technical, setTechnical] = useState(false);
  return (
    <>
      <p>
        {names[task.dataset.identity.source]} ·{" "}
        {phase(task.dataset.aggregation_calendar)}
      </p>
      <h3>状态与范围</h3>
      <dl className="dc-task-details">
        <dt>状态</dt>
        <dd>
          {names[task.status] || task.status}
          {stopping(task) ? " · 正在安全停止" : ""}
        </dd>
        <dt>固定开始</dt>
        <dd>{time(task.start)}</dd>
        <dt>固定结束</dt>
        <dd>{time(task.end)}</dd>
        <dt>已查询至</dt>
        <dd>{time(task.cursor)}</dd>
      </dl>
      <h3>时间记录</h3>
      <dl className="dc-task-details">
        {[
          ["创建", task.created_at],
          ["开始", task.started_at],
          ["更新", task.updated_at],
          ["完成", task.completed_at],
          ...(task.status === "retrying" ? [["下次尝试", task.next_at]] : []),
        ].map(([name, value]) => (
          <div key={String(name)}>
            <dt>{name}</dt>
            <dd>{time(value as number | null | undefined)}</dd>
          </div>
        ))}
      </dl>
      {task.error && (
        <>
          <h3>错误与处理</h3>
          <p>{taskError(task.error, task.status)}</p>
          <button
            aria-expanded={technical}
            onClick={() => setTechnical(!technical)}
          >
            技术错误详情
          </button>
          {technical && (
            <p>
              <code>{task.error}</code>
              <br />
              仅显示安全错误类型，不显示凭据或供应商响应内容。
            </p>
          )}
        </>
      )}
      {task.status === "configuration_error" && (
        <p>
          连接由管理员在部署配置中维护。请核对来源授权与账户环境，更新连接后重试失败范围。
        </p>
      )}
      <h3>任务操作</h3>
      <TaskActions task={task} onDone={refresh} />
      <p>
        <Link
          to={centerLink(
            `/market-data/datasets/${task.dataset_id}`,
            params,
            `task-${task.id}`,
          )}
        >
          查看行情管理
        </Link>
      </p>
      <p className="dc-subtle">任务身份：{task.id}</p>
    </>
  );
}
type ActionState = { busy: string; awaiting: string; error: string };
const actionStates = new Map<string, ActionState>();
const actionEvents = new EventTarget();
const idleAction: ActionState = { busy: "", awaiting: "", error: "" };
function setTaskAction(id: string, changes: Partial<ActionState>) {
  actionStates.set(id, { ...(actionStates.get(id) || idleAction), ...changes });
  actionEvents.dispatchEvent(new Event("change"));
}
function subscribeTaskAction(callback: () => void) {
  actionEvents.addEventListener("change", callback);
  return () => actionEvents.removeEventListener("change", callback);
}

export function TaskActions({
  task,
  onDone,
  compact = false,
}: {
  task: Task;
  onDone: () => void;
  compact?: boolean;
}) {
  const { busy, awaiting, error } = useSyncExternalStore(
    subscribeTaskAction,
    () => actionStates.get(task.id) || idleAction,
  );
  const [confirming, confirm] = useState(false);
  const actionLock = useActionLock();
  useEffect(() => {
    if (
      (awaiting === "pause" && task.status === "paused") ||
      (awaiting === "resume" &&
        ["pending", "running", "deriving"].includes(task.status)) ||
      (awaiting === "retry" && ["pending", "running"].includes(task.status))
    )
      setTaskAction(task.id, { awaiting: "" });
  }, [awaiting, task.status]);
  async function action(value: string) {
    if (actionStates.get(task.id)?.busy || !actionLock.acquire()) return;
    setTaskAction(task.id, { busy: value, error: "" });
    try {
      await api(`/market-data/tasks/${task.id}/control`, { action: value });
      setTaskAction(task.id, { awaiting: value });
      confirm(false);
      onDone();
    } catch (error) {
      setTaskAction(task.id, { error: String(error) });
    } finally {
      actionLock.release();
      setTaskAction(task.id, { busy: "" });
    }
  }
  if (!task.controllable)
    return compact ? null : <p>此记录已结束，保留记录供核查。</p>;
  const unsettled =
    stopping(task) ||
    (!!awaiting &&
      !(awaiting === "pause" && task.status === "paused") &&
      !(
        awaiting === "resume" &&
        ["pending", "running", "deriving"].includes(task.status)
      ) &&
      !(awaiting === "retry" && ["pending", "running"].includes(task.status)));
  const disabled = !!busy || unsettled;
  const control =
    task.status === "paused"
      ? ["恢复任务", "resume"]
      : task.status === "configuration_error"
        ? ["查看处理说明", "explain"]
        : task.status === "retrying"
          ? ["重试失败范围", "retry"]
          : ["暂停任务", "pause"];
  return (
    <div className="dc-task-controls">
      <div className="dc-actions">
        <button
          disabled={disabled}
          onClick={() =>
            control[1] === "explain"
              ? setTaskAction(task.id, {
                  error:
                    "连接由管理员在部署配置中维护。请核对来源授权与账户环境，更新连接后重试失败范围。",
                })
              : void action(control[1])
          }
        >
          {busy ? "正在提交…" : control[0]}
        </button>
        {!compact && (
          <>
            {["retrying", "configuration_error"].includes(task.status) &&
              control[1] !== "retry" && (
                <button
                  disabled={disabled}
                  onClick={() => void action("retry")}
                >
                  重试失败范围
                </button>
              )}
            <button
              className="dc-task-cancel"
              disabled={disabled}
              onClick={() => confirm(true)}
            >
              取消任务
            </button>
          </>
        )}
      </div>
      {unsettled && (
        <small role="status">
          {["pause", "cancel"].includes(awaiting) || stopping(task)
            ? "正在安全停止，等待任务确认。"
            : "请求已提交，等待状态更新。"}
        </small>
      )}
      {confirming && (
        <div
          className="dc-task-cancel-confirm"
          role="group"
          aria-label="确认取消任务"
        >
          <p>取消此任务？将停止后续处理，已发布行情仍可使用，任务记录保留。</p>
          <button disabled={disabled} onClick={() => void action("cancel")}>
            确认取消任务
          </button>
          <button disabled={!!busy} onClick={() => confirm(false)}>
            保留任务
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
