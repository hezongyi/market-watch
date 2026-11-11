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
  const [series, setSeries] = useState<Series[]>([]),
    [seriesReadAt, setSeriesReadAt] = useState<number>(),
    [symbol, setSymbol] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark"),
    [chartDirty, setChartDirty] = useState(false);
  const [chartOpened, setChartOpened] = useState(false);
  const chart = useRef<MobileChartHandle>(null),
    generation = useRef(0),
    session = useRef<AbortController | undefined>(undefined),
    sessionAllowed = useRef(false);
  const report = useCallback((value: string) => setMessage(value), []);
  const flush = useCallback(async () => {
    await chart.current?.flush();
  }, []);
  const shell = useMobileShell(flush, () => password.length > 0);
  const restore = async (value: Profile) => {
    const [data, selected, appearance] = await Promise.all([
      readSnapshot<Series[]>(value, "recent-composites"),
      readSnapshot<string>(value, "chart-selection"),
      readSnapshot<"dark" | "light">(value, "theme"),
    ]);
    setSeries(data?.value || []);
    setSeriesReadAt(data?.readAt);
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
      if (token !== generation.current) return;
      try {
        const data = await api<{ items: Series[] }>(
          "/market-data/series/page?kind=composite&include_total=false&page_size=20",
          undefined,
          controller.signal,
        );
        if (token !== generation.current) return;
        setSeries(data.items);
        setSeriesReadAt(undefined);
        await writeSnapshot(value, "recent-composites", data.items).catch(() =>
          report("上次数据未能写入本机"),
        );
      } catch (error) {
        if (token === generation.current && !controller.signal.aborted)
          report(String(error));
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
    setProfile(undefined);
    setPassword("");
    setSymbol("");
    setSeries([]);
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
      {message && (
        <aside className="mobile-toast" role="alert">
          <span>{message}</span>
          <button aria-label="关闭通知" onClick={() => setMessage("")}>
            关闭
          </button>
        </aside>
      )}
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
            {location.pathname !== "/chart" && (
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
              symbol &&
              (chartOpened || location.pathname === "/chart") && (
                <MobileChart
                  ref={chart}
                  profile={profile}
                  symbol={symbol}
                  visible={location.pathname === "/chart"}
                  report={report}
                  dirty={setChartDirty}
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
            {location.pathname === "/" && (
              <section className="mobile-content">
                <p>自选列表将在日常看盘阶段接入。</p>
                <button onClick={() => navigate("/data")}>打开组合图表</button>
              </section>
            )}
            {location.pathname === "/data" && (
              <section className="mobile-content">
                <h2>组合行情</h2>
                {seriesReadAt && (
                  <p>上次读取 {new Date(seriesReadAt).toLocaleString()}</p>
                )}
                {!series.length && (
                  <p>
                    {state === "online"
                      ? "暂无可用组合"
                      : state === "loading"
                        ? "正在读取…"
                        : "当前没有可读取的组合缓存"}
                  </p>
                )}
                {series.map((row) => (
                  <button
                    className="mobile-series"
                    key={row.ticker}
                    onClick={() =>
                      void select(row).catch((error) => report(String(error)))
                    }
                  >
                    <strong>
                      {row.display_symbol ||
                        row.symbol ||
                        row.name ||
                        row.ticker}
                    </strong>
                    <span>{row.description || row.ticker}</span>
                  </button>
                ))}
              </section>
            )}
            {location.pathname === "/alerts" && (
              <section className="mobile-content">
                <p>手机告警与记录将在告警阶段接入。已有服务器规则继续执行。</p>
              </section>
            )}
            {location.pathname === "/more" && (
              <section className="mobile-content">
                <h2>连接</h2>
                <p>{window.location.origin}</p>
                <p>
                  {state === "online" ? "会话已核验" : "上次内容，连接尚未核验"}
                </p>
                <button onClick={() => void refresh()}>重新连接</button>
                <h2>外观</h2>
                <button
                  onClick={() => {
                    const value = theme === "dark" ? "light" : "dark";
                    setTheme(value);
                    if (profile)
                      void writeSnapshot(profile, "theme", value).catch(() =>
                        report("主题未记住"),
                      );
                  }}
                >
                  切换{theme === "dark" ? "浅色" : "深色"}
                </button>
                <h2>后台通知</h2>
                <p>
                  沿用 ntfy。退出 App 不停止服务器监控；手机实收状态尚未验收。
                </p>
                <h2>关于</h2>
                <p>Android 个人版 · A 阶段开发中</p>
                <button onClick={() => void logout()}>退出登录</button>
                <button
                  onClick={() => {
                    if (confirm("换服务器将清除本机内容，服务器告警继续运行。"))
                      void logout().then(() => shell.configure());
                  }}
                >
                  换服务器
                </button>
              </section>
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
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
