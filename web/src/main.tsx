import React, { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  useNavigate,
  useBlocker,
  useParams,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  Menu,
  Moon,
  Sun,
  Activity,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  LogOut,
  Play,
  Plus,
  Radio,
  Settings2,
  ShieldCheck,
  SkipForward,
  Square,
  Target,
  Waves,
} from "lucide-react";
import Chart from "./Chart";
import {
  api,
  ApiError,
  setCsrf,
  date,
  type Bar,
  type Instrument,
  type Watch,
  type Signal,
} from "./api";
import "./style.css";
import Login from "./app/Login";
import { AppContext, useApp, type LeaveGuard } from "./app/context";
import { safeNext, defaultChart, pageName, chartReturn } from "./app/navigation";
import "./app/app.css";
import AdvancedWorkspacePage from "./advanced/AdvancedWorkspace";
import DataCenterWindow from "./market-data/Window";
import { centerLocation } from "./market-data/location";
import SeriesPicker, { type QualifiedSeries } from "./market-data/SeriesPicker";
import { instrumentName, instrumentIdentity, instrumentIcon } from "./instrumentPresentation";
import InstrumentDetails from "./InstrumentDetails";
import ReplayJobs from "./ReplayJobs";

const names: Record<string, string> = {
  pullback: "回落 / 反弹结束",
  previous_day: "前日高低点突破",
  price: "价格穿越",
  indicator: "双均线交叉（SMA）",
};
const statusNames: Record<string, string> = {
  active: "监控中",
  triggered: "已触发",
  cancelled: "已取消",
  paused: "数据暂停",
};
const ChartWorkspacePage = lazy(() => import("./charts/Workspace"));
const frames = ["M1", "M5", "M15", "H1", "H4", "D1"];

function App() {
  const appLocation = useLocation(), navigate = useNavigate();
  const [ready, setReady] = useState(false), [logged, setLogged] = useState(false), [connectionError, setConnectionError] = useState("");
  const [theme, setThemeState] = useState<"dark" | "light">(localStorage.getItem("mw.app-theme") === "light" ? "light" : "dark");
  const [pending, setPending] = useState(0);
  const guard = useRef<LeaveGuard | null>(null);
  const [leave, setLeave] = useState<{resolve: (allowed: boolean) => void; guard: LeaveGuard} | null>(null);
  const [leaveError, setLeaveError] = useState(""), [leaveBusy, setLeaveBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), leaving = useRef<Promise<boolean> | null>(null), expired = useRef(false);
  const bypass = useRef(false);
  const setTheme = useCallback((value: "dark" | "light") => { localStorage.setItem("mw.app-theme", value); setThemeState(value); }, []);
  const registerGuard = useCallback((value: LeaveGuard) => { guard.current = value; return () => { if (guard.current === value) guard.current = null; }; }, []);
  const confirmLeave = useCallback((): Promise<boolean> => {
    if (bypass.current || !guard.current?.dirty()) return Promise.resolve(true);
    if (leaving.current) return leaving.current;
    const current = guard.current;
    leaving.current = new Promise<boolean>(resolve => { setLeaveError(""); setLeave({ resolve, guard: current }); });
    void leaving.current.finally(() => { leaving.current = null; });
    return leaving.current;
  }, []);
  const blocker = useBlocker(({currentLocation, nextLocation}) => !bypass.current && currentLocation.pathname !== nextLocation.pathname && !!guard.current?.dirty() && (guard.current.shouldBlock?.(nextLocation.pathname) ?? true));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let active = true;
    void confirmLeave().then(ok => { if (active) { if (ok) blocker.proceed(); else blocker.reset(); } });
    return () => { active = false; };
  }, [blocker, confirmLeave]);
  useEffect(() => { if (leave && !dialog.current?.open) dialog.current?.showModal(); }, [leave]);
  function finishLeave(ok: boolean) { dialog.current?.close(); leave?.resolve(ok); setLeave(null); }
  const checkSession = useCallback(async () => {
    setConnectionError("");
    try { const r = await api("/session"); setCsrf(r.csrf); setLogged(true); }
    catch (e) { if (e instanceof ApiError && e.status === 401) { setCsrf(""); setLogged(false); } else setConnectionError(String(e)); }
    finally { setReady(true); }
  }, []);
  useEffect(() => { void checkSession(); }, [checkSession]);
  useEffect(() => {
    const expire = async () => {
      if (expired.current || !logged) return;
      expired.current = true;
      try {
        await guard.current?.preserve();
        dialog.current?.close();
        setLeave(current => { current?.resolve(false); return null; });
        setLeaveError(""); setLeaveBusy(false);
        setCsrf(""); bypass.current = true; setLogged(false);
        navigate("/login?next=" + encodeURIComponent(safeNext(location.pathname + location.search + location.hash)), { replace: true });
      } catch (e) { setConnectionError("会话已过期，草稿尚未保存到本机，请保留此页面并重试：" + String(e)); }
      finally { expired.current = false; bypass.current = false; }
    };
    addEventListener("mw-session-expired", expire);
    return () => removeEventListener("mw-session-expired", expire);
  }, [logged, navigate]);
  useEffect(() => {
    if (!logged) return;
    let active = true;
    const refresh = () => api<{count:number}>("/signals/pending-count").then(result => { if (active) setPending(result.count); }).catch(() => {});
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [logged]);
  useEffect(() => { document.title = pageName(appLocation.pathname); }, [appLocation.pathname]);
  async function logout() {
    if (!await confirmLeave()) return;
    await api("/logout", {}); setCsrf(""); bypass.current = true; setLogged(false);
    navigate("/login", { replace: true }); bypass.current = false;
  }
  const next = safeNext(new URLSearchParams(appLocation.search).get("next"));
  let content;
  if (!ready) content = <div className="loading" role="status">正在连接守望…</div>;
  else if (appLocation.pathname === "/login") content = logged ? <Navigate replace to={next} /> : <Login next={next} connectionError={connectionError} retry={checkSession} login={async password => { const r = await api("/login", { password }); setCsrf(r.csrf); setLogged(true); navigate(next, { replace: true }); }} />;
  else if (connectionError && !logged) content = <div className="loading" role="alert">连接出现问题：{connectionError}<button onClick={checkSession}>重新连接</button></div>;
  else if (!logged) content = <Navigate replace to={"/login?next=" + encodeURIComponent(safeNext(appLocation.pathname + appLocation.search + appLocation.hash))} />;
  else if (appLocation.pathname === "/") content = <Navigate replace to={defaultChart} />;
  else if (appLocation.pathname === "/chart-data-center") content = <DataCenterWindow />;
  else if (safeNext(appLocation.pathname + appLocation.search + appLocation.hash).startsWith("/market-data")) content = <Navigate replace to={`${defaultChart}?data_center=${encodeURIComponent(centerLocation(appLocation.pathname + appLocation.search + appLocation.hash))}`} />;
  else if (appLocation.pathname === "/settings") content = <Navigate replace to="/settings/notifications" />;
  else content = <Suspense fallback={<div className="loading">正在加载…</div>}><Routes>
    <Route path="/advanced-charts/:workspaceId?" element={<AdvancedWorkspacePage />} />
    <Route path="/chart-workspaces/:id?" element={<ChartWorkspacePage />} />
    <Route path="*" element={<Shell logout={logout} />} />
  </Routes></Suspense>;
  return <AppContext.Provider value={{ registerGuard, confirmLeave, logout, theme, setTheme, pending }}>
    {content}
    {logged && connectionError && <div className="advanced-loading-notice" role="alert">{connectionError}<button onClick={() => { setConnectionError(""); dispatchEvent(new Event("mw-session-expired")); }}>重新登录并保留草稿</button></div>}
    {leave && <dialog ref={dialog} className="leave-dialog" data-app-theme={theme} aria-labelledby="leave-title" onCancel={e => { e.preventDefault(); if (!leaveBusy) finishLeave(false); }}>
      <h2 id="leave-title">有未保存的更改</h2><p>保存后继续，或放弃本次更改。取消可留在当前页面。</p>
      {leaveError && <p role="alert" className="error">{leaveError}</p>}<div className="leave-actions">
      <button disabled={leaveBusy} onClick={async () => { setLeaveBusy(true); setLeaveError(""); try { await leave.guard.save(); finishLeave(true); } catch (e) { setLeaveError(String(e)); } finally { setLeaveBusy(false); } }}>{leaveBusy ? "保存中…" : "保存后继续"}</button>
      <button disabled={leaveBusy} onClick={() => { leave.guard.discard(); finishLeave(true); }}>放弃更改</button><button autoFocus disabled={leaveBusy} onClick={() => finishLeave(false)}>取消</button></div>
    </dialog>}
  </AppContext.Provider>;
}

