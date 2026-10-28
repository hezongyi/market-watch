import {resolveSignal} from "./runtime/notifications";
import {NoticeProvider,useNotices,useNoticeState} from "./notifications/context";
import React, { useCallback, useEffect, useRef, useState, Suspense } from "react";
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
  Bell,
  Waves,
} from "lucide-react";
import {
  api,
  ApiError,
  setCsrf,
  date,
  type Instrument,
  type Signal,
} from "./api";
import "./style.css";
import Login from "./app/Login";
import { AppContext, useApp, type LeaveGuard } from "./app/context";
import { safeNext, defaultChart, pageName, chartReturn, notificationReturn } from "./app/navigation";
import "./app/app.css";
import ChartApplicationPage from "./advanced/ChartApplicationPage";
import { centerLocation } from "./market-data/location";
import { instrumentName, instrumentIdentity } from "./instrumentPresentation";
import InstrumentDetails from "./InstrumentDetails";

function App() {
  const appLocation = useLocation(), navigate = useNavigate();
  const [subject,setSubject]=useState("");
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
    try { const r = await api("/session"); setCsrf(r.csrf); setSubject(r.subject); setLogged(true); }
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
  else if (appLocation.pathname === "/login") content = logged ? <Navigate replace to={next} /> : <Login next={next} connectionError={connectionError} retry={checkSession} login={async password => { const r = await api("/login", { password }); setCsrf(r.csrf); setSubject(r.subject); setLogged(true); navigate(next, { replace: true }); }} />;
  else if (connectionError && !logged) content = <div className="loading" role="alert">连接出现问题：{connectionError}<button onClick={checkSession}>重新连接</button></div>;
  else if (!logged) content = <Navigate replace to={"/login?next=" + encodeURIComponent(safeNext(appLocation.pathname + appLocation.search + appLocation.hash))} />;
  else if (appLocation.pathname === "/") content = <Navigate replace to={defaultChart} />;
  else if (safeNext(appLocation.pathname + appLocation.search + appLocation.hash).startsWith("/market-data")) content = <Navigate replace to={`${defaultChart}?data_center=${encodeURIComponent(centerLocation(appLocation.pathname + appLocation.search + appLocation.hash))}`} />;
  else if (appLocation.pathname === "/settings") content = <Navigate replace to="/settings/notifications" />;
  else content = <Suspense fallback={<div className="loading">正在加载…</div>}><Routes>
    <Route path="/advanced-charts/:workspaceId?" element={<ChartApplicationPage />} />
    <Route path="*" element={<Shell logout={logout} />} />
  </Routes></Suspense>;
  return <AppContext.Provider value={{ registerGuard, confirmLeave, logout, theme, setTheme, pending }}>
    <NoticeProvider active={logged} subject={subject}>{content}</NoticeProvider>
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
  const noticeRuntime=useNotices(),noticeState=useNoticeState();
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
  return <header className="app-header"><button ref={button} type="button" aria-label="应用菜单" aria-expanded={open} aria-controls="app-menu" onClick={() => setOpen(!open)}><Menu size={20} aria-hidden="true" /></button><Waves size={23} aria-hidden="true" /><strong>{pageName(location.pathname)}</strong><NavLink to={chartReturn()}>返回图表</NavLink><button onClick={toggleSound} aria-pressed={sound}>{sound ? "网页声音已开" : "开启网页声音"}</button><span role="status">{sound&&!noticeState.unlocked&&<button onClick={()=>void noticeRuntime.unlock()}>解锁网页声音</button>}</span><button aria-label={theme === "dark" ? "切换浅色主题" : "切换暗色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
    {open && <nav id="app-menu" className="app-menu" ref={menu} aria-label="应用导航" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node) && e.relatedTarget !== button.current) setOpen(false); }}><NavLink to={chartReturn()}>图表</NavLink><NavLink to={notificationReturn()}>系统消息</NavLink><NavLink to="/signals">历史通知{pending>0?`（${pending} 待手机确认）`:""}</NavLink><NavLink to="/settings">设置</NavLink><hr /><button onClick={logout}>退出登录</button></nav>}
  </header>;
}

