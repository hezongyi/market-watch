import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  useSyncExternalStore,
} from "react";
import { Bell, Check, CheckCheck, ChevronLeft, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { NotificationStore, type CenterState } from "./store";
import type { CenterEvent, Detail, Filters } from "./types";
import "./notification-center.css";

const StoreContext = createContext<NotificationStore | null>(null);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => new NotificationStore(), []);
  useEffect(() => {
    void store.start();
    const debug = {
      getState: () => store.getSnapshot(),
      refresh: () => store.refresh(true),
      flush: () => store.flush(),
      report: (input: Parameters<NotificationStore["report"]>[0]) => store.report(input),
      observe: (eventId: string, kind: string, extra?: Record<string, unknown>) =>
        store.observeForDebug(eventId, kind, extra),
      soundAttempt: (eventId: string) => store.soundAttemptForDebug(eventId),
      soundUnlocked: () => store.isSoundUnlocked(),
      resolve: (incidentId: string) => store.resolveIncident(incidentId),
      open: () => window.dispatchEvent(new CustomEvent("mw-notification-open")),
    };
    (window as any).MWNotificationCenter = debug;
    return () => {
      store.stop();
      if ((window as any).MWNotificationCenter === debug) delete (window as any).MWNotificationCenter;
    };
  }, [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useNotificationStore(): NotificationStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("NotificationProvider 未挂载");
  return store;
}

export function useCenterState(): CenterState {
  const store = useNotificationStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

const localTime = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
const utcTime = (value: number | null | undefined) =>
  value ? new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC") : "未知";

const SEVERITY_LABEL: Record<string, string> = { critical: "严重", warning: "警告", info: "提示" };
const KIND_LABEL: Record<string, string> = {
  alert: "告警", failure: "异常", operation: "操作", success: "成功",
};
const CONNECTION_LABEL: Record<string, string> = {
  connecting: "正在连接", live: "实时", polling: "轮询", offline: "离线",
};

function EntryButton({ open, onToggle, buttonRef }: {
  open: boolean; onToggle: () => void; buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const state = useCenterState();
  return (
    <button
      ref={buttonRef}
      type="button"
      className="mw-center-entry"
      data-testid="notification-entry"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`通知中心${state.unread ? `，${state.unread} 条未读` : "，没有未读"}`}
      onClick={onToggle}
    >
      <Bell size={16} />
      <span>通知</span>
      {state.unread > 0 && (
        <span className="mw-center-badge" data-testid="notification-badge">
          {state.unread > 99 ? "99+" : state.unread}
        </span>
      )}
    </button>
  );
}

function Bubble({ onOpen }: { onOpen: () => void }) {
  const store = useNotificationStore();
  const state = useCenterState();
  if (!state.bubble) return null;
  const event = state.bubble.event;
  return (
    <div
      className={`mw-center-bubble severity-${event.severity}`}
      data-testid="notification-bubble"
      role="status"
      aria-live="polite"
      onMouseEnter={() => store.holdBubble(true)}
      onMouseLeave={() => store.holdBubble(false)}
      onFocus={() => store.holdBubble(true)}
      onBlur={() => store.holdBubble(false)}
    >
      <div className="mw-center-bubble-body">
        <strong>{event.title}</strong>
        {event.summary && <p>{event.summary}</p>}
      </div>
      <button type="button" onClick={onOpen}>查看</button>
      <button type="button" aria-label="关闭提示" onClick={() => store.dismissBubble()}>
        <X size={14} />
      </button>
    </div>
  );
}

function Timeline({ detail }: { detail: Detail }) {
  const event = detail.event;
  const channels = Array.isArray(event.context?.channels) ? event.context.channels : [];
  const rows: { label: string; at: number | null; iso?: string; note?: string }[] = [
    { label: "原始发生", at: event.occurred_at, iso: utcTime(event.occurred_at) },
    { label: "服务器记录", at: event.recorded_at, iso: utcTime(event.recorded_at) },
  ];
  for (const observation of detail.observations) {
    rows.push({
      label: `${observation.kind}${observation.result !== "recorded" ? `（${observation.result}）` : ""}`,
      at: observation.client_at ?? observation.server_at,
      iso: `${utcTime(observation.client_at ?? observation.server_at)} / 客户端 ${
        observation.client_at ? utcTime(observation.client_at) : "未知"} / 服务器 ${utcTime(observation.server_at)}`,
    });
  }
  for (const channel of channels) {
    rows.push({
      label: `${channel.channel === "device" ? "设备回执" : "手机服务"} ${channel.status}`,
      at: typeof channel.at === "number" ? channel.at : null,
      iso: utcTime(channel.at),
    });
  }
  return (
    <ol className="mw-center-timeline" data-testid="notification-timeline">
      {rows.map((row, index) => (
        <li key={`${row.label}-${index}`}>
          <span>{row.label}</span>
          <time dateTime={new Date(row.at ?? 0).toISOString()}>{localTime(row.at)}</time>
          {row.iso && <small>{row.iso}</small>}
        </li>
      ))}
    </ol>
  );
}

function DetailView({ detail, onBack }: { detail: Detail; onBack: () => void }) {
  const store = useNotificationStore();
  const [confirmStop, setConfirmStop] = useState(false);
  const event = detail.event;
  const evidence = event.evidence ?? {};
  const context = event.context ?? {};
  return (
    <div className="mw-center-detail" data-testid="notification-detail">
      <header>
        <button type="button" onClick={onBack} aria-label="返回通知列表">
          <ChevronLeft size={16} /> 返回
        </button>
        <span className={`mw-center-severity severity-${event.severity}`}>
          {SEVERITY_LABEL[event.severity] ?? event.severity}
        </span>
      </header>
      <h3>{event.title}</h3>
      {event.summary && <p className="mw-center-summary">{event.summary}</p>}
      <dl className="mw-center-fields">
        <dt>事件 ID</dt><dd>{event.id}</dd>
        <dt>来源</dt><dd>{event.source.kind} · {event.source.id}</dd>
        <dt>事故</dt>
        <dd>{detail.incident ? `${detail.incident.status} · 共 ${detail.incident.count} 次` : "无"}</dd>
        <dt>本地时间</dt><dd>{localTime(event.occurred_at)}</dd>
        <dt>UTC</dt><dd>{utcTime(event.occurred_at)}</dd>
        {context.instrument && (<><dt>品种</dt><dd>{String(context.instrument)}</dd></>)}
        {context.timeframe && (<><dt>周期</dt><dd>{String(context.timeframe)}</dd></>)}
        {context.direction && (<><dt>方向</dt><dd>{String(context.direction)}</dd></>)}
        {context.price && (<><dt>实际值</dt><dd>{String(context.price)}</dd></>)}
        {context.threshold && (<><dt>阈值</dt><dd>{String(context.threshold)}</dd></>)}
        {evidence.rule_version && (<><dt>规则版本</dt><dd>{String(evidence.rule_version)}</dd></>)}
        {evidence.observation_id && (<><dt>观测</dt><dd>{String(evidence.observation_id)}</dd></>)}
        {context.run && (<><dt>图表代次</dt><dd>{String(context.run)}</dd></>)}
      </dl>
      <Timeline detail={detail} />
      <div className="mw-center-actions">
        <button type="button" disabled={event.read} onClick={() => store.markViewed(event.id)}>
          <Check size={14} /> {event.read ? "已读" : "标为已读"}
        </button>
        <button type="button" onClick={() => store.markHandled(event.id)}>
          <CheckCheck size={14} /> 标为已处理
        </button>
        {detail.incident?.status === "open" && (
          <button type="button" onClick={() => { void store.resolveIncident(detail.incident!.id); }}>
            <Check size={14} /> 标记事故已恢复
          </button>
        )}
        {event.actions?.phone_stop && !context.phone_stopped_at && (
          confirmStop ? (
            <button type="button" className="danger" onClick={async () => {
              const ok = await store.stopPhone(event.id);
              setConfirmStop(false);
              if (!ok) store.report({ title: "停止手机提醒失败", severity: "warning" });
            }}>确认停止后续手机提醒</button>
          ) : (
            <button type="button" onClick={() => setConfirmStop(true)}>停止此事件后续手机提醒</button>
          )
        )}
        {event.links?.signal_id && (
          <a href={`/signals?signal=${encodeURIComponent(String(event.links.signal_id))}`}>在信号中心查看</a>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, onOpen }: { event: CenterEvent; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`mw-center-row ${event.read ? "read" : "unread"} severity-${event.severity}`}
        data-testid="notification-item"
        data-event-id={event.id}
        onClick={onOpen}
      >
        <span className="mw-center-dot" aria-hidden="true" />
        <span className="mw-center-row-body">
          <strong>{event.title}</strong>
          {event.summary && <span className="mw-center-row-summary">{event.summary}</span>}
          <span className="mw-center-row-meta">
            {KIND_LABEL[event.kind] ?? event.kind} · {localTime(event.occurred_at)}
            {event.incident && event.incident.count > 1 ? ` · 同事故 ${event.incident.count} 次` : ""}
            {event.context?.instrument ? ` · ${event.context.instrument}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const store = useNotificationStore();
  const state = useCenterState();
  const [search, setSearch] = useState(state.filters.q);
  const dialog = useRef<HTMLDivElement>(null);
  const firstRun = useRef(true);

  useEffect(() => {
    dialog.current?.focus();
    const onKey = (keyboard: KeyboardEvent) => {
      if (keyboard.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const timer = window.setTimeout(() => {
      void store.setFilters({ ...state.filters, q: search });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    state.items.slice(0, 20).forEach((event) => { void store.observeOnce(event.id, "received"); });
  }, [state.items.length]);

  const filters: Filters = state.filters;
  const detail = state.detail;
  if (detail) {
    return (
      <div className="mw-center-panel" role="dialog" aria-label="通知详情" ref={dialog} tabIndex={-1}
        data-testid="notification-panel">
        <DetailView detail={detail} onBack={() => store.closeDetail()} />
      </div>
    );
  }
  return (
    <div className="mw-center-panel" role="dialog" aria-label="通知中心" ref={dialog} tabIndex={-1}
      data-testid="notification-panel">
      <header className="mw-center-header">
        <div>
          <strong>通知中心</strong>
          <span className={`mw-center-conn conn-${state.connection}`} data-testid="notification-connection">
            {CONNECTION_LABEL[state.connection] ?? state.connection}
            {state.pending > 0 ? ` · 待同步 ${state.pending}` : ""}
          </span>
        </div>
        <div className="mw-center-header-actions">
          <button
            type="button"
            aria-pressed={state.soundEnabled}
            data-testid="notification-sound"
            onClick={() => {
              void store.setSoundEnabled(!store.isSoundUnlocked());
            }}
          >
            {!state.soundEnabled ? <VolumeX size={15} /> : <Volume2 size={15} />}
            {!state.soundEnabled ? "开启声音"
              : store.isSoundUnlocked() ? "声音已开" : "声音待解锁"}
          </button>
          <button type="button" aria-label="刷新通知" onClick={() => { void store.refresh(true); }}>
            <RefreshCw size={15} />
          </button>
          <button type="button" aria-label="关闭通知中心" onClick={onClose}><X size={16} /></button>
        </div>
      </header>
      {state.notices.map((notice) => (
        <p className="mw-center-notice" role="status" key={notice}>{notice}</p>
      ))}
      <div className="mw-center-filters">
        <select aria-label="按类型筛选" value={filters.kind}
          onChange={(change) => { void store.setFilters({ ...filters, kind: change.target.value }); }}>
          <option value="">全部类型</option>
          <option value="alert">告警</option>
          <option value="failure">异常</option>
          <option value="operation">操作</option>
          <option value="success">成功</option>
        </select>
        <select aria-label="按级别筛选" value={filters.severity}
          onChange={(change) => { void store.setFilters({ ...filters, severity: change.target.value }); }}>
          <option value="">全部级别</option>
          <option value="critical">严重</option>
          <option value="warning">警告</option>
          <option value="info">提示</option>
        </select>
        <select aria-label="按状态筛选" value={filters.status}
          onChange={(change) => { void store.setFilters({ ...filters, status: change.target.value }); }}>
          <option value="">全部状态</option>
          <option value="open">未解决</option>
          <option value="resolved">已恢复</option>
          <option value="all">含历史</option>
        </select>
        <input aria-label="搜索通知" placeholder="搜索标题或摘要" value={search}
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      {state.items.length === 0 ? (
        <p className="mw-center-empty" data-testid="notification-empty">
          {state.ready ? "没有符合条件的通知。" : "正在加载通知…"}
        </p>
      ) : (
        <ul className="mw-center-list" data-testid="notification-list">
          {state.items.map((event) => (
            <EventRow key={event.id} event={event} onOpen={() => { void store.openDetail(event.id); }} />
          ))}
        </ul>
      )}
      <div className="mw-center-pager">
        {state.olderWindow && (
          <button type="button" onClick={() => { void store.refresh(true); }}>
            返回到最新
          </button>
        )}
        {state.nextBefore && (
          <button type="button" className="mw-center-more" disabled={state.loadingMore}
            data-testid="notification-more" onClick={() => { void store.loadMore(); }}>
            {state.loadingMore ? "正在加载…" : state.olderWindow ? "更早的通知" : "加载更多"}
          </button>
        )}
      </div>
    </div>
  );
}

export function NotificationEntry() {
  const store = useNotificationStore();
  const state = useCenterState();
  const [open, setOpen] = useState(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => {
    setOpen(false);
    entryRef.current?.focus();
  }, []);

  useEffect(() => {
    const listener = () => setOpen(true);
    window.addEventListener("mw-notification-open", listener);
    return () => window.removeEventListener("mw-notification-open", listener);
  }, []);

  useEffect(() => {
    if (state.bubble && open) store.dismissBubble();
  }, [open, state.bubble?.event.id]);

  return (
    <div className="mw-center-anchor">
      <EntryButton open={open} onToggle={() => setOpen((value) => !value)} buttonRef={entryRef} />
      {!open && <Bubble onOpen={openPanel} />}
      {open && <Panel onClose={closePanel} />}
    </div>
  );
}
