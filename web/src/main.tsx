import React, { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
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
  setCsrf,
  date,
  type Bar,
  type Instrument,
  type Watch,
  type Signal,
} from "./api";
import "./style.css";
import AdvancedWorkspacePage from "./advanced/AdvancedWorkspace";
import DataCenterWindow from "./market-data/Window";
import { centerLocation } from "./market-data/location";
import SeriesPicker, { type QualifiedSeries } from "./market-data/SeriesPicker";

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
  const appLocation = useLocation();
  const [ready, setReady] = useState(false),
    [logged, setLogged] = useState(false),
    [error, setError] = useState("");
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/session")
      .then((r) => {
        setCsrf(r.csrf);
        setLogged(true);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api("/login", { password });
      setCsrf(r.csrf);
      setLogged(true);
      setPassword("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!ready) return <div className="loading">正在连接守望…</div>;
  if (!logged)
    return (
      <main className="login-page">
        <section className="login-story">
          <div className="brand">
            <Waves />
            <span>
              守望 <small>MARKET WATCH</small>
            </span>
          </div>
          <div>
            <span className="eyebrow">YOUR PERSONAL MARKET OBSERVER</span>
            <h1>
              机会出现时，
              <br />
              不必恰好在屏幕前。
            </h1>
            <p>把判断留给自己，把等待交给守望。</p>
          </div>
          <span className="login-foot">外汇 · 黄金 · 比特币</span>
        </section>
        <section className="login-form">
          <form onSubmit={login}>
            <span className="eyebrow">WELCOME BACK</span>
            <h2>进入你的工作台</h2>
            <p>登录后查看行情、管理预警和复盘信号。</p>
            <label>
              管理员密码
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "正在登录…" : "登录工作台"}
              <ArrowRight size={18} />
            </button>
            <small>
              <ShieldCheck size={14} /> 单人账户 · 私有监控
            </small>
          </form>
        </section>
      </main>
    );
  if (appLocation.pathname === "/chart-data-center") return <DataCenterWindow />;
  if (appLocation.pathname.startsWith("/market-data")) return <Navigate replace to={`/advanced-charts?data_center=${encodeURIComponent(centerLocation(appLocation.pathname + appLocation.search + appLocation.hash))}`} />;
  if (appLocation.pathname === "/advanced-charts")
    return <Suspense fallback={<div className="loading">正在加载专业图表…</div>}><AdvancedWorkspacePage /></Suspense>;
  if (appLocation.pathname.startsWith("/chart-workspaces"))
    return (
      <Suspense fallback={<div className="loading">正在加载图表工作区…</div>}>
        <Routes>
          <Route path="/chart-workspaces/:id?" element={<ChartWorkspacePage />} />
        </Routes>
      </Suspense>
    );
  return (
    <Shell
      logout={async () => {
        await api("/logout", {});
        setLogged(false);
      }}
    />
  );
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
    [sound, setSound] = useState(false);
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
    <div className="app">
      <a className="skip" href="#main-content">
        跳至主要内容
      </a>
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          <Waves />
          <span>
            守望<small>MARKET WATCH</small>
          </span>
        </NavLink>
        <div className="workspace-label">个人工作空间</div>
        <nav>
          {[
            ["/", "行情与监控", Activity],
            ["/chart-workspaces", "图表工作区", Square],
            ["/advanced-charts", "专业图表（验证版）", Square],
            ["/signals", "信号中心", Bell],
            ["/replay", "历史演练", Clock3],
            ["/settings", "提醒与设置", Settings2],
          ].map(([path, label, Icon]: any) => (
            <NavLink key={path} end={path === "/"} to={path}>
              <Icon size={19} />
              {label}
              {path === "/signals" &&
                signals.filter((s) => !s.ack_at).length > 0 && (
                  <span className="count">
                    {signals.filter((s) => !s.ack_at).length}
                  </span>
                )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="quiet-note">
            <Radio size={18} />
            <strong>保持连接，安心等待</strong>
            <p>
              监控在服务器持续运行。
              <br />
              关闭网页不影响策略执行。
            </p>
          </div>
          <button className="logout" onClick={logout}>
            <LogOut size={17} />
            退出登录
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            工作台 <ChevronRight size={14} />
            <strong>
              {location.pathname.startsWith("/market-data") ? "数据中心" : location.pathname === "/replay"
                ? "历史演练"
                : location.pathname === "/signals"
                  ? "信号中心"
                  : location.pathname === "/settings"
                    ? "提醒与设置"
                    : "行情与监控"}
            </strong>
          </span>
          <div>
            <button
              className={`sound-toggle ${sound ? "enabled" : ""}`}
              onClick={async () => {
                if (!sound) {
                  audio.current ??= new AudioContext();
                  await audio.current.resume();
                }
                setSound(!sound);
              }}
            >
              <Bell size={16} />
              {sound ? "网页声音已开" : "开启网页声音"}
            </button>
            <span className="avatar">我</span>
          </div>
        </header>
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
              path="/"
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
              path="/replay"
              element={<ReplayPage instruments={instruments} />}
            />
            <Route
              path="/settings"
              element={<SettingsPage health={health} previewSound={async () => {
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
                  页面不存在。<NavLink to="/">回到工作台</NavLink>
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
        <button className="primary" onClick={() => setOpen(true)}>
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
              <span className={`instrument-icon ${i.id.toLowerCase()}`}>
                {i.id === "EURUSD" ? "€" : i.id === "XAUUSD" ? "Au" : "₿"}
              </span>
              <div>
                <strong>{i.id}</strong>
                <span>{i.label}</span>
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
              {selected}
              <span className="muted">{inst?.label}</span>
            </h2>
            <p>
              {inst?.source} · {inst?.basis} · 图表时间 UTC
              {inst?.calendar_profile?.revision && <> · 日历 {inst.calendar_profile.revision}</>}
            </p>
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
                    {w.market_identity ? `${w.market_identity.symbol} · 组合 · ${w.market_identity.calendar === "ny17" ? "NY17" : "UTC 00:00"}` : w.instrument_id} · {w.rule.timeframe} ·{" "}
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
            <button className="secondary" onClick={() => setOpen(true)}>
              <Plus size={16} />
              创建第一条预警
            </button>
          </div>
        )}
      </section>
      {open && (
        <WatchDialog
          instrument={selected}
          liveInput
          onClose={() => setOpen(false)}
          onSave={async (data) => {
            await api("/watches", data);
            await refresh();
            setOpen(false);
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
}: {
  instrument: string;
  onClose: () => void;
  onSave: (data: any) => Promise<void>;
  timeframe?: string;
  liveInput?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [inputKind, setInputKind] = useState(liveInput ? "composite" : "legacy");
  const [series, setSeries] = useState<QualifiedSeries | null>(null);
  const [seamPolicy, setSeamPolicy] = useState("reject");
  const selectedInput = inputKind === "composite" ? series?.id ?? "" : instrument;
  const [kind, setKind] = useState("pullback"),
    [direction, setDirection] = useState("both"),
    [frame, setFrame] = useState(timeframe || "H4"),
    [count, setCount] = useState(2),
    [fast, setFast] = useState(10),
    [slow, setSlow] = useState(20),
    [level, setLevel] = useState(""),
    [name, setName] = useState(""),
    [history, setHistory] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        instrument_id: selectedInput,
        ...(liveInput ? {series_kind: inputKind, ...(inputKind === "composite" ? {seam_policy: seamPolicy} : {})} : {}),
        name: name || `${series && inputKind === "composite" ? series.symbol : instrument} · ${names[kind]}`,
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
    <dialog ref={dialog} onCancel={onClose}>
      <form onSubmit={save}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">NEW WATCH</span>
            <h2>设置一条预警</h2>
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
          {instrument} <span>一次性监控 · 触发后关闭</span>
        </div>}
        <label>
          预警名称
          <input
            value={name}
            maxLength={100}
            placeholder={`${series && inputKind === "composite" ? series.symbol : instrument} · ${names[kind]}`}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          策略
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (!timeframe)
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
          <h1>每一次提醒，都有依据。</h1>
          <p>核对触发价格与时间，确认你已经看到这次机会。</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        {signals.length ? (
          signals.map((s) => (
            <article className="signal-card" key={s.id}>
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
                  try{await api(`/notifications/${s.notification_id}/retry`,{});window.location.reload()}
                  catch(e){window.alert(String(e))}
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
  const location=useLocation();
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
  useEffect(()=>{api('/replays').then(setSavedRuns).catch(()=>{})},[]);
  async function resumeReplay(id:string){const g=++generation.current;setPlaying(false);setError('');try{const r=await api(`/replays/${id}`);if(g===generation.current)setRun(r)}catch(e){if(g===generation.current)setError(String(e))}}

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
      if(g===generation.current)setRun(result);
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
      {savedRuns.length>0&&<section className="panel"><div className="panel-heading"><h2>继续已有演练</h2></div><div className="replay-controls"><label>已保存的演练<select defaultValue="" onChange={e=>{if(e.target.value)resumeReplay(e.target.value)}}><option value="">选择演练</option>{savedRuns.map(r=><option key={r.id} value={r.id}>{replayLabel(r.instrument_id)} · {r.timeframe} · {date(r.cursor)} · {r.id.slice(0,6)}</option>)}</select></label></div></section>}
      <section className="panel replay-setup">
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
      </section>
      {jobSummary?.weekly_requests?.length>0&&<section className="panel">
        <div className="panel-heading"><h2>周线后台需求</h2><small>优先保障日线及以下周期，最多显示 30 项</small></div>
        {jobSummary.weekly_requests.map((request:any)=><div className="watch-row" key={request.id}>
          <strong>{request.instrument_id}</strong><small>截止 {date(request.before)}</small>
          <span className="status">{{pending:'排队或补数中',complete:'已完成',needs_review:'待核查',failed:'未完成'}[request.status as string]||request.status}</span>
          <span>尚需 {request.remaining} 根周线</span>
          {request.status==='needs_review'&&<small className="warning">已查询区间没有可用周线，已停止自动向前补数；尚未确认历史起点，请检查品种与日期范围。</small>}
        </div>)}
      </section>}
      {jobs.length>0&&<section className="panel"><div className="panel-heading"><h2>历史数据任务</h2><small>后台分日获取，可在重启后继续</small></div>{jobSummary&&<p>共 {jobSummary.total} 项：已完成 {jobSummary.counts.complete||0}，等待 {jobSummary.counts.pending||0}，获取中 {jobSummary.counts.running||0}，失败 {jobSummary.counts.failed||0}。下方最多显示 30 项，失败任务优先。</p>}{jobs.map(j=><div className="watch-row" key={j.id}><strong>{j.instrument_id}</strong><small>{j.priority===0?"断档修复":j.priority===50?"初始历史":j.priority===100?"图表历史":j.priority===200?"周线后台":"手动导入"} · {date(j.start)} — {date(j.end)}</small><span className="status">{{pending:'等待获取',running:'获取中',complete:'已完成',failed:'失败'}[j.status as string]||j.status}</span><span>{Math.round((j.cursor-j.start)/(j.end-j.start)*100)}%</span>{j.status==='failed'&&<button className="secondary" onClick={()=>retryImport(j.id)}>从断点重试</button>}{j.error&&<small className="warning">{j.error.includes('429')?'上游限流，等待重试':j.error}</small>}</div>)}</section>}
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
            <Chart
              bars={run.bars}
              markers={run.signals}
              precision={
                instruments.find((i) => i.id === run.instrument_id)?.precision ?? historyDatasets.find(d=>d.instrument_id===run.instrument_id)?.precision
              }
            />
            <div className="replay-controls">
              <button
                className="secondary"
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

function SettingsPage({ health, previewSound }: { health: any; previewSound: () => Promise<void> }) {
  const [audioMessage, setAudioMessage] = useState(""), [audioBusy, setAudioBusy] = useState(false);
  const [config, setConfig] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/settings/notifications")
      .then(setConfig)
      .catch((e) => setMessage(String(e)));
  }, []);
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
      await api("/settings/notifications", {...config, mode: "ntfy_native"});
      setMessage("提醒设置已保存");
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
      <div className="settings-grid">
        <section className="panel settings-card">
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
        </section>
        <section className="panel settings-card">
          <h2>网页声音</h2>
          <p>试听会在当前浏览器播放半秒提示音。接收新信号的声音提醒，请在页面顶部开启网页声音。</p>
          <button type="button" className="secondary" disabled={audioBusy} onClick={async () => {
            setAudioBusy(true); setAudioMessage("");
            try { await previewSound(); setAudioMessage("试听已播放；若未听到，请检查设备音量和站点声音权限。"); }
            catch (e) { setAudioMessage(String(e)); }
            finally { setAudioBusy(false); }
          }}>{audioBusy ? "正在播放…" : "试听网页声音"}</button>
          {audioMessage && <p role="status">{audioMessage}</p>}
          <Activity size={24} />
          <h2>后台运行状态</h2>
          {health.market_incidents?.map((item:any) => <p key={item.instrument}>{item.instrument}：24 小时内 {item.errors_24h} 次行情异常{item.current_error ? '，当前仍有错误' : ''}{item.last_error_at ? `；最近异常 ${date(item.last_error_at)}` : ''}{item.last_recovered_at ? `；最近恢复 ${date(item.last_recovered_at)}` : ''}</p>)}
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
            <dt>历史补数后台状态</dt><dd>{health.worker_status?.import_heartbeat === "running" ? "运行中" : health.worker_status?.import_heartbeat === "stale" ? "心跳过期，请检查服务" : "尚未收到心跳"}</dd>
            <dt>补数 worker 最近心跳</dt><dd>{health.workers?.import_heartbeat ? date(health.workers.import_heartbeat) : "尚未上报"}</dd>
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

        </section>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