function Shell({ logout }: { logout: () => void }) {
  const [instruments, setInstruments] = useState<Instrument[]>([]),
    [signals, setSignals] = useState<Signal[]>([]),
    [error, setError] = useState("");
  const [health, setHealth] = useState<any>({});
  const notices=useNotices(), noticeState=useNoticeState();
  const { theme } = useApp();
  const refreshRunning = useRef(false);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshRunning.current) { refreshAgain.current = true; return; }
    refreshRunning.current = true;
    try {
      const [i, s, h] = await Promise.all([
        api("/instruments"),
        api("/signals"),
        api("/health"),
      ]);
      setInstruments(i);
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
        <AppHeader logout={logout} sound={noticeState.enabled} toggleSound={() => {void notices.setEnabled(!noticeState.enabled);}} />
        <main id="main-content" tabIndex={-1}>
          {matchMedia("(pointer:coarse)").matches && <p className="muted" role="note">专业图表在手机上只读看盘；编辑功能请使用桌面浏览器。</p>}
          {error && (
            <div className="error" role="alert">
              连接出现问题：{error}
              <button onClick={refresh}>重试</button>
            </div>
          )}
          <Routes>
            <Route path="/signals" element={<HistoricalSignals signals={signals} refresh={refresh} />} />
            <Route
              path="/settings/:section"
              element={<SettingsPage health={health} instruments={instruments} previewSound={async () => { await notices.preview(); }} />}
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

function HistoricalSignals({signals,refresh}:{signals:Signal[];refresh:()=>void}) {
  const [error,setError]=useState("");
  const here=useLocation(),navigate=useNavigate();
  const selected=new URLSearchParams(here.search).get('signal');
  useEffect(()=>{if(!selected)return;let live=true;void resolveSignal(selected).then(result=>{
    if(!live)return;if(result.destination)navigate(result.destination,{replace:true});else document.getElementById(selected)?.scrollIntoView();
  }).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[selected,navigate]);
  return <section className="panel"><h1>历史通知</h1><p>旧规则已退役并停止提醒。信号、投递记录和确认状态保留。</p>
    {error&&<p role="alert">{error}</p>}{signals.filter(row=>!row.evidence?.chart_alert).map(row=><article key={row.id} id={row.id}><h2>{row.reason}</h2><p>{date(row.occurred_at)} · {row.instrument_id} · {row.price}</p>
      <p>{row.ack_at?"已确认":row.retired?"退役停止提醒":"待确认"}</p>{!row.ack_at&&<button onClick={()=>void api('/notifications/'+row.notification_id+'/ack',{}).then(refresh).catch(e=>setError(String(e)))}>确认此历史通知</button>}</article>)}
  </section>;
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
    try{const result=await api<{status:string;device_delivery:string}>('/notification-tests',{});setMessage(result.status==='queued'?'测试通知已排队；手机是否收到仍待确认。':`测试通知状态：${result.status}`)}
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
          <p>试听会在当前浏览器播放半秒提示音。专业图表业务告警的自动声音由通知中心统一管理；请开启声音并在当前浏览器解锁。</p>
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
          {[ ["行情运行组", health.market_runtime], ["数据运行组", health.data_runtime], ["通知运行组", health.notification_runtime] ].map(([label, roles]:any) => {
            const fresh = roles?.filter((role:any) => !role.error_type && ["idle", "waiting_input", "disabled"].includes(role.state)).length ?? 0;
            const total = roles?.length ?? 0;
            return <section key={label}>
              <h3>{label} · {fresh}/{total} 状态正常</h3>
              <div className="history-service-status">
                {roles?.map((role:any) => <div key={role.role}>
                  <strong>{({pricing:"行情采集",realtime:"实时输入",composite_aggregate:"组合聚合",alert_indicator:"告警指标",chart_alert:"告警判定",market_ownership:"运行所有权",notification_projection:"通知投影",notification_retention:"通知保留维护",notification_delivery:"通知投递",notification_ownership:"通知所有权",notification_health:"运行巡检"} as Record<string,string>)[role.role] || role.role}</strong>
                  <p>{role.error_type ? "循环异常" : ({idle:"循环正常",waiting_input:"等待输入",disabled:"未启用",stale:"心跳过期",starting:"启动中",stopped:"已停止",missing:"尚未收到心跳"} as Record<string,string>)[role.state] || role.state || "尚未收到心跳"}{role.error_type ? ` · ${role.error_type}` : ""}</p>
                  <p>最近检查：{role.checked_at ? date(role.checked_at) : "尚未检查"} · 最近成功：{role.last_success_at ? date(role.last_success_at) : "尚未记录"}</p>
                </div>)}
              </div>
            </section>;
          })}
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
            <dt>凭证错误而暂停的投递</dt><dd>{health.blocked_notifications ?? 0}</dd>
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