function AppHeader({ logout, sound, toggleSound }: { logout: () => void; sound: boolean; toggleSound: () => void }) {
  const { theme, setTheme, pending } = useApp(), location = useLocation();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("a")?.focus();
    const close = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); button.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && menu.current?.contains(document.activeElement)) {
        e.preventDefault(); const items = [...menu.current.querySelectorAll<HTMLElement>("a,button")];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", keys); };
  }, [open]);
  return <header className="app-header"><button ref={button} type="button" aria-label="应用菜单" aria-expanded={open} aria-controls="app-menu" onClick={() => setOpen(!open)}><Menu size={20} aria-hidden="true" /></button><Waves size={23} aria-hidden="true" /><strong>{pageName(location.pathname)}</strong><NavLink to={chartReturn()}>返回图表</NavLink><button onClick={toggleSound} aria-pressed={sound}>{sound ? "网页声音已开" : "开启网页声音"}</button><button aria-label={theme === "dark" ? "切换浅色主题" : "切换暗色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
    {open && <nav id="app-menu" className="app-menu" ref={menu} aria-label="应用导航" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node) && e.relatedTarget !== button.current) setOpen(false); }}><NavLink to={chartReturn()}>图表</NavLink><NavLink to="/signals">通知 {pending > 0 && <span aria-label={`${pending} 条待确认通知`}>{pending}</span>}</NavLink><NavLink to="/replay">历史演练</NavLink><NavLink to="/settings">设置</NavLink><small>兼容功能</small><NavLink to="/legacy/monitoring">旧版监控</NavLink><hr /><button onClick={logout}>退出登录</button></nav>}
  </header>;
}

function playAlertTone(context: AudioContext) {
  const osc = context.createOscillator(), gain = context.createGain();
  osc.connect(gain);
  gain.connect(context.destination);
  gain.gain.value = 0.12;
  osc.frequency.value = 660;
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  osc.start();
  osc.stop(context.currentTime + 0.5);
}

function Shell({ logout }: { logout: () => void }) {
  const [instruments, setInstruments] = useState<Instrument[]>([]),
    [watches, setWatches] = useState<Watch[]>([]),
    [signals, setSignals] = useState<Signal[]>([]),
    [error, setError] = useState("");
  const [health, setHealth] = useState<any>({}),
    [sound, setSound] = useState(localStorage.getItem("mw.web-sound") === "on");
  const { theme } = useApp();
  const audio = useRef<AudioContext | null>(null),
    known = useRef<Set<string> | null>(null);
  const refreshRunning = useRef(false);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshRunning.current) { refreshAgain.current = true; return; }
    refreshRunning.current = true;
    try {
      const [i, w, s, h] = await Promise.all([
        api("/instruments"),
        api("/watches"),
        api("/signals"),
        api("/health"),
      ]);
      setInstruments(i);
      setWatches(w);
      setSignals(s);
      setHealth(h);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      refreshRunning.current = false;
      if (refreshAgain.current) { refreshAgain.current = false; void refresh(); }
    }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    const events = new EventSource("/api/events");
    events.onmessage = () => refresh();
    return () => {
      clearInterval(timer);
      events.close();
    };
  }, [refresh]);
  useEffect(() => {
    const ids = new Set(signals.map((s) => s.id));
    if (
      sound &&
      known.current &&
      signals.some((s) => !known.current!.has(s.id) &&
        (!s.evidence?.chart_alert || s.evidence.config.notify_web)) &&
      audio.current
    ) {
      playAlertTone(audio.current);
    }
    known.current = ids;
  }, [signals, sound]);
  const location = useLocation();
  useEffect(() => {
    document
      .querySelector<HTMLElement>("#main-content")
      ?.focus({ preventScroll: true });
  }, [location.pathname]);
  return (
    <div className="single-app" data-app-theme={theme}>
      <a className="skip" href="#main-content">
        跳至主要内容
      </a>
      <div className="main-shell">
        <AppHeader logout={logout} sound={sound} toggleSound={async () => {
          if (!sound) { audio.current ??= new AudioContext(); await audio.current.resume(); }
          setSound(!sound); localStorage.setItem("mw.web-sound", !sound ? "on" : "off");
        }} />
        <main id="main-content" tabIndex={-1}>
          {matchMedia("(pointer:coarse)").matches && <p className="muted" role="note">专业图表在手机上只读看盘；编辑功能请使用桌面浏览器。</p>}
          {error && (
            <div className="error" role="alert">
              连接出现问题：{error}
              <button onClick={refresh}>重试</button>
            </div>
          )}
          <Routes>
            <Route
              path="/legacy/monitoring"
              element={
                <Dashboard
                  instruments={instruments}
                  watches={watches}
                  signals={signals}
                  refresh={refresh}
                />
              }
            />
            <Route
              path="/signals"
              element={<Signals signals={signals} refresh={refresh} />}
            />
            <Route
              path="/replay/:runId?"
              element={<ReplayPage instruments={instruments} />}
            />
            <Route
              path="/settings/:section"
              element={<SettingsPage health={health} instruments={instruments} previewSound={async () => {
                audio.current ??= new AudioContext();
                await audio.current.resume();
                if (audio.current.state !== "running") throw new Error("浏览器未允许播放声音，请检查站点声音权限。");
                playAlertTone(audio.current);
              }} />}
            />
            <Route
              path="*"
              element={
                <div className="empty">
                  页面不存在。<NavLink to={chartReturn()}>返回图表</NavLink>
                </div>
              }
            />
          </Routes>
        </main>
        <footer>
          守望 MARKET WATCH <span>你设定规则，守望等待信号。</span>
        </footer>
      </div>
    </div>
  );
}

