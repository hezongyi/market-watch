import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Database, Layers, ListChecks, Radio, Activity, CalendarDays } from "lucide-react";
import Center from "./Center";
import { CenterContext, type CenterNavigation } from "./router";
import { centerLocation, centerPositionKey, centerTab } from "./location";
import { ReturnContexts } from "./returnContext";
import "./window.css";
import { NativeSlot, NativeSidebar, NativeUiContext, NativeOperationHint } from "./NativeControls";

const navIcon = (key:string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${({managed:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',platform:'<circle cx="12" cy="12" r="2"/><path d="M16 8a6 6 0 0 1 0 8M8 8a6 6 0 0 0 0 8M19 5a10 10 0 0 1 0 14M5 5a10 10 0 0 0 0 14"/>',composite:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',tasks:'<path d="m3 6 2 2 4-4M12 6h9M3 13h6M12 13h9M3 20h6M12 20h9"/>',sources:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'} as Record<string,string>)[key]}</svg>`;
const channel = "mw-data-center-v1";
const tabs = [["managed", "自建行情", Database], ["platform", "平台行情", Radio], ["composite", "组合行情", Layers], ["tasks", "任务与记录", ListChecks], ["sources", "来源状态", Activity], ["calendar", "交易日历", CalendarDays]] as const;
const operationHints: Record<string, string> = {
  managed: "选择行情查看版本与周期。",
  platform: "搜索或筛选品种，查看详情。",
  composite: "选择组合查看接续与修订。",
  tasks: "刷新列表，展开任务记录。",
  sources: "展开来源查看状态与记录。",
  calendar: "展开品种查看交易日历。",
};
type Context = { workspace: string; target: string; theme: string; timezone?: string; symbolSync: boolean; intervalSync: boolean; location?: string };
type Position = { top: number; tableTop: number; tableLeft: number; focus: string | null };
export type HostedCenter = {
  context: Context;
  post: (message: any) => void;
  subscribe: (listener: (message: any) => void) => () => void;
};
function readMemory<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
}
function readPositions(key: string): Record<string, Position> {
  return Object.fromEntries(Object.entries(readMemory<Record<string, Position>>(key, {}))
    .map(([route, position]) => [centerPositionKey(route), position]).slice(-50));
}

/** React owns business state; the public chart host owns the fullscreen dialog. */
export default function DataCenterWindow({ hosted }: { hosted?: HostedCenter } = {}) {
  const nativeUi = useContext(NativeUiContext);
  const session = new URLSearchParams(location.search).get("session") || "";
  const host = hosted ? location.origin : new URL((import.meta as any).env?.VITE_ADVANCED_CHART_ORIGIN || `${location.protocol}//${location.hostname}:5187`).origin;
  const [context, setContext] = useState<Context | null>(hosted?.context || null);
  const [route, setRoute] = useState(() => centerLocation(hosted?.context.location || sessionStorage.getItem(`mw-data-center:${hosted?.context.workspace || session}:location`) || "/market-data"));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [guard, setGuard] = useState<(() => void) | null>(null);
  const dirty = useRef(new Set<string>()), routeRef = useRef(route), contextRef = useRef(context);
  const applying = useRef(false);
  const request = useRef<{ id: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const content = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null), guardBox = useRef<HTMLDivElement>(null);
  const memoryScope = `mw-data-center:${context?.workspace || session}`;
  const positions = useRef<Record<string, Position>>(readPositions(memoryScope + ":positions"));
  const tabLocations = useRef<Record<string, string>>(readMemory(memoryScope + ":tabs", {}));
  const returns = useRef(new ReturnContexts(context?.workspace || session));
  if (returns.current.workspace !== (context?.workspace || session)) {
    returns.current = new ReturnContexts(context?.workspace || session);
    positions.current = readPositions(memoryScope + ":positions");
    tabLocations.current = readMemory(memoryScope + ":tabs", {});
  }
  const restoreScope = useRef<string | null>(null);
  const lastContentFocus = useRef<string | null>(null);
  const guardFocus = useRef<HTMLElement | null>(null);
  const parsedRoute = new URL(route, "https://center.invalid");
  const routeScope = parsedRoute.pathname + "?tab=" + centerTab(route) + (parsedRoute.pathname.includes("/datasets/") ? `&section=${parsedRoute.searchParams.get("section") || "overview"}&version=${["coverage","chart"].includes(parsedRoute.searchParams.get("section") || "") ? parsedRoute.searchParams.get("version") || "" : ""}` : "") + parsedRoute.hash;
  routeRef.current = route; contextRef.current = context;
  const post = useCallback((value: object) => hosted ? hosted.post(value) : parent.parent.postMessage({ channel, session, ...value }, host), [session, host, hosted]);
  const setDirty = useCallback((key: string, value: boolean) => { value ? dirty.current.add(key) : dirty.current.delete(key); }, []);
  const clearDirty = useCallback(() => dirty.current.clear(), []);
  const protect = useCallback((action: () => void) => {
    if (applying.current) { setError("图表正在应用行情，请等待结果。"); return; }
    if (dirty.current.size) { guardFocus.current = document.activeElement as HTMLElement; setGuard(() => action); }
    else action();
  }, []);
  const rememberPosition = useCallback(() => {
    const active = document.activeElement as HTMLElement;
    const table = content.current?.querySelector<HTMLElement>(".dc-table,.dc-platform-scroll,.dc-market-list");
    positions.current[centerPositionKey(routeRef.current)] = { top: (content.current?.querySelector<HTMLElement>(".dc-dataset-body") || content.current)?.scrollTop || 0,
      tableTop: table?.scrollTop || 0, tableLeft: table?.scrollLeft || 0,
      focus: content.current?.contains(active) ? active.id || active.closest("tr[id],.dc-task-row[id],.dc-market-row[id],.dc-business-row[id]")?.id || null : lastContentFocus.current };
    const recent = Object.entries(positions.current).slice(-50);
    positions.current = Object.fromEntries(recent);
    sessionStorage.setItem(`mw-data-center:${contextRef.current?.workspace || session}:positions`, JSON.stringify(positions.current));
  }, [session]);
  const close = useCallback(() => protect(() => { rememberPosition(); post({ type: "close" }); }), [protect, post, rememberPosition]);
  const navigate = useCallback<CenterNavigation["navigate"]>((to, options) => {
    const action = () => {
      const replay = /^\/replay(?:\?dataset_version=[a-f0-9-]{36})?$/.test(to);
      if (replay) { post({ type: "replay", path: to }); return; }
      let next = centerLocation(to, routeRef.current);
      const parsed = new URL(next, "https://center.invalid");
      if (parsed.pathname === "/market-data" && centerTab(next) !== "tasks" && !parsed.hash && new URL(routeRef.current, "https://center.invalid").pathname !== "/market-data" && [...parsed.searchParams.keys()].every(key => key === "tab"))
        next = tabLocations.current[centerTab(next)] || next;
      if (next === routeRef.current) return;
      rememberPosition();
      dirty.current.clear(); setError(""); setRoute(next);
    };
    if (options?.saved) { dirty.current.clear(); action(); } else protect(action);
  }, [post, protect, rememberPosition]);
  const apply = useCallback(async (ticker: string, frame: string) => {
    if (applying.current) throw Error("正在打开行情，请等待结果。");
    if (dirty.current.size) throw Error("请先保存或放弃表单修改，再打开图表。");
    if (!contextRef.current) throw Error("目标图格尚未就绪，请重新打开数据中心。");
    applying.current = true; setBusy(true); setError("");
    try {
      const kind = ticker.startsWith("MWP:") ? "provider" : ticker.startsWith("MWH:") ? "history" : ticker.startsWith("MWC:") ? "composite" : "";
      if (!kind) throw Error("无效行情身份");
      // The host acknowledges the command before loading its market data.
      // Keep source validation in one place and save selection before unmount.
      rememberPosition();
      await new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { if (request.current?.id === id) { request.current = null; reject(Error("图表未接收打开请求，请重新打开窗口核查。")); } }, 5000);
        request.current = { id, resolve, reject, timer };
        post({ type: "apply", id, target: contextRef.current!.target, workspace: contextRef.current!.workspace, ticker, frame });
      });
    } catch (e) { setError(String(e)); throw e; }
    finally { applying.current = false; setBusy(false); }
  }, [post, rememberPosition]);
  useEffect(() => {
    if (!hosted && (parent === window || !/^[a-f0-9-]{36}$/.test(session))) { setError("请从图表顶部的数据中心打开窗口。"); return; }
    const receive = (m: any) => {
      if (m.type === "timezone" && typeof m.timezone === "string") setContext(value => value ? {...value, timezone:m.timezone} : value);
      if (m.type === "context" && typeof m.context?.target === "string" && typeof m.context?.workspace === "string") {
        setContext(m.context);
        if (m.context.location) { dirty.current.clear(); setRoute(centerLocation(m.context.location)); }
        closeButton.current?.focus();
      } else if (m.type === "theme" && /^(dark|light)$/.test(m.theme)) {
        setContext(value => value ? { ...value, theme: m.theme } : value);
      } else if (m.type === "request-close") close();
      else if (m.type === "navigate" && typeof m.location === "string") navigate(m.location);
      else if (m.type === "apply-result" && m.id === request.current?.id) {
        const pending = request.current!; request.current = null; clearTimeout(pending.timer);
        m.error ? pending.reject(Error(String(m.error))) : pending.resolve();
      }
    };
    if (hosted) {
      const unsubscribe = hosted.subscribe(receive); post({ type: "ready" });
      return () => {unsubscribe(); if(request.current) {clearTimeout(request.current.timer); request.current.reject(Error("窗口已关闭"));request.current=null;}};
    }
    const listener = (event: MessageEvent) => {
      if (event.source !== parent.parent || event.origin !== host || event.data?.channel !== channel || event.data.session !== session) return;
      receive(event.data);
    };
    addEventListener("message", listener); post({ type: "ready" });
    return () => { removeEventListener("message", listener); if (request.current) { clearTimeout(request.current.timer); request.current.reject(Error("窗口已关闭，请核查图表结果")); request.current = null; } };
  }, [post, close, session, host, hosted, navigate]);
  useEffect(() => {
    if (!context?.workspace) return;
    sessionStorage.setItem(memoryScope + ":location", route);
    if (new URL(route, "https://center.invalid").pathname === "/market-data") {
      tabLocations.current[centerTab(route)] = route;
      sessionStorage.setItem(memoryScope + ":tabs", JSON.stringify(tabLocations.current));
    }
    post({ type: "location", location: route });
  }, [route, post, memoryScope, context?.workspace]);
  useEffect(() => {
    const sameScope = restoreScope.current === routeScope;
    restoreScope.current = routeScope;
    // Filters/page changes keep the user's active control. Restore position
    // only when entering a section/detail or returning to a specific row.
    if (sameScope) return;
    lastContentFocus.current = null;
    let restored = false;
    // A user can start using the header while evidence is still loading.
    // Late restoration must never steal that focus or override their scroll.
    const interacted = (event: Event) => { if (content.current?.contains(event.target as Node)) restored = true; };
    document.addEventListener("pointerdown", interacted, true);
    document.addEventListener("keydown", interacted, true);
    content.current?.addEventListener("wheel", interacted, {capture: true, passive: true});
    let platformSettled = false, platformFrame = 0;
    const saved = positions.current[centerPositionKey(route)];
    const restore = () => {
      if (restored) return;
      const table = content.current?.querySelector<HTMLElement>(".dc-table,.dc-platform-scroll,.dc-market-list");
      if (table?.matches(".dc-market-list") && !table.querySelector(".dc-market-row,.dc-task-row")) return;
      if (content.current?.querySelector(".dc-platform") && !table) return;
      if (table?.matches(".dc-platform-scroll") && !table.querySelector('[data-role="list-item"]')) return;
      if (table?.matches(".dc-platform-scroll") && !platformSettled) {
        if (!platformFrame) platformFrame = requestAnimationFrame(() => {
          platformFrame = requestAnimationFrame(() => { platformSettled = true; restore(); });
        });
        return;
      }
      if (saved && (saved.tableTop || saved.tableLeft) && !table) return;
      // Evidence/version rows load after the dataset summary. Restoring before
      // those rows exist clamps a saved scroll offset to an empty body.
      if ([...content.current?.querySelectorAll<HTMLElement>('.dc-dataset-detail [role="status"]') || []].some(node => node.textContent === "正在读取数据…")) return;
      // Source rows and diagnostic controls arrive with the first snapshot.
      // Wait for that read to settle before restoring into the short loading page.
      if (content.current?.querySelector('.dc-sources [data-source-loading="true"]')) return;
      const requestedFocus = parsedRoute.hash.slice(1) || saved?.focus;
      const target = requestedFocus ? document.getElementById(requestedFocus) : null;
      if (parsedRoute.hash && !target && !content.current?.querySelector('[role="alert"]')) return;
      const scrolling = content.current?.querySelector<HTMLElement>(".dc-dataset-body") || content.current;
      if (scrolling?.matches(".dc-dataset-body") && saved?.top && scrolling.scrollHeight - scrolling.clientHeight < saved.top - 1 && !content.current?.querySelector('[role="alert"]')) return;
      if (scrolling) scrolling.scrollTop = saved?.top || 0;
      if (table && saved) { table.scrollTop = saved.tableTop; table.scrollLeft = saved.tableLeft; }
      const focus = target || content.current?.querySelector<HTMLElement>('.dc-platform input[role="searchbox"],.dc-market-page input[role="searchbox"],h1');
      if (target && parsedRoute.hash) target.scrollIntoView({block: "center"});
      if (focus) { if (!focus.matches("button,a,input,select,textarea")) focus.tabIndex = -1; focus.focus({ preventScroll: true }); restored = true; }
    };
    const frame = requestAnimationFrame(restore);
    const observer = new MutationObserver(restore);
    if (content.current) observer.observe(content.current, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(platformFrame); observer.disconnect();
      document.removeEventListener("pointerdown", interacted, true);
      document.removeEventListener("keydown", interacted, true);
      content.current?.removeEventListener("wheel", interacted, true);
    };
  }, [routeScope, post]);
  useEffect(() => {
    if (guard) guardBox.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [guard]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current.size) { event.preventDefault(); event.returnValue = ""; } };
    const keyboard = (event: KeyboardEvent) => {
      if (!guard && event.key === "Escape" && !event.defaultPrevented) {
        const menu = (event.target as HTMLElement).closest<HTMLDetailsElement>(".dc-more[open]");
        if (menu) { event.preventDefault(); event.stopImmediatePropagation(); menu.open = false; menu.querySelector("summary")?.focus(); return; }
        const detailClose = content.current?.querySelector<HTMLButtonElement>("[data-dc-detail-close]");
        const popup = document.querySelector('[role="listbox"]');
        if (detailClose && !popup?.getClientRects().length) {
          event.preventDefault(); event.stopImmediatePropagation(); detailClose.click(); return;
        }
      }
      if (hosted && !guard && event.key === "Escape" && !event.defaultPrevented) {
        const filters = content.current?.querySelector<HTMLButtonElement>('.dc-filter-toggle[aria-expanded="true"]');
        // A native Select/picker owns Escape while its separate popup is open.
        const ownPopup = (event.target as HTMLElement).closest('[role="dialog"],[role="listbox"]');
        if (filters?.getClientRects().length && (!ownPopup || ownPopup.contains(content.current))) {
          event.preventDefault(); event.stopImmediatePropagation(); filters.click(); filters.focus(); return;
        }
      }
      const fullPanel = content.current?.matches('[data-detail-mode="full"]') && content.current.querySelector<HTMLElement>(".dc-detail-panel");
      if (fullPanel && event.key === "Tab" && !guard) {
        const items = [...fullPanel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(item => item.getClientRects().length && !item.closest("[inert]"));
        const first = items[0], last = items.at(-1), active = document.activeElement;
        if (event.shiftKey && (active === first || !fullPanel.contains(active) || active === fullPanel)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !fullPanel.contains(active) || active === fullPanel)) { event.preventDefault(); first?.focus(); }
        if (event.defaultPrevented) event.stopImmediatePropagation();
        return;
      }
      if (hosted && !guard) return;
      if (hosted && guard && event.key === "Escape") {event.preventDefault();event.stopImmediatePropagation();setGuard(null);guardFocus.current?.focus();return;}
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation();
        const filters = document.querySelector<HTMLButtonElement>('.dc-filter-toggle[aria-expanded="true"]');
        if (filters?.getClientRects().length) { filters.click(); filters.focus(); return; }
        const menu = (event.target as HTMLElement).closest<HTMLDetailsElement>("details[open]");
        if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); return; }
        if (guard) { setGuard(null); guardFocus.current?.focus(); } else close();
      }
      if (event.key === "Tab") {
        const scope = guard ? guardBox.current : document.querySelector(".dc-window");
        const items = [...(scope?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') || [])].filter(item => item.getClientRects().length && !item.closest("[inert]"));
        const first = items[0], last = items.at(-1), active = document.activeElement;
        if (event.shiftKey && (active === first || !scope?.contains(active))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !scope?.contains(active))) { event.preventDefault(); first?.focus(); }
      }
    };
    addEventListener("beforeunload", unload); addEventListener("keydown", keyboard, true);
    return () => { removeEventListener("beforeunload", unload); removeEventListener("keydown", keyboard, true); };
  }, [close, guard, hosted]);
  return <CenterContext value={{ workspace: context?.workspace, target: context?.target, timezone:context?.timezone, returns: returns.current, location: route, navigate, apply, setDirty, clearDirty, busy }}>
    <main className={`dc-window${hosted ? " dc-window-native" : ""}`} data-theme={context?.theme || "dark"}>
      {!hosted && <header className="dc-window-header"><h2><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></svg>数据中心</h2><button ref={closeButton} aria-label="关闭数据中心" onClick={close}><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path stroke="currentColor" strokeWidth="1.2" d="m1.5 1.5 15 15m0-15-15 15" /></svg></button></header>}
      <div className="dc-window-body" inert={guard !== null}>
        <nav className="dc-window-nav" aria-label="数据中心分区">{nativeUi ? <NativeSidebar>{tabs.map(([key,label])=><NativeSlot key={key} kind="sidebarItem" props={{title:label,icon:{default:navIcon(key),bold:navIcon(key)},tag:"button",isActive:centerTab(route)===key,"aria-current":centerTab(route)===key?"page":undefined,onClick:()=>navigate(key === "tasks" ? "/market-data?tab=tasks" : tabLocations.current[key] || `/market-data?tab=${key}`)}} />)}</NativeSidebar> : <>{tabs.map(([key,label,Icon])=><button key={key} aria-current={centerTab(route)===key?"page":undefined} onClick={()=>navigate(key === "tasks" ? "/market-data?tab=tasks" : tabLocations.current[key] || `/market-data?tab=${key}`)}><Icon size={18} aria-hidden="true" />{label}</button>)}</>}</nav>
        <div className="dc-window-content" ref={content} onFocusCapture={event => {
          const active = event.target as HTMLElement;
          lastContentFocus.current = active.id || active.closest("tr[id],.dc-task-row[id],.dc-market-row[id],.dc-business-row[id]")?.id || null;
        }}>
          {error && <p role="alert" className="error">{error}</p>}
          {!context ? <p role="status">正在连接图表工作区…</p> : <Center />}
        </div>
      </div>
      <NativeOperationHint>{`${operationHints[centerTab(route)] || "点击分区浏览。"} Esc 关闭窗口。`}</NativeOperationHint>
      {guard && <div ref={guardBox} className="dc-unsaved" role="alertdialog" aria-modal="true" aria-labelledby="dc-unsaved-title"><h3 id="dc-unsaved-title">尚有未保存的修改</h3><p>离开将放弃这些输入；已经提交的后台任务会继续。</p><div className="dc-actions"><button onClick={() => { setGuard(null); guardFocus.current?.focus(); }}>继续编辑</button><button onClick={() => { const action = guard; dirty.current.clear(); setGuard(null); action(); }}>放弃修改</button></div></div>}
    </main>
  </CenterContext>;
}
