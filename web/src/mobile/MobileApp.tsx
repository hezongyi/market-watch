import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  CandlestickChart,
  Database,
  Ellipsis,
  List,
  Eye,
  EyeOff,
} from "lucide-react";
import { api, ApiError, setCsrf } from "../api";
import MobileChart, { type MobileChartHandle } from "./MobileChart";
import {
  allowSession,
  clearOrigin,
  lastProfile,
  locallySignedOut,
  rememberProfile,
  readSnapshot,
  writeSnapshot,
  MOBILE_SCHEMA,
  type Profile,
} from "./cache";
import { useMobileShell } from "./shell";
import { mobileMarket, type MobileMarket } from "./market";
import WatchPage from "./WatchPage";
import DataPage from "./DataPage";
import MobileToast from "./MobileToast";
import AlertsPage from "./AlertsPage";
import MorePage from "./MorePage";
import { useMobileNotices } from "./notices";

type Series = {
  ticker: string;
  symbol?: string;
  display_symbol?: string;
  description?: string;
  name?: string;
  kind?: string;
  series_kind?: string;
};
const pages = [
  { path: "/", label: "自选", Icon: List },
  { path: "/chart", label: "图表", Icon: CandlestickChart },
  { path: "/alerts", label: "告警", Icon: Bell },
  { path: "/data", label: "数据", Icon: Database },
  { path: "/more", label: "更多", Icon: Ellipsis },
];
export default function MobileApp() {
  const navigate = useNavigate(),
    location = useLocation();
  const [profile, setProfile] = useState<Profile>(),
    [state, setState] = useState<"loading" | "login" | "online" | "offline">(
      "loading",
    );
  const [message, setMessage] = useState(""),
    [password, setPassword] = useState(""),
    [reveal, setReveal] = useState(false),
    [busy, setBusy] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark"),
    [chartDirty, setChartDirty] = useState(false);
  const [chartOpened, setChartOpened] = useState(false);
  const [createAlert, setCreateAlert] = useState(0);
  const [records, setRecords] = useState(false);
  const notices = useMobileNotices(profile, state === "online");
  const [connection, setConnection] = useState<MobileMarket>();
  const chart = useRef<MobileChartHandle>(null),
    generation = useRef(0),
    session = useRef<AbortController | undefined>(undefined),
    sessionAllowed = useRef(false);
  const report = useCallback((value: string) => setMessage(value), []);
  useEffect(() => {
    if (!profile || state !== "online") {
      setConnection(undefined);
      return;
    }
    const value = mobileMarket(report);
    setConnection(value);
    return () => {
      void value.dispose().catch(() => {});
    };
  }, [profile?.origin, profile?.subject, state, report]);
  const flush = useCallback(async () => {
    await chart.current?.flush();
  }, []);
  const shell = useMobileShell(
    flush,
    () =>
      password.length > 0 ||
      Boolean(document.querySelector('[data-mobile-dirty="true"]')),
  );
  const restore = async (value: Profile) => {
    const [selected, appearance] = await Promise.all([
      readSnapshot<string>(value, "chart-selection"),
      readSnapshot<"dark" | "light">(value, "theme"),
    ]);
    setSymbol(selected?.value || "");
    setTheme(appearance?.value || "dark");
  };
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    session.current?.abort();
    const controller = new AbortController();
    session.current = controller;
    try {
      if (
        !sessionAllowed.current &&
        (await locallySignedOut(window.location.origin).catch(() => false))
      ) {
        if (token === generation.current) setState("login");
        return;
      }
      const result = await api("/session", undefined, controller.signal);
      if (token !== generation.current) return;
      setCsrf(result.csrf);
      const value: Profile = {
        origin: window.location.origin,
        subject: result.subject,
        schema: MOBILE_SCHEMA,
      };
      setProfile(value);
      setState("online");
      try {
        await rememberProfile(value.origin, value.subject);
        await restore(value);
      } catch {
        report("本机存储不可用，当前更改可能无法记住");
      }
    } catch (error) {
      if (token !== generation.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        setCsrf("");
        setProfile(undefined);
        setState("login");
        setPassword("");
      } else {
        setState("offline");
        report(String(error));
      }
    }
  }, [report]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const previous = await lastProfile(window.location.origin);
        if (active && previous) {
          setProfile(previous);
          await restore(previous);
        }
      } catch {
        if (active) report("本机缓存暂不可用");
      }
      if (active) void refresh();
    })();
    const expire = () => {
      ++generation.current;
      session.current?.abort();
      setCsrf("");
      setProfile(undefined);
      setState("login");
      setPassword("");
      setChartDirty(false);
      setChartOpened(false);
    };
    const foreground = () => {
      if (!document.hidden) void refresh();
    };
    addEventListener("mw-session-expired", expire);
    addEventListener("online", refresh);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      ++generation.current;
      session.current?.abort();
      removeEventListener("mw-session-expired", expire);
      removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh, report]);
  useEffect(() => {
    if (location.pathname === "/chart") setChartOpened(true);
  }, [location.pathname]);
  useEffect(() => {
    if (!pages.some((page) => page.path === location.pathname))
      navigate("/", { replace: true });
  }, [location.pathname, navigate]);
  useEffect(() => {
    const back = (event: Event) => {
      // On Window, target listeners may run in registration order even when
      // the sheet listener uses capture. Let the open top layer own this event.
      if (
        event.defaultPrevented ||
        document.querySelector("dialog.mobile-sheet[open]")
      )
        return;
      event.preventDefault();
      if (password) {
        if (window.confirm("放弃尚未提交的密码输入？")) setPassword("");
        return;
      }
      void (async () => {
        if (location.pathname === "/chart" && (await chart.current?.back()))
          return;
        await flush();
        if (location.pathname !== "/") navigate("/");
        else shell.exit();
      })().catch((error) => report(String(error)));
    };
    addEventListener("mw-mobile-back", back);
    return () => removeEventListener("mw-mobile-back", back);
  }, [location.pathname, password, flush, shell, report, navigate]);
  async function logout() {
    ++generation.current;
    session.current?.abort();
    notices.runtime.pause();
    setRecords(false);
    setProfile(undefined);
    setPassword("");
    setSymbol("");
    setChartDirty(false);
    setChartOpened(false);
    setState("login");
    sessionAllowed.current = false;
    await clearOrigin(window.location.origin).catch(() =>
      report("本机缓存清理失败，请在系统设置清除此站点数据"),
    );
    // Keep CSRF until the request is constructed, even when local contents are removed first.
    try {
      await api("/logout", {});
      report("已退出；服务器告警继续运行");
    } catch {
      report("本机内容已清除，服务端会话撤销未确认；服务器告警继续运行");
    }
    setCsrf("");
    shell.clearCookies();
    navigate("/", { replace: true });
  }
  async function select(row: Series) {
    if (!profile || !row.ticker) return;
    await flush();
    setSymbol(row.ticker);
    navigate("/chart");
    await writeSnapshot(profile, "chart-selection", row.ticker).catch(() =>
      report("本次品种选择未记住"),
    );
  }
  return (
    <div className="mobile-app" data-theme={theme}>
      <a className="sr-only" href="#mobile-main">
        跳至主要内容
      </a>
      <MobileToast message={message} close={() => setMessage("")} />
      {shell.update && (
        <aside className="mobile-update" role="status">
          页面有更新
          <button
            onClick={() =>
              void shell.apply().catch((error) => report(String(error)))
            }
          >
            更新页面
          </button>
        </aside>
      )}
      {notices.popup && !message && (
        <MobileToast message={notices.popup} close={notices.closePopup} />
      )}
      <main id="mobile-main">
        {state === "login" || (!profile && state !== "loading") ? (
          <section className="mobile-login">
            <h1>连接守望</h1>
            <p>{window.location.origin}</p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                setMessage("");
                try {
                  const result = await api("/login", { password });
                  setCsrf(result.csrf);
                  setPassword("");
                  sessionAllowed.current = true;
                  await allowSession(window.location.origin).catch(() =>
                    report("本机登录状态未记住"),
                  );
                  await refresh();
                } catch (error) {
                  report(String(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label htmlFor="mobile-password">密码</label>
              <div className="mobile-password">
                <input
                  id="mobile-password"
                  autoComplete="current-password"
                  type={reveal ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={reveal ? "隐藏密码" : "显示密码"}
                  aria-pressed={reveal}
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? <EyeOff /> : <Eye />}
                </button>
              </div>
              <button className="primary" disabled={busy}>
                {busy ? "正在连接…" : "登录"}
              </button>
            </form>
            <button onClick={() => void refresh()}>重新连接</button>
            <button onClick={() => void logout().then(() => shell.configure())}>
              换服务器
            </button>
          </section>
        ) : (
          <>
            {location.pathname !== "/chart" && location.pathname !== "/" && (
              <header className="mobile-title">
                <h1>
                  {pages.find((page) => page.path === location.pathname)
                    ?.label || "自选"}
                </h1>
              </header>
            )}
            {state === "loading" && !profile && (
              <p role="status">正在读取上次内容…</p>
            )}
            {profile &&
              state === "online" &&
              connection &&
              symbol &&
              (chartOpened || location.pathname === "/chart") && (
                <MobileChart
                  ref={chart}
                  profile={profile}
                  connection={connection}
                  symbol={symbol}
                  visible={location.pathname === "/chart"}
                  report={report}
                  dirty={setChartDirty}
                  createAlert={() => {
                    navigate("/alerts");
                    setCreateAlert((value) => value + 1);
                  }}
                />
              )}
            {location.pathname === "/chart" && state !== "online" && (
              <p>上次图表设置已保留，连接核验后加载专业图表。</p>
            )}
            {location.pathname === "/chart" && !symbol && (
              <p>从数据页选择真实系列打开图表。</p>
            )}
            {location.pathname === "/chart" && chartDirty && (
              <span className="mobile-unsaved" role="status">
                本次图表更改尚未记住
              </span>
            )}
            {profile && (
              <WatchPage
                profile={profile}
                online={state === "online"}
                connection={connection}
                visible={location.pathname === "/"}
                report={report}
                search={() => navigate("/data")}
                open={(ticker) =>
                  void select({ ticker }).catch((error) =>
                    report(String(error)),
                  )
                }
              />
            )}
            {profile && (
              <DataPage
                profile={profile}
                online={state === "online"}
                visible={location.pathname === "/data"}
                report={report}
                open={(ticker) =>
                  void select({ ticker }).catch((error) =>
                    report(String(error)),
                  )
                }
              />
            )}
            {profile && (
              <AlertsPage
                key={profile.origin + profile.subject}
                profile={profile}
                online={state === "online"}
                visible={location.pathname === "/alerts"}
                symbol={symbol}
                createToken={createAlert}
                runtime={notices.runtime}
                records={records}
                showRecords={() => setRecords(true)}
                closeRecords={() => setRecords(false)}
                report={report}
              />
            )}
            {location.pathname === "/more" && (
              <MorePage
                online={state === "online"}
                theme={theme}
                connection={connection}
                shell={shell}
                records={() => setRecords(true)}
                logout={logout}
                report={report}
                setTheme={() => {
                  const value = theme === "dark" ? "light" : "dark";
                  setTheme(value);
                  if (profile)
                    void writeSnapshot(profile, "theme", value).catch(() =>
                      report("主题未记住"),
                    );
                }}
              />
            )}
          </>
        )}
      </main>
      {profile && state !== "login" && (
        <nav className="mobile-nav" aria-label="主导航">
          {pages.map(({ path, label, Icon }) => (
            <NavLink
              key={path}
              to={path}
              end
              onClick={(event) => {
                if (location.pathname !== "/chart" || path === "/chart") return;
                event.preventDefault();
                void (async () => {
                  if (!chart.current || (await chart.current.canLeave())) {
                    await flush();
                    navigate(path);
                  }
                })().catch((error) => report(String(error)));
              }}
            >
              <Icon aria-hidden="true" />
              <span>
                {label}
                {path === "/alerts" && Boolean(notices.state.alertUnread) && (
                  <small aria-label="未处理告警">
                    {" "}
                    · {notices.state.alertUnread}
                  </small>
                )}
              </span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