function Dashboard({
  instruments,
  watches,
  signals,
  refresh,
}: {
  instruments: Instrument[];
  watches: Watch[];
  signals: Signal[];
  refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState("XAUUSD"),
    [timeframe, setTimeframe] = useState("H4"),
    [bars, setBars] = useState<Bar[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const watchTrigger = useRef<HTMLButtonElement | null>(null);
  function openWatch(event: React.MouseEvent<HTMLButtonElement>) {
    watchTrigger.current = event.currentTarget;
    setOpen(true);
  }
  function closeWatch() {
    setOpen(false);
  }
  useEffect(() => {
    if (open || !watchTrigger.current) return;
    // Restore only after React removes the modal and runs its close cleanup.
    const frame = requestAnimationFrame(() => {
      const trigger = watchTrigger.current;
      if (trigger?.isConnected) trigger.focus({preventScroll:true});
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const [range,setRange]=useState<any>(null);
  const inst = instruments.find((i) => i.id === selected);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load=()=>Promise.all([api<Bar[]>(`/candles?instrument=${selected}&timeframe=${timeframe}`),api(`/session-range?instrument=${selected}`)])
      .then(([b,r]) => {
        if (!cancelled) {
          setBars(b);
          setRange(r);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    load();
    const timer=setInterval(load,10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, timeframe]);
  async function cancel(id: string) {
    try {
      await api(`/watches/${id}/cancel`, {});
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MARKET OVERVIEW</span>
          <h1>让机会，主动找到你。</h1>
          <p>关注市场结构，设置条件，然后把时间留给生活。</p>
        </div>
        <button className="primary" onClick={openWatch}>
          <Plus size={18} />
          新建预警
        </button>
      </div>
      <div className="market-grid">
        {instruments.map((i) => (
          <button
            key={i.id}
            className={`market-card ${selected === i.id ? "selected" : ""}`}
            onClick={() => setSelected(i.id)}
            aria-pressed={selected === i.id}
          >
            <div className="card-top">
              <span aria-hidden="true" className={`instrument-icon ${instrumentIcon(i).className}`}>
                {instrumentIcon(i).text}
              </span>
              <div>
                <strong>{instrumentName(i)}</strong>
                <span>{i.label}</span>
                <span className="market-identity">{instrumentIdentity(i)}</span>
              </div>
              <ChevronRight size={16} />
            </div>
            <div className="quote">
              {i.price
                ? Number(i.price).toLocaleString("en-US", {
                    minimumFractionDigits: i.precision,
                    maximumFractionDigits: i.precision,
                  })
                : "—"}
            </div>
            <div className="card-bottom">
              <span
                className={`dot ${i.quality === "receiving" ? "ok" : ""}`}
              />
              <span>
                {i.price_at
                  ? `${i.quality === "stale" ? "数据滞后" : i.quality === "closed" ? "已休市" : "M1 收盘"} · ${new Date(i.price_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                  : "等待真实行情"}
              </span>
              <span>{i.calendar === "ny17" ? "NY 17:00" : "UTC 00:00"}</span>
            </div>
          </button>
        ))}
      </div>
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div>
            <h2>
              {inst ? instrumentName(inst) : selected}
              <span className="muted">{inst?.label}</span>
            </h2>
            <p>
              {inst ? instrumentIdentity(inst) : "正在读取行情身份"} · 图表时间 UTC
              {inst?.calendar_profile?.revision && <> · 日历 {inst.calendar_profile.revision}</>}
            </p>
            {inst && <InstrumentDetails key={inst.id} instrument={inst} />}
            {!!inst?.calendar_profile?.closures?.length && <details><summary>已确认休市区间</summary>{inst.calendar_profile.closures.map(c => <p key={c.start}>{date(Date.parse(c.start))} — {date(Date.parse(c.end))}（本地时间） · {c.reason} · <a href={c.source} target="_blank" rel="noreferrer">来源</a></p>)}</details>}
          </div>
          <div className="segmented">
            {frames
              .filter((x) => x !== "M1")
              .map((t) => (
                <button
                  key={t}
                  aria-pressed={t === timeframe}
                  className={t === timeframe ? "active" : ""}
                  onClick={() => setTimeframe(t)}
                >
                  {t}
                </button>
              ))}
          </div>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {inst?.error && (
          <div className="data-warning">
            <CircleHelp size={16} />
            行情连接异常，暂不将已有价格视为实时价格。
          </div>
        )}
        {loading ? (
          <div className="loading chart-loading">正在读取行情…</div>
        ) : (
          <Chart
            key={`${selected}-${timeframe}`}
            bars={bars}
            precision={inst?.precision}
            markers={signals.filter(s=>s.instrument_id===selected)}
            levels={range?.complete?[{price:+range.high,title:'前日高'},{price:+range.low,title:'前日低'}]:[]}
          />
        )}
        {range&&!range.complete&&<p className="range-note">前一交易日数据尚未完整，暂不显示参考高低点。</p>}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              我的监控{" "}
              <span className="pill">
                {watches.filter((w) => w.status === "active").length} 条运行中
              </span>
            </h2>
            <p>满足条件后仅触发一次，提醒持续等待你的确认。</p>
          </div>
          <Target size={21} />
        </div>
        {watches.length ? (
          <div className="watch-list">
            {watches.map((w) => (
              <article className="watch-row" key={w.id}>
                <div
                  className={`watch-icon ${w.status === "active" ? "active" : ""}`}
                >
                  <Target size={18} />
                </div>
                <div className="watch-name">
                  <strong>{w.name}</strong>
                  <span>
                    {w.market_identity ? `${w.market_identity.symbol} · 组合 · ${w.market_identity.calendar === "ny17" ? "NY17" : "UTC 00:00"}` : (()=>{const source = instruments.find(i=>i.id===w.instrument_id);return source ? `${instrumentName(source)} · ${instrumentIdentity(source)}` : w.instrument_id;})()} · {w.rule.timeframe} ·{" "}
                    {names[w.rule.kind]}
                  </span>
                  {w.market_identity && <small>固定修订 {w.market_identity.composite_revision_id.slice(0, 8)} · {w.market_identity.seam_policy === "accept_raw" ? "接受原价接缝依赖" : "完整同源依赖"} · {w.health === "ready" ? "可判断" : "等待依赖或恢复"}</small>}
                  {w.status === "active" && w.paused_reason && (
                    <small className="warning">{w.paused_reason}</small>
                  )}
                </div>
                <span className={`status ${w.status}`}>
                  {w.status === "active" && w.paused_reason ? "数据暂停" : statusNames[w.status]}
                </span>
                {w.status === "active" && (
                  <button className="text-button" onClick={() => cancel(w.id)}>
                    取消监控
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty watch-empty">
            <Target size={28} />
            <h3>你的下一次机会，从一条预警开始</h3>
            <p>发现回落或突破机会后，开启监控，让守望替你盯盘。</p>
            <button className="secondary" onClick={openWatch}>
              <Plus size={16} />
              创建第一条预警
            </button>
          </div>
        )}
      </section>
      {open && (
        <WatchDialog
          instrument={selected}
          instrumentInfo={inst}
          initialTimeframe={timeframe}
          liveInput
          onClose={closeWatch}
          onSave={async (data) => {
            await api("/watches", data);
            await refresh();
            closeWatch();
          }}
        />
      )}
    </>
  );
}

function WatchDialog({
  instrument,
  onClose,
  onSave,
  timeframe,
  liveInput = false,
  instrumentInfo,
  initialTimeframe,
}: {
  instrument: string;
  onClose: () => void;
  onSave: (data: any) => Promise<void>;
  timeframe?: string;
  liveInput?: boolean;
  instrumentInfo?: Instrument;
  initialTimeframe?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [inputKind, setInputKind] = useState(liveInput ? "composite" : "legacy");
  const [series, setSeries] = useState<QualifiedSeries | null>(null);
  const [seamPolicy, setSeamPolicy] = useState("reject");
  const selectedInput = inputKind === "composite" ? series?.id ?? "" : instrument;
  const [kind, setKind] = useState("pullback"),
    [direction, setDirection] = useState("both"),
    [frame, setFrame] = useState(timeframe || initialTimeframe || "H4"),
    [count, setCount] = useState(2),
    [fast, setFast] = useState(10),
    [slow, setSlow] = useState(20),
    [level, setLevel] = useState(""),
    [name, setName] = useState(""),
    [history, setHistory] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        instrument_id: selectedInput,
        ...(liveInput ? {series_kind: inputKind, ...(inputKind === "composite" ? {seam_policy: seamPolicy} : {})} : {}),
        name: name || `${series && inputKind === "composite" ? series.symbol : instrumentInfo ? instrumentName(instrumentInfo) : instrument} · ${names[kind]}`,
        kind,
        timeframe: frame,
        direction,
        consecutive: count,
        level: kind === "price" ? level : null,
        use_history: history,
        ...(kind === "indicator" ? {indicator: "sma_cross", indicator_version: "1", indicator_params: {fast, slow}} : {}),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog className="watch-dialog" ref={dialog} aria-labelledby="watch-dialog-title" onCancel={event=>{event.preventDefault();onClose();}}>
      <form onSubmit={save}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">NEW WATCH</span>
            <h2 id="watch-dialog-title">设置一条预警</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {liveInput && instrumentInfo && <p className="watch-context">当前看盘：{instrumentName(instrumentInfo)} · {instrumentIdentity(instrumentInfo)} · {initialTimeframe}。预警默认使用独立组合行情，请明确选择；同名品种不会自动视为相同价格身份。需要当前行情时，选择“兼容旧行情与旧绑定”。</p>}
        {liveInput && <label>行情输入<select value={inputKind} onChange={e => setInputKind(e.target.value)}>
          <option value="composite">组合行情（历史基线 + OANDA 接续）</option>
          <option value="legacy">兼容旧行情与旧绑定</option>
        </select></label>}
        {inputKind === "composite" ? <>
          <SeriesPicker kind="composite" selected={series} onSelect={setSeries} />
          <label>接缝依赖政策<select value={seamPolicy} onChange={e => setSeamPolicy(e.target.value)}>
            <option value="reject">使用完整同源窗口建立新准备状态</option>
            <option value="accept_raw">接受原价接缝对历史指标及跨源日线的影响</option>
          </select></label>
          <p>提交时固定历史基线、组合修订与切日规则。后台完成完整依赖检查后才开始判断；后续图表切换修订不改变这条策略。</p>
          <p>接缝两侧不判断穿越；断线、修订及恢复期间不补发过期信号。实时触价使用抽样 Bid，可能漏掉短暂触价。</p>
        </> : <div className="instrument-tag">
          <div>{instrumentInfo ? instrumentName(instrumentInfo) : instrument}
            {instrumentInfo && <small>{instrumentIdentity(instrumentInfo)}</small>}
          </div><span>一次性监控 · 触发后关闭</span>
        </div>}
        <label>
          预警名称
          <input
            value={name}
            maxLength={100}
            placeholder={`${series && inputKind === "composite" ? series.symbol : instrumentInfo ? instrumentName(instrumentInfo) : instrument} · ${names[kind]}`}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          策略
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (!timeframe && !initialTimeframe)
                setFrame(e.target.value === "pullback" ? "H4" : "M5");
            }}
          >
            <option value="pullback">回落 / 反弹结束</option>
            <option value="previous_day">前日高低点突破</option>
            <option value="price">价格穿越</option>
            <option value="indicator">双均线交叉（SMA）</option>
          </select>
        </label>
        <div className="form-grid">
          <label>
            确认周期
            <select
              value={frame}
              disabled={!!timeframe}
              onChange={(e) => setFrame(e.target.value)}
            >
              {(kind==='price'&&!timeframe?['tick',...frames]:frames).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            方向
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="both">两个方向</option>
              <option value="buy">向上 / 买入</option>
              <option value="sell">向下 / 卖出</option>
            </select>
          </label>
        </div>
        {kind === "pullback" && (
          <label>
            连续 K 线根数
            <input
              type="number"
              min="2"
              max="100"
              value={count}
              onChange={(e) => setCount(+e.target.value)}
              required
            />
          </label>
        )}
        {kind === "indicator" && (
          <div className="form-grid">
            <label>快均线周期<input type="number" min="2" max={slow - 1} value={fast} onChange={e => setFast(+e.target.value)} required /></label>
            <label>慢均线周期<input type="number" min={fast + 1} max="500" value={slow} onChange={e => setSlow(+e.target.value)} required /></label>
          </div>
        )}
        {kind === "price" && (
          <label>
            目标价格
            <input
              type="number"
              min="0.00000001"
              step="any"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              required
            />
          </label>
        )}
        <div className="rule-preview">
          <strong>触发规则</strong>
          <p>
            {kind === "pullback"
              ? `连续 ${count} 根阴线且最低价下降后，等待第一根收盘高于前一根最高价；卖出方向对称。`
              : kind === "previous_day"
                ? "收盘价从前日区间内穿越高点或低点。跨日自动更新参考区间。"
                : kind === "indicator" ? `按已收盘 K 线计算 SMA(${fast}) 和 SMA(${slow})，快线上穿慢线为买入信号，下穿为卖出信号。至少需要 ${slow + 1} 根连续完整 K 线才能判断交叉；历史不足时继续积累，不补发开启前的信号。`
                : frame==='tick'?'以轮询收到的报价穿越目标价格为准；外汇/黄金使用 Bid，比特币使用成交价。两次查询之间的短暂触价可能漏报，断线期间无法确定首次穿越时刻。':"以所选周期收盘价穿越目标价格为准。"}
          </p>
          <small>只通知开启之后发生的新信号，两个方向首次触发即结束。</small>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={history}
            onChange={(e) => setHistory(e.target.checked)}
          />
          使用开启前的历史建立准备状态
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !selectedInput}>
            {busy ? "正在开启…" : "开启监控"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Signals({
  signals,
  refresh,
}: {
  signals: Signal[];
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const location = useLocation(), target = new URLSearchParams(location.search).get("signal");
  const [located, setLocated] = useState<Signal | null>(null), [locating, setLocating] = useState(false);
  const focusedTarget = useRef<string | null>(null);
  useEffect(() => { setLocated(null); focusedTarget.current = null; }, [target]);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController(); setLocating(true);
    api<Signal[]>("/signals?signal=" + encodeURIComponent(target), undefined, controller.signal).then(rows => {
      if (!controller.signal.aborted) { setLocated(rows[0] || null); setError(rows.length ? "" : "该通知不存在或已不可用，仍可查看其他通知。"); }
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setLocating(false); });
    return () => controller.abort();
  }, [target, signals]);
  useEffect(() => { if (located?.id === target && focusedTarget.current !== target) { document.getElementById("signal-" + located.id)?.focus({ preventScroll: false }); focusedTarget.current = target; } }, [located?.id, target]);
  const displayed = located && !signals.some(s => s.id === located.id) ? [located, ...signals] : signals;
  async function ack(id: string) {
    try {
      await api(`/notifications/${id}/ack`, {});
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SIGNAL JOURNAL</span>
          <h1>通知</h1>
          <p>核对触发价格与时间，确认你已经看到这次机会。</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        {locating && <p role="status">正在定位通知…</p>}
        {displayed.length ? (
          displayed.map((s) => (
            <article className="signal-card" key={s.id} id={"signal-" + s.id} tabIndex={-1} data-target={s.id === target}>
              <div className="signal-top">
                <span className={`status ${s.ack_at ? "cancelled" : "active"}`}>
                  {s.ack_at ? "已确认" : "待确认"}
                </span>
                <time>{date(s.occurred_at)}</time>
              </div>
              <h2>
                {s.instrument_id} · {s.reason}
              </h2>
              <div className="signal-prices">
                <span>
                  {s.evidence?.chart_alert && s.evidence.unit !== "price" ? "触发指标值" : "触发价格"}
                  <strong>{Number(s.evidence?.chart_alert ? s.evidence.left : s.price)}</strong>
                </span>
                <span>
                  比较阈值<strong>{Number(s.threshold)}</strong>
                </span>
                <span>
                  通知状态
                  <strong>
                    {s.notification_status === "server_accepted"
                      ? "推送服务已接受"
                      : s.notification_status === "acknowledged"
                        ? "已确认"
                        : s.notification_status === "delivery_error"
                          ? "投递失败，等待重试"
                          : s.notification_status === "web_only"
                            ? "仅网页通知"
                            : s.notification_status === "late_suppressed"
                              ? "迟到事件，仅记录"
                              : "等待投递"}
                  </strong>
                </span>
              </div>
              {s.evidence?.chart_alert && (
                <details>
                  <summary>查看告警事件证据</summary>
                  <p>来源 {s.evidence.market_identity.source} · 周期 {s.evidence.config.timeframe} · 规则版本 {s.evidence.rule_version} · 第 {s.evidence.ordinal} 次</p>
                  <p>市场价格 {Number(s.price)} · 检测时间 {date(s.evidence.detected_at)}{s.evidence.late ? " · 迟到事件" : ""}</p>
                  <pre>{JSON.stringify(s.evidence.observation, null, 2)}</pre>
                </details>
              )}
              {s.evidence?.trigger_bar && (
                <details>
                  <summary>查看触发时的 K 线记录</summary>
                  <p>规则版本 {s.evidence.rule_version} · 收盘时间 {date(Date.parse(s.evidence.trigger_bar.end))}</p>
                  {s.evidence.indicator_current && <p>指标 {s.evidence.indicator}（版本 {s.evidence.indicator_version}）：快线 {s.evidence.indicator_current.value} / 慢线 {s.evidence.indicator_current.reference}；参数 {s.evidence.indicator_params?.fast} / {s.evidence.indicator_params?.slow}</p>}
                  <p>触发 K 线：开 {s.evidence.trigger_bar.open} / 高 {s.evidence.trigger_bar.high} / 低 {s.evidence.trigger_bar.low} / 收 {s.evidence.trigger_bar.close}</p>
                  {s.evidence.previous_bar && <p>前一根：高 {s.evidence.previous_bar.high} / 低 {s.evidence.previous_bar.low} / 收 {s.evidence.previous_bar.close}</p>}
                  {s.evidence.previous_day && <p>前日：高 {s.evidence.previous_day.high} / 低 {s.evidence.previous_day.low}</p>}
                  <p>以上为触发时保存的数据；行情后续修正可能使图表不同。</p>
                </details>
              )}
              <div className="signal-bottom">
                <small>手机接收：{s.device_delivery === "received" ? "客户端已接收" : "未知"} · 信号 {s.id.slice(0, 8)}</small>
                {s.retry_available && <button className="secondary" onClick={async()=>{
                  try{await api(`/notifications/${s.notification_id}/retry`,{});await refresh()}
                  catch(e){setError(String(e))}
                }}>修复凭据后重试</button>}
                {!s.ack_at && (
                  <button
                    className="primary"
                    onClick={() => ack(s.notification_id)}
                  >
                    <Check size={16} />
                    确认已看到
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <div className="empty">
            <Bell size={32} />
            <h3>还没有触发的信号</h3>
            <p>策略满足条件后，这里会保存价格、时间和触发原因。</p>
            <NavLink className="secondary" to="/">
              前往创建预警
            </NavLink>
          </div>
        )}
      </section>
    </>
  );
}

function ReplayPage({ instruments }: { instruments: Instrument[] }) {
  const location=useLocation(), navigate=useNavigate(), {runId}=useParams();
  const [inputMode,setInputMode]=useState<'history'|'legacy'>('history');
  const [selectedHistory,setSelectedHistory]=useState<QualifiedSeries|null>(null);
  const [historyVersions,setHistoryVersions]=useState<any[]>([]);
  const [historyDatasets,setHistoryDatasets]=useState<any[]>([]);
  const [datasetVersion,setDatasetVersion]=useState(new URLSearchParams(location.search).get('dataset_version') ?? '');
  const [historyPeriods,setHistoryPeriods]=useState<any[]>([]);
  const [periodsLoading,setPeriodsLoading]=useState(false);
  const [periodsError,setPeriodsError]=useState('');
  const [preparingPeriods,setPreparingPeriods]=useState(false);
  const [periodRefresh,setPeriodRefresh]=useState(0);
  useEffect(()=>{
    setHistoryPeriods([]);setPeriodsError('');setPeriodsLoading(!!datasetVersion);
    if(!datasetVersion)return;
    let active=true,loading=false;
    const load=async()=>{if(loading)return;loading=true;try{
      const rows=await api(`/market-data/versions/${datasetVersion}/artifacts`);
      if(active){setHistoryPeriods(rows);setPeriodsError('')}
    }catch(e){if(active)setPeriodsError(String(e))}finally{loading=false;if(active)setPeriodsLoading(false)}};
    load();const timer=setInterval(load,10000);
    return()=>{active=false;clearInterval(timer)};
  },[datasetVersion,periodRefresh]);
  useEffect(()=>{let active=true;
    const wanted=new URLSearchParams(location.search).get('dataset_version');
    Promise.all([wanted?api('/market-data/versions/'+encodeURIComponent(wanted)):Promise.resolve(null),api('/market-data/datasets')]).then(([version,d])=>{
    if(!active)return;setHistoryDatasets(d);
    if(wanted){const source=d.find((row:any)=>row.id===version?.dataset_id);if(source&&version.status==='published'&&version.payload_available!==false){
      setInputMode('history');setInstrument(source.instrument_id);setDatasetVersion(wanted);setStart(inputTime(version.start));setEnd(inputTime(version.end));setFrame('M1');
      setSelectedHistory({id:version.id,ticker:'MWH:'+version.id,symbol:source.logical_symbol,series_kind:'history',dataset_id:source.id,historical_source:source.identity.source,basis:source.identity.basis,calendar:source.aggregation_calendar,description:'固定发布版本'});
    }else{setDatasetVersion('');setError('指定历史版本尚未发布或已回收，请查看数据中心')}}
  }).catch(e=>{if(active)setError(String(e))});return()=>{active=false}},[location.search]);
  useEffect(()=>{
    setHistoryVersions([]);
    if(!selectedHistory)return;
    const controller=new AbortController();
    Promise.all([
      api<any[]>('/market-data/versions?dataset_id='+selectedHistory.dataset_id,undefined,controller.signal),
      api('/market-data/versions/'+selectedHistory.id,undefined,controller.signal),
    ]).then(([rows,selected])=>{if(!controller.signal.aborted){
      const versions=rows.some(row=>row.id===selected.id)?rows:[selected,...rows];
      setHistoryVersions(versions.filter(row=>row.dataset_id===selectedHistory.dataset_id&&row.status==='published'&&row.payload_available!==false));
    }})
      .catch(e=>{if(!controller.signal.aborted)setError(String(e))});
    return()=>controller.abort();
  },[selectedHistory?.dataset_id]);
  const generation=useRef(0);
  const [savedRuns,setSavedRuns]=useState<any[]>([]);
  const [setupOpen,setSetupOpen]=useState(true);
  useEffect(()=>{api('/replays').then(setSavedRuns).catch(()=>{})},[]);
  async function resumeReplay(id:string){const g=++generation.current;setPlaying(false);setError('');try{const r=await api(`/replays/${id}`);if(g===generation.current){setRun(r);setSetupOpen(false)}}catch(e){if(g===generation.current)setError(String(e))}}

  useEffect(()=>{ if(runId) void resumeReplay(runId); else {setRun(null);setSetupOpen(true);} },[runId]);

  const [jobs,setJobs]=useState<any[]>([]);
  const [jobSummary,setJobSummary]=useState<any>(null);
  useEffect(()=>{let active=true;let loading=false;const load=async()=>{if(loading)return;loading=true;try{const [j,s]=await Promise.all([api('/imports'),api('/imports-summary')]);if(active){setJobs(j);setJobSummary(s)}}catch{}finally{loading=false}};load();const timer=setInterval(load,10000);return()=>{active=false;clearInterval(timer)}},[]);
  const [instrument, setInstrument] = useState("XAUUSD"),
    [frame, setFrame] = useState("H4"),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [run, setRun] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [playing, setPlaying] = useState(false),
    [open, setOpen] = useState(false),
    [seek, setSeek] = useState("");
  const locked = useRef(false);
  const playbackButton = useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(run?.id)playbackButton.current?.focus()},[run?.id]);
  const fixedDataset=inputMode==='history'?historyDatasets.find(d=>d.id===selectedHistory?.dataset_id):undefined;
  function selectHistory(row:QualifiedSeries|null){
    setSelectedHistory(row);setDatasetVersion('');setStart('');setEnd('');setError('');
    setInstrument(historyDatasets.find(d=>d.id===row?.dataset_id)?.instrument_id ?? '');
  }
  function replayLabel(id:string){
    const source=historyDatasets.find(d=>d.instrument_id===id);
    return source?`${source.logical_symbol} · ${source.identity.source==='oanda'?'OANDA':source.identity.source==='dukascopy'?'Dukascopy':source.identity.source} · ${source.aggregation_calendar==='ny17'?'NY17':'UTC 00:00'}`:id;
  }
  const requiredPeriods=Array.from(new Set([frame,'D1']));
  const missingPeriods=requiredPeriods.filter(f=>!historyPeriods.some(p=>p.version_id===datasetVersion&&p.timeframe===f&&p.status==='published'));
  const fixedReady=!!datasetVersion&&historyVersions.some(v=>v.id===datasetVersion&&v.dataset_id===selectedHistory?.dataset_id)&&!periodsLoading&&!periodsError&&!missingPeriods.length;
  async function prepareReplayPeriods(){
    if(!datasetVersion||preparingPeriods)return;
    setPreparingPeriods(true);setPeriodsError('');
    try{await api(`/market-data/versions/${datasetVersion}/artifacts`,{timeframes:requiredPeriods});setPeriodRefresh(n=>n+1)}
    catch(e){setPeriodsError(String(e))}finally{setPreparingPeriods(false)}
  }
  function inputTime(value:number) {
    return new Date(value-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16);
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if(inputMode==='history'&&(!fixedDataset||!fixedReady)){setError('请选择已发布的自建行情、固定版本和可用周期');return}
    const g=++generation.current;
    setBusy(true);
    setError("");
    setPlaying(false);
    try {
      const result=await api("/replays", {
          instrument_id: inputMode==='history'?fixedDataset.instrument_id:instrument,
          dataset_version: datasetVersion || undefined,
          timeframe: frame,
          start: new Date(start).getTime(),
          end: new Date(end).getTime(),
        });
      if(g===generation.current){setRun(result);setSetupOpen(false);navigate("/replay/"+result.id)}
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const step = useCallback(
    async (count = 1) => {
      if (!run || locked.current) return;
      locked.current = true;
      const g=generation.current;
      try {
        const r = await api(`/replays/${run.id}/step`, { count });
        if(g!==generation.current)return;
        setRun(r);
        if (r.finished) setPlaying(false);
      } catch (e) {
        setError(String(e));
        setPlaying(false);
      } finally {
        locked.current = false;
      }
    },
    [run?.id],
  );
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => step(), 700);
    return () => clearInterval(timer);
  }, [playing, step]);
  async function jump() {
    const g=++generation.current;
    setPlaying(false);
    try {
      const result=await api(`/replays/${run.id}/seek`, {
          cursor: new Date(seek).getTime(),
        });
      if(g===generation.current)setRun(result);
    } catch (e) {
      setError(String(e));
    }
  }
  async function retryImport(id:string){setError('');try{await api(`/imports/${id}/retry`,{});setJobs(await api('/imports'))}catch(e){setError(String(e))}}
  async function importHistory(){setBusy(true);setError('');try{await api('/imports',{instrument_id:instrument,timeframe:frame,start:new Date(start).getTime(),end:new Date(end).getTime()});setJobs(await api('/imports'))}catch(e){setError(String(e))}finally{setBusy(false)}}
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">REPLAY LAB</span>
          <h1>回到当时，验证你的判断。</h1>
          <p>未来走势默认隐藏。演练只产生模拟信号，不会推送手机。</p>
        </div>
        <span className="pill">模拟环境</span>
      </div>
      {savedRuns.length>0&&<section className="panel"><div className="panel-heading"><h2>继续已有演练</h2></div><div className="replay-controls"><label>已保存的演练<select defaultValue="" onChange={e=>{if(e.target.value)navigate("/replay/"+e.target.value)}}><option value="">选择演练</option>{savedRuns.map(r=><option key={r.id} value={r.id}>{replayLabel(r.instrument_id)} · {r.timeframe} · {date(r.cursor)} · {r.id.slice(0,6)}</option>)}</select></label></div></section>}
      <section className="panel replay-setup">
        <details open={setupOpen} onToggle={e=>setSetupOpen(e.currentTarget.open)}>
          <summary>{run ? "新建演练 · 选择另一段固定历史" : "新建演练"}</summary>
        <form onSubmit={create}>
          <label>行情范围<select value={inputMode} onChange={e=>{
            const mode=e.target.value as 'history'|'legacy';setInputMode(mode);setDatasetVersion('');setStart('');setEnd('');setError('');
            setInstrument(mode==='legacy'?'XAUUSD':historyDatasets.find(d=>d.id===selectedHistory?.dataset_id)?.instrument_id ?? '');
          }}><option value="history">自建行情 · 固定发布版本</option><option value="legacy">旧版历史 · 兼容入口</option></select></label>
          {inputMode==='history'?<SeriesPicker kind="history" selected={selectedHistory} onSelect={selectHistory}/>:<label>
            品种
            <select
              value={instrument}
              onChange={(e) => {setInstrument(e.target.value);setDatasetVersion('')}}
            >
              {instruments.map((i) => (
                <option key={i.id}>{i.id}</option>
              ))}
            </select>
          </label>}
          {fixedDataset&&<label>不可变历史版本<select required value={datasetVersion} onChange={e=>{setDatasetVersion(e.target.value);const version=historyVersions.find(v=>v.id===e.target.value);if(version){setStart(inputTime(version.start));setEnd(inputTime(version.end))}}}><option value="">选择已发布版本</option>{historyVersions.filter(v=>v.dataset_id===fixedDataset.id).map(v=><option key={v.id} value={v.id}>{date(v.start)} — {date(v.end)} · {v.id.slice(0,8)}</option>)}</select></label>}
          <label>
            周期
            <select value={frame} onChange={(e) => setFrame(e.target.value)}>
              {(inputMode==='history'?['M1','M5','M15','M30','H1','H4','D1','W1','MN']:frames).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            开始时间（本地）
            <input
              type="datetime-local"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            结束时间（本地）
            <input
              type="datetime-local"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button className="primary" disabled={busy||inputMode==='history'&&(!fixedDataset||!fixedReady)}>
            {busy ? "正在准备…" : "创建演练"}
          </button>
          {inputMode==='legacy'&&<button type="button" className="secondary" disabled={busy||!start||!end} onClick={importHistory}>补齐所选历史</button>}
        </form>
        {inputMode==='history'&&!selectedHistory&&<p>回测使用自建历史。选择来源和日界后，再明确选择发布版本及区间；请从图表顶部的数据中心维护历史。</p>}
        {inputMode==='legacy'&&<p>保留旧版历史及演练绑定；该入口不替代自建行情的固定版本回测。</p>}
        {fixedDataset&&<div aria-live="polite">
          <p>固定历史 · {fixedDataset.identity.source==='oanda'?'OANDA':fixedDataset.identity.source==='dukascopy'?'Dukascopy':fixedDataset.identity.source} · {fixedDataset.aggregation_calendar==='ny17'?'NY17':'UTC 00:00'}。演练保留所选版本和周期；未观察区间仍可能存在缺口。</p>
          {datasetVersion&&historyVersions.filter(v=>v.id===datasetVersion).map(v=><p key={v.id}>所选固定版本：{date(v.start)} — {date(v.end)} · {v.id.slice(0,8)}</p>)}
          {datasetVersion&&(periodsLoading?<p>正在核对回测周期…</p>:periodsError?<p role="alert">{periodsError}</p>:missingPeriods.length?<p>等待准备：{missingPeriods.join('、')}。D1 用于前日数据。</p>:<p>回测周期与前日数据已发布。</p>)}
          {datasetVersion&&missingPeriods.length>0&&!periodsLoading&&<button type="button" className="secondary" disabled={preparingPeriods} onClick={prepareReplayPeriods}>{preparingPeriods?'正在提交…':'准备回测周期'}</button>}
          <span>请从图表顶部的数据中心查看历史覆盖与维护。</span>
        </div>}
        </details>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {run ? (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  {replayLabel(run.instrument_id)} · {run.timeframe}
                </h2>
                <p>虚拟时间 {date(run.cursor)}</p>
                {run.chart_history_limited && <p>图表只显示最近 {run.chart_bar_limit} 根以内的可见 K 线；策略使用完整开启前历史，导出保留已走过的数据。</p>}
                <a className="text-button" href={`/api/replays/${run.id}/export`}>导出演练记录</a>
              </div>
              <button className="secondary" disabled={!frames.includes(run.timeframe)} onClick={() => setOpen(true)}>
                <Plus size={16} />
                在此刻开启预警
              </button>
            </div>
            {!frames.includes(run.timeframe)&&<p>该周期支持价格回放；现有模拟预警支持 M1、M5、M15、H1、H4、D1。</p>}
            <div className="replay-controls">
              <button
                className="secondary"
                ref={playbackButton}
                disabled={run.finished}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? <Square size={16} /> : <Play size={16} />}{" "}
                {playing ? "暂停" : "播放"}
              </button>
              <button
                className="secondary"
                disabled={playing || run.finished}
                onClick={() => step()}
              >
                <SkipForward size={16} />
                下一根
              </button>
              <button
                className="secondary"
                disabled={playing || run.finished}
                onClick={() => step(10)}
              >
                前进 10 根
              </button>
              <span>{run.finished ? "演练已到结尾" : "按收盘事件推进"}</span>
            </div>
            <Chart
              bars={run.bars}
              markers={run.signals}
              precision={
                instruments.find((i) => i.id === run.instrument_id)?.precision ?? historyDatasets.find(d=>d.instrument_id===run.instrument_id)?.precision
              }
            />
            <div className="seek">
              <label>
                定位到时间（创建新分支，清空模拟监控）
                <input
                  type="datetime-local"
                  value={seek}
                  onChange={(e) => setSeek(e.target.value)}
                />
              </label>
              <button className="secondary" disabled={!seek} onClick={jump}>
                定位
              </button>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>模拟监控与信号</h2>
              <span>{run.signals.length} 次触发</span>
            </div>
            {run.watches.length ? (
              run.watches.map((w: any) => (
                <div className="watch-row" key={w.id}>
                  <Target size={18} />
                  <strong>{w.name}</strong>
                  <span className="status">{statusNames[w.status]}</span>
                </div>
              ))
            ) : (
              <div className="empty">
                在图表当前位置创建预警，观察接下来会发生什么。
              </div>
            )}
            {run.signals.map((s: any, i: number) => (
              <div className="watch-row" key={i}>
                <Check size={18} />
                <span>
                  {date(s.occurred_at)} · {s.reason} · {s.price}
                </span>
              </div>
            ))}
          </section>
        </>
      ) : (
        <section className="panel">
          <div className="empty">
            <Clock3 size={32} />
            <h3>选择一段行情，开始演练</h3>
            <p>使用与实时监控相同的规则，逐根查看信号如何形成。</p>
          </div>
        </section>
      )}
      <ReplayJobs jobs={jobs} summary={jobSummary} retry={retryImport} />
      {open && run && (
        <WatchDialog
          instrument={run.instrument_id}
          timeframe={run.timeframe}
          onClose={() => setOpen(false)}
          onSave={async (data) => {
            setRun(await api(`/replays/${run.id}/watches`, data));
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function SettingsPage({ health, instruments, previewSound }: { health: any; instruments: Instrument[]; previewSound: () => Promise<void> }) {
  const { section } = useParams(), { registerGuard } = useApp();
  const settingsRef = useRef<any>(null), original = useRef("");
  const [audioMessage, setAudioMessage] = useState(""), [audioBusy, setAudioBusy] = useState(false);
  const [config, setConfig] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/settings/notifications")
      .then(value => {
        original.current = JSON.stringify(value);
        let draft; try { draft = JSON.parse(localStorage.getItem("mw.notifications-draft.v1") || "null"); } catch { /* retain usable server settings */ }
        const restored = draft && typeof draft === "object" && typeof draft.priority === "number" ? draft : value;
        settingsRef.current = restored; setConfig(restored);
        if (restored !== value) setMessage("未保存的提醒设置已恢复，请核对后保存。");
      })
      .catch((e) => setMessage(String(e)));
  }, []);
  settingsRef.current = config;
  async function persistSettings() {
    const value = settingsRef.current;
    await api("/settings/notifications", {...value, mode:"ntfy_native"});
    original.current = JSON.stringify(value); localStorage.removeItem("mw.notifications-draft.v1"); setMessage("提醒设置已保存");
  }
  useEffect(() => registerGuard({
    dirty: () => !!settingsRef.current && JSON.stringify(settingsRef.current) !== original.current,
    save: persistSettings,
    discard: () => { const value = original.current ? JSON.parse(original.current) : null; settingsRef.current = value; setConfig(value); localStorage.removeItem("mw.notifications-draft.v1"); },
    preserve: async () => { if(settingsRef.current && JSON.stringify(settingsRef.current) !== original.current) localStorage.setItem("mw.notifications-draft.v1",JSON.stringify(settingsRef.current)); },
  }), [registerGuard]);
  async function sendTest(){
    setBusy(true);setMessage('');
    try{await api('/notification-tests',{});setMessage('推送服务已接受，请检查手机响铃；这不代表手机已收到。')}
    catch(e){setMessage(String(e))}finally{setBusy(false)}
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await persistSettings();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DELIVERY & CONNECTION</span>
          <h1>让重要提醒，真正被听见。</h1>
          <p>查看通知链路和当前手机的后台运行条件。</p>
        </div>
      </div>
      <nav className="settings-tabs" aria-label="设置分组">{[["notifications","通知"],["sound","声音"],["system","系统"],["account","账户"]].map(([key,label])=><NavLink key={key} to={"/settings/"+key}>{label}</NavLink>)}</nav>
      {!["notifications","sound","system","account"].includes(section || "") && <p role="alert">设置分组不存在。<NavLink to="/settings/notifications">返回通知设置</NavLink></p>}
      {section === "account" && <AccountSettings />}
      <div className="settings-grid">
        {section === "notifications" && <section className="panel settings-card">
          <Bell size={24} />
          <h2>手机提醒 · ntfy</h2>
          <dl>
            <dt>服务配置</dt>
            <dd>{health.ntfy_configured ? "已配置" : "尚未配置"}</dd>
            <dt>真实投递</dt>
            <dd>{health.delivery_enabled ? "已开启" : "未开启"}</dd>
            <dt>待投递任务</dt>
            <dd>{health.pending_notifications ?? "—"}</dd>
            <dt>最近测试</dt>
            <dd>{health.last_notification_test ? `${date(health.last_notification_test.at)} · ${{notification_test_requested:'请求已记录，结果待确认',notification_test_accepted:'推送服务已接受',notification_test_failed_or_unknown:'失败或结果未知',notification_test_acknowledged:'手机确认已回传'}[health.last_notification_test.status as string] || '未知'}` : '尚未测试'}</dd>
            <dt>手机送达回执</dt>
            <dd>原版客户端不提供</dd>
          </dl>
          <div className="rule-preview">
            <strong>OPPO 手机使用条件</strong>
            <p>
              开启 ntfy
              即时投递；不要从最近任务划掉应用。划掉后实时通知可能停止，重新打开才补收。
            </p>
          </div>
          <button className="secondary" disabled={busy || !health.ntfy_configured} onClick={sendTest}>发送手机测试通知（会响铃）</button>
          <p className="muted">主动发送一条最高优先级测试，不开启策略自动推送；每分钟最多一次。</p>
          {config && (
            <form onSubmit={save}>
              <p>使用 ntfy 原生应用。铃声与持续响铃行为在手机端设置。</p>
              <label>
                通知优先级
                <select
                  value={config.priority}
                  onChange={(e) =>
                    setConfig({ ...config, priority: +e.target.value })
                  }
                >
                  <option value={3}>普通提醒</option>
                  <option value={4}>高优先级</option>
                  <option value={5}>最高优先级 · 强提醒</option>
                </select>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.quiet_enabled}
                  onChange={(e) =>
                    setConfig({ ...config, quiet_enabled: e.target.checked })
                  }
                />
                启用夜间静音（服务端暂缓发送）
              </label>
              {config.quiet_enabled && (
                <>
                  <div className="form-grid">
                    <label>
                      静音开始
                      <input
                        type="time"
                        required
                        value={config.quiet_start}
                        onChange={(e) =>
                          setConfig({ ...config, quiet_start: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      静音结束
                      <input
                        type="time"
                        required
                        value={config.quiet_end}
                        onChange={(e) =>
                          setConfig({ ...config, quiet_end: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <p>
                    时区：Asia/Shanghai。静音结束后发送未确认提醒；已在手机响起的通知暂不能由本设置停止。
                  </p>
                </>
              )}
              <button className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存提醒设置"}
              </button>
              {message && <p role="status">{message}</p>}
            </form>
          )}
        </section>}
        {section === "sound" && <section className="panel settings-card">
          <h2>网页声音</h2>
          <p>试听会在当前浏览器播放半秒提示音。接收新信号的声音提醒，请在页面顶部开启网页声音。</p>
          <button type="button" className="secondary" disabled={audioBusy} onClick={async () => {
            setAudioBusy(true); setAudioMessage("");
            try { await previewSound(); setAudioMessage("试听已播放；若未听到，请检查设备音量和站点声音权限。"); }
            catch (e) { setAudioMessage(String(e)); }
            finally { setAudioBusy(false); }
          }}>{audioBusy ? "正在播放…" : "试听网页声音"}</button>
          {audioMessage && <p role="status">{audioMessage}</p>}
        </section>}
        {section === "system" && <section className="panel settings-card">
          <Activity size={24} />
          <h2>后台运行状态</h2>
          {health.market_incidents?.map((item:any) => {
            const instrument = instruments.find(row=>row.id===item.instrument);
            return <div key={item.instrument}><p>{instrument ? `${instrumentName(instrument)} · ${instrumentIdentity(instrument)}` : item.instrument}：24 小时内 {item.errors_24h} 次行情异常{item.current_error ? '，当前仍有错误' : ''}{item.last_error_at ? `；最近异常 ${date(item.last_error_at)}` : ''}{item.last_recovered_at ? `；最近恢复 ${date(item.last_recovered_at)}` : ''}</p>{instrument && <InstrumentDetails instrument={instrument} />}</div>;
          })}
          <div className="history-service-status" aria-label="历史服务运行状态">
            {health.history_services?.map((service:any)=><div key={service.id}>
              <h3>{service.label}</h3>
              <p>{({running:"业务循环有新鲜心跳",stale:"心跳过期，请检查对应服务",degraded:"业务循环报告异常",disabled:"未启用",unknown:"尚未收到业务心跳，健康情况未知"} as Record<string,string>)[service.status]}</p>
              <p>最近心跳：{service.heartbeat_at ? date(service.heartbeat_at) : "尚未上报"} · 最近成功轮次：{service.last_success_at ? date(service.last_success_at) : "尚未记录"}</p>
              <p>任务状态：{Object.entries(service.task_counts || {}).map(([state,count])=>`${({published:"已发布",complete:"已完成",ready:"就绪",pending:"等待",running:"处理中",waiting:"等待加载",filling:"加载中",failed:"失败",cancelled:"已取消",expired:"已过期"} as Record<string,string>)[state] || state} ${count}`).join(" · ") || "暂无任务"}{service.task_scope ? ` · ${service.task_scope}` : ""}</p>
              {(service.status==="stale" || service.status==="degraded" || service.status==="unknown") && <p>{service.impact}。检查对应 worker 与任务记录；心跳新鲜仍不保证所选数据已就绪。</p>}
              {service.errors?.length>0 && <p>最近轮次异常：{service.errors.join(" · ")}</p>}
              {!!service.recent_tasks?.length && <details><summary>最近任务进展</summary>{service.recent_tasks.map((task:any)=><p key={task.id}>{task.id.slice(0,8)} · {task.state} · {task.pages !== undefined ? `完成分页 ${task.pages} · 连续未推进 ${task.stalls}` : `${task.end>task.start ? Math.min(100,Math.max(0,Math.round((task.cursor-task.start)/(task.end-task.start)*100))) : 0}%`}{task.updated_at ? ` · 最近变更 ${date(task.updated_at)}` : ""}</p>)}</details>}
            </div>)}
            <p>状态接口可读表示能查询状态；历史就绪仍以具体任务与数据覆盖为准。</p>
          </div>
          <dl>
            <dt>数据库备份</dt><dd>{health.backup?.status === 'recent' ? '最近一次备份成功' : health.backup?.status === 'failed' ? '最近一次备份失败，请检查服务' : health.backup?.status === 'stale' ? '超过 36 小时未成功备份' : '尚无定时备份记录'}</dd>
            <dt>备份最近执行时间</dt><dd>{health.backup?.at ? date(health.backup.at) : '尚未执行'}</dd>
            <dt>行情后台状态</dt><dd>{health.worker_status?.market_heartbeat === "running" ? "运行中" : health.worker_status?.market_heartbeat === "stale" ? "心跳过期，请检查服务" : "尚未收到心跳"}</dd>
            <dt>行情 worker 最近心跳</dt>
            <dd>
              {health.workers?.market_heartbeat
                ? date(health.workers.market_heartbeat)
                : "尚未上报"}
            </dd>
            <dt>兼容旧补数链路</dt><dd>{health.legacy_import?.status === "disabled" ? "未启用" : health.legacy_import?.status === "running" ? "业务心跳新鲜" : health.legacy_import?.status === "stale" ? "兼容链路心跳过期" : "兼容链路健康情况未知"}；不代表现行历史服务状态</dd>
            <dt>兼容补数最近心跳</dt><dd>{health.legacy_import?.heartbeat_at ? date(health.legacy_import.heartbeat_at) : health.workers?.import_heartbeat ? `旧版记录 ${date(health.workers.import_heartbeat)}` : "尚未上报"}</dd>
            <dt>通知后台状态</dt><dd>{health.worker_status?.notify_heartbeat === "running" ? "运行中" : health.worker_status?.notify_heartbeat === "stale" ? "心跳过期，请检查服务" : "尚未收到心跳"}</dd>
            <dt>凭证错误而暂停的投递</dt><dd>{health.blocked_notifications ?? 0}</dd>
            <dt>通知 worker 最近心跳</dt>
            <dd>
              {health.workers?.notify_heartbeat
                ? date(health.workers.notify_heartbeat)
                : "尚未上报"}
            </dd>
          </dl>
          <p className="muted">
            服务器接受消息不代表手机已经收到；点开通知停止声音，也不等于网站已确认。
          </p>

        </section>}
      </div>
    </>
  );
}

function AccountSettings() {
  const [current, setCurrent] = useState(""), [password, setPassword] = useState(""), [repeat, setRepeat] = useState(""), [busy,setBusy]=useState(false), [message,setMessage]=useState("");
  return <section className="panel settings-card"><h2>账户密码</h2><form onSubmit={async e=>{e.preventDefault();setMessage("");if(password!==repeat){setMessage("两次新密码不一致");return;}setBusy(true);try{await api("/account/password",{current_password:current,new_password:password});setCurrent("");setPassword("");setRepeat("");setMessage("密码已修改");}catch(e){setMessage(String(e));}finally{setBusy(false);}}}>
  <label>当前密码<input type="password" autoComplete="current-password" required value={current} onChange={e=>setCurrent(e.target.value)} /></label><label>新密码<input type="password" autoComplete="new-password" required value={password} onChange={e=>setPassword(e.target.value)} /></label><label>再次输入新密码<input type="password" autoComplete="new-password" required value={repeat} onChange={e=>setRepeat(e.target.value)} /></label><button className="primary" disabled={busy}>{busy ? "保存中…" : "修改密码"}</button>{message && <p role="status">{message}</p>}</form></section>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={createBrowserRouter([{ path: "*", element: <App /> }])} />
  </React.StrictMode>,
);
