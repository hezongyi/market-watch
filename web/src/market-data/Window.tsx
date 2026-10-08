import { useCallback, useEffect, useRef, useState } from "react";
import { X, Database, Layers, ListChecks, Radio, Settings2 } from "lucide-react";
import { api } from "./api";
import Center from "./Center";
import { CenterContext, type CenterNavigation } from "./router";
import { centerLocation, centerTab } from "./location";
import "./window.css";

const channel = "mw-data-center-v1";
const tabs = [["managed", "自建行情", Database], ["platform", "平台品种", Radio], ["composite", "组合行情", Layers], ["tasks", "任务与记录", ListChecks], ["sources", "来源与能力", Settings2]] as const;
type Context = { workspace: string; target: string; theme: string; symbolSync: boolean; intervalSync: boolean; location?: string };
type Position = { top: number; tableTop: number; tableLeft: number; focus: string | null };
function readMemory<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
}

/** React owns business state; the public chart host owns the fullscreen dialog. */
export default function DataCenterWindow() {
  const session = new URLSearchParams(location.search).get("session") || "";
  const host = new URL((import.meta as any).env.VITE_ADVANCED_CHART_ORIGIN || `${location.protocol}//${location.hostname}:5187`).origin;
  const [context, setContext] = useState<Context | null>(null);
  const [route, setRoute] = useState(() => centerLocation(sessionStorage.getItem("mw-data-center-location") || "/market-data"));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [guard, setGuard] = useState<(() => void) | null>(null);
  const dirty = useRef(new Set<string>()), routeRef = useRef(route), contextRef = useRef(context);
  const applying = useRef(false);
  const request = useRef<{ id: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const content = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null), guardBox = useRef<HTMLDivElement>(null);
  const positions = useRef<Record<string, Position>>(readMemory("mw-data-center-positions", {}));
  const tabLocations = useRef<Record<string, string>>(readMemory("mw-data-center-tabs", {}));
  const guardFocus = useRef<HTMLElement | null>(null);
  routeRef.current = route; contextRef.current = context;
  const post = useCallback((value: object) => parent.parent.postMessage({ channel, session, ...value }, host), [session, host]);
  const setDirty = useCallback((key: string, value: boolean) => { value ? dirty.current.add(key) : dirty.current.delete(key); }, []);
  const clearDirty = useCallback(() => dirty.current.clear(), []);
  const protect = useCallback((action: () => void) => {
    if (applying.current) { setError("图表正在应用行情，请等待结果。"); return; }
    if (dirty.current.size) { guardFocus.current = document.activeElement as HTMLElement; setGuard(() => action); }
    else action();
  }, []);
  const rememberPosition = useCallback(() => {
    const active = document.activeElement as HTMLElement;
    const table = content.current?.querySelector<HTMLElement>(".dc-table");
    positions.current[routeRef.current] = { top: content.current?.scrollTop || 0,
      tableTop: table?.scrollTop || 0, tableLeft: table?.scrollLeft || 0,
      focus: active.id || active.closest("tr[id]")?.id || null };
    const recent = Object.entries(positions.current).slice(-50);
    positions.current = Object.fromEntries(recent);
    sessionStorage.setItem("mw-data-center-positions", JSON.stringify(positions.current));
  }, []);
  const close = useCallback(() => protect(() => { rememberPosition(); post({ type: "close" }); }), [protect, post, rememberPosition]);
  const navigate = useCallback<CenterNavigation["navigate"]>((to, options) => {
    const action = () => {
      const replay = /^\/replay(?:\?dataset_version=[a-f0-9-]{36})?$/.test(to);
      if (replay) { post({ type: "replay", path: to }); return; }
      let next = centerLocation(to, routeRef.current);
      const parsed = new URL(next, "https://center.invalid");
      if (parsed.pathname === "/market-data" && !parsed.hash && new URL(routeRef.current, "https://center.invalid").pathname !== "/market-data" && [...parsed.searchParams.keys()].every(key => key === "tab"))
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
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try {
        const meta = await api<{ frames: string[] }>("/market-data/resolve", { instrument: ticker.slice(4), series_kind: kind, timeframe: frame }, controller.signal);
        if (!meta.frames?.includes(frame)) throw Error("所选行情尚未提供该周期，请选择可用周期。");
      } finally { clearTimeout(timer); }
      await new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { if (request.current?.id === id) { request.current = null; reject(Error("图表应用结果暂未返回。请查看目标图格后重新打开窗口核查。")); } }, 60000);
        request.current = { id, resolve, reject, timer };
        post({ type: "apply", id, target: contextRef.current!.target, workspace: contextRef.current!.workspace, ticker, frame });
      });
      post({ type: "close" });
    } catch (e) { setError(String(e)); throw e; }
    finally { applying.current = false; setBusy(false); }
  }, [post]);
  useEffect(() => {
    if (parent === window || !/^[a-f0-9-]{36}$/.test(session)) { setError("请从图表顶部的数据中心打开窗口。"); return; }
    const listener = (event: MessageEvent) => {
      if (event.source !== parent.parent || event.origin !== host || event.data?.channel !== channel || event.data.session !== session) return;
      const m = event.data;
      if (m.type === "context" && typeof m.context?.target === "string" && typeof m.context?.workspace === "string") {
        setContext(m.context);
        if (m.context.location) { dirty.current.clear(); setRoute(centerLocation(m.context.location)); }
        closeButton.current?.focus();
      } else if (m.type === "theme" && /^(dark|light)$/.test(m.theme)) {
        setContext(value => value ? { ...value, theme: m.theme } : value);
      } else if (m.type === "request-close") close();
      else if (m.type === "apply-result" && m.id === request.current?.id) {
        const pending = request.current!; request.current = null; clearTimeout(pending.timer);
        m.error ? pending.reject(Error(String(m.error))) : pending.resolve();
      }
    };
    addEventListener("message", listener); post({ type: "ready" });
    return () => { removeEventListener("message", listener); if (request.current) { clearTimeout(request.current.timer); request.current.reject(Error("窗口已关闭，请核查图表结果")); request.current = null; } };
  }, [post, close, session, host]);
  useEffect(() => {
    sessionStorage.setItem("mw-data-center-location", route);
    if (new URL(route, "https://center.invalid").pathname === "/market-data") {
      tabLocations.current[centerTab(route)] = route;
      sessionStorage.setItem("mw-data-center-tabs", JSON.stringify(tabLocations.current));
    }
    post({ type: "location", location: route });
    let restored = false;
    const restore = () => {
      if (restored) return;
      const saved = positions.current[route];
      const table = content.current?.querySelector<HTMLElement>(".dc-table");
      if (saved && (saved.tableTop || saved.tableLeft) && !table) return;
      if (content.current) content.current.scrollTop = saved?.top || 0;
      if (table && saved) { table.scrollTop = saved.tableTop; table.scrollLeft = saved.tableLeft; }
      const focus = saved?.focus ? document.getElementById(saved.focus) : content.current?.querySelector<HTMLElement>("h1");
      if (focus) { if (!focus.matches("button,a,input,select,textarea")) focus.tabIndex = -1; focus.focus({ preventScroll: true }); restored = true; }
    };
    const frame = requestAnimationFrame(restore);
    const observer = new MutationObserver(restore);
    if (content.current) observer.observe(content.current, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [route, post]);
  useEffect(() => {
    if (guard) guardBox.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [guard]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current.size) { event.preventDefault(); event.returnValue = ""; } };
    const keyboard = (event: KeyboardEvent) => {
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
        const items = [...(scope?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') || [])].filter(item => item.getClientRects().length);
        const first = items[0], last = items.at(-1), active = document.activeElement;
        if (event.shiftKey && (active === first || !scope?.contains(active))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !scope?.contains(active))) { event.preventDefault(); first?.focus(); }
      }
    };
    addEventListener("beforeunload", unload); addEventListener("keydown", keyboard);
    return () => { removeEventListener("beforeunload", unload); removeEventListener("keydown", keyboard); };
  }, [close, guard]);
  return <CenterContext value={{ location: route, navigate, apply, setDirty, clearDirty, busy }}>
    <main className="dc-window" data-theme={context?.theme || "dark"}>
      <header className="dc-window-header"><h2>数据中心</h2><button ref={closeButton} aria-label="关闭数据中心" onClick={close}><X aria-hidden="true" size={20} /></button></header>
      <div className="dc-window-body" inert={guard !== null}>
        <nav className="dc-window-nav" aria-label="数据中心分区">{tabs.map(([key, label, Icon]) => <button key={key} aria-current={centerTab(route) === key ? "page" : undefined} onClick={() => navigate(tabLocations.current[key] || `/market-data?tab=${key}`)}><Icon size={18} aria-hidden="true" />{label}</button>)}</nav>
        <div className="dc-window-content" ref={content}>
          {error && <p role="alert" className="error">{error}</p>}
          {!context ? <p role="status">正在连接图表工作区…</p> : <Center />}
        </div>
      </div>
      <footer className="dc-window-footer" role="status">{busy ? "正在打开所选行情…" : context?.symbolSync || context?.intervalSync ? "仅在打开时记录的图格应用行情；打开将关闭品种和周期同步，以保留其他图格。" : "浏览不会启动实时采集；关闭窗口后，已提交的维护继续运行。"}</footer>
      {guard && <div ref={guardBox} className="dc-unsaved" role="alertdialog" aria-modal="true" aria-labelledby="dc-unsaved-title"><h3 id="dc-unsaved-title">尚有未保存的修改</h3><p>离开将放弃这些输入；已经提交的后台任务会继续。</p><div className="dc-actions"><button onClick={() => { setGuard(null); guardFocus.current?.focus(); }}>继续编辑</button><button onClick={() => { const action = guard; dirty.current.clear(); setGuard(null); action(); }}>放弃修改</button></div></div>}
    </main>
  </CenterContext>;
}
