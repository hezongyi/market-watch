import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Bell, CandlestickChart, ChevronRight, Database, Ellipsis, List } from "lucide-react";
import { api, ApiError, errorMessage, setCsrf } from "../api";
import MobileChart, { type MobileChartHandle } from "./MobileChart";
import {
  allowSession,
  clearOrigin,
  lastProfile,
  locallySignedOut,
  rememberProfile,
  readSnapshot,
  writeSnapshot,
  profileFor,
  invalidateProfile,
  profileActive,
  type Profile,
} from "./cache";
import { useMobileShell } from "./shell";
import { mobileMarket, type MobileMarket } from "./market";
import WatchPage from "./WatchPage";
import DataPage from "./DataPage";
import { logEvent, logFailure, setLogProfile } from "./logs";
import AlertsPage from "./AlertsPage";
import MorePage from "./MorePage";
import LoginPage, { type LoginError, type LoginIntent } from "./LoginPage";
import { Button } from "./components/ui/button";
import { MOBILE_OVERLAYS } from "./WatchOverlays";
import { useMobileNotices } from "./notices";
import { ChartEmpty } from "./ChartState";
import { mobileChartPreparation } from "./chartPreparation";

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
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<LoginError>();
  const [loginIntent, setLoginIntent] = useState<LoginIntent>();
  const [checking, setChecking] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [chartTarget, setChartTarget] = useState<{ symbol: string; resolution: string; token: number }>();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [chartOpened, setChartOpened] = useState(false);
  const [firstWatchSymbol, setFirstWatchSymbol] = useState("");
  const [createAlert, setCreateAlert] = useState(0);
  const [records, setRecords] = useState(false);
  const notices = useMobileNotices(profile, state === "online");
  const [connection, setConnection] = useState<MobileMarket>();
  const chart = useRef<MobileChartHandle>(null),
    generation = useRef(0),
    session = useRef<AbortController | undefined>(undefined),
    sessionAllowed = useRef(false),
    signingOut = useRef(false);
  useLayoutEffect(() => setLogProfile(profile), [profile?.origin, profile?.subject, profile?.generation]);
  const report = useCallback((value: string) => logEvent({module:"应用",action:"运行反馈",message:value,level:"warning"}), []);
  const scopedReports = useMemo(() => {
    const target = profile || profileFor(window.location.origin, "anonymous");
    return Object.fromEntries(["图表", "自选", "数据", "告警", "更多", "行情"].map(module => [module, (value: string) => logFailure(module, "运行反馈", value, undefined, target)]));
  }, [profile?.origin, profile?.subject, profile?.generation]);
  const preparation = useMemo(() => profile && state === "online"
    ? mobileChartPreparation(profile) : undefined,
    [profile?.origin, profile?.subject, profile?.generation, state === "online"]);
  useEffect(() => {
    if (!preparation) return;
    const visibility = () => preparation.visibility(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); preparation.dispose(); };
  }, [preparation]);
  useEffect(() => {
    preparation?.update(symbol, firstWatchSymbol, location.pathname === "/chart");
  }, [preparation, symbol, firstWatchSymbol, location.pathname]);
  const navigation = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const measure = () =>
      nav.parentElement?.style.setProperty(
        "--mobile-nav-height",
        `${nav.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [Boolean(profile), state === "login"]);
  const loginVisible = useRef(false);
  loginVisible.current = !profile;
  const cachedPageHasProfile = useRef(false);
  cachedPageHasProfile.current =
    ["/", "/data"].includes(location.pathname) && Boolean(profile);
  useEffect(() => {
    if (!profile || state !== "online") {
      setConnection(undefined);
      return;
    }
    const value = mobileMarket(scopedReports["行情"]);
    setConnection(value);
    return () => {
      void value.dispose().catch(() => {});
    };
  }, [profile?.origin, profile?.subject, state, scopedReports]);
  const flush = useCallback(async () => {
    await chart.current?.flush();
  }, []);
  const shell = useMobileShell(
    flush,
    () =>
      password.length > 0 ||
      Boolean(document.querySelector('[data-mobile-dirty="true"]')),
    theme,
  );
  const restore = async (
    value: Profile,
    active = () => profileActive(value),
  ) => {
    const [selected, appearance] = await Promise.all([
      readSnapshot<string>(value, "chart-selection"),
      readSnapshot<"dark" | "light">(value, "theme"),
    ]);
    if (!active()) return;
    setSymbol(selected?.value || "");
    setTheme(appearance?.value || "dark");
  };
  const refresh = useCallback(async () => {
    if (signingOut.current) return;
    setBusy(false);
    setChecking(true);
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
      if (token !== generation.current || controller.signal.aborted) return;
      const result = await api("/session", undefined, controller.signal);
      if (token !== generation.current) return;
      setCsrf(result.csrf);
      const value = profileFor(window.location.origin, result.subject);
      setProfile(value);
      setState("online");
      try {
        await rememberProfile(value.origin, value.subject, value);
        await restore(
          value,
          () => token === generation.current && profileActive(value),
        );
      } catch {
        if (token === generation.current)
          report("本机存储不可用，当前更改可能无法记住");
      }
    } catch (error) {
      if (token !== generation.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        invalidateProfile(window.location.origin);
        setCsrf("");
        setProfile(undefined);
        setState("login");
        if (!loginVisible.current) setPassword("");
      } else {
        setState("offline");
        // Watch and Data show cached/offline status inline. Keep their headers
        // clear of duplicate notices for background network failures.
        if (loginVisible.current) {
          setLoginError({
            message:
              error instanceof TypeError
                ? "请检查网络和服务器地址，然后重试。"
                : errorMessage(error),
          });
        } else if (!(
          error instanceof TypeError && cachedPageHasProfile.current
        ))
          report(String(error));
      }
    } finally {
      if (token === generation.current) setChecking(false);
    }
  }, [report]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const previous = await lastProfile(window.location.origin);
        if (active && previous) {
          setProfile(previous);
          await restore(previous, () => active && profileActive(previous));
        }
      } catch {
        if (active) report("本机缓存暂不可用");
      }
      if (active) void refresh();
    })();
    const expire = () => {
      if (signingOut.current) return;
      invalidateProfile(window.location.origin);
      ++generation.current;
      session.current?.abort();
      setCsrf("");
      setProfile(undefined);
      setState("login");
      setPassword("");
      setChartOpened(false);
      setBusy(false);
      setChecking(false);
      setLoginIntent(undefined);
      setLoginError(undefined);
    };
    const foreground = () => {
      if (!document.hidden) void refresh();
    };
    const offline = () => {
      if (loginVisible.current || signingOut.current) return;
      // Invalidate an in-flight session response so it cannot restore a false
      // online state after the OS has reported loss of connectivity.
      ++generation.current;
      session.current?.abort();
      setState((current) => current === "online" ? "offline" : current);
      setChecking(false);
    };
    addEventListener("mw-session-expired", expire);
    addEventListener("online", refresh);
    addEventListener("offline", offline);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      ++generation.current;
      session.current?.abort();
      removeEventListener("mw-session-expired", expire);
      removeEventListener("online", refresh);
      removeEventListener("offline", offline);
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
      if (event.defaultPrevented || document.querySelector(MOBILE_OVERLAYS))
        return;
      event.preventDefault();
      if (password) {
        if (!busy && !checking) setLoginIntent("discard");
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
  }, [
    location.pathname,
    password,
    busy,
    checking,
    flush,
    shell,
    report,
    navigate,
  ]);
  async function logout() {
    if (signingOut.current) return;
    signingOut.current = true;
    const token = ++generation.current;
    session.current?.abort();
    notices.runtime.pause();
    setRecords(false);
    setProfile(undefined);
    setPassword("");
    setLoginError(undefined);
    setLoginIntent(undefined);
    setChecking(false);
    setSymbol("");
    setChartOpened(false);
    setState("login");
    setBusy(true);
    sessionAllowed.current = false;
    await clearOrigin(window.location.origin).catch(() =>
      report("本机缓存清理失败，请在系统设置清除此站点数据"),
    );
    // Keep CSRF until the request is constructed, even when local contents are removed first.
    try {
      await api("/logout", {}, AbortSignal.timeout(10000));
      report("已退出；服务器告警继续运行");
    } catch {
      report("本机内容已清除，服务端会话撤销未确认；服务器告警继续运行");
    }
    signingOut.current = false;
    if (token !== generation.current) return;
    setBusy(false);
    setCsrf("");
    shell.clearCookies();
    navigate("/", { replace: true });
  }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || checking) return;
    setBusy(true);
    setLoginError(undefined);
    const token = ++generation.current,
      controller = new AbortController();
    session.current?.abort();
    session.current = controller;
    try {
      const result = await api("/login", { password }, controller.signal);
      if (token !== generation.current || controller.signal.aborted) return;
      setCsrf(result.csrf);
      setPassword("");
      sessionAllowed.current = true;
      await allowSession(
        window.location.origin,
        profileFor(window.location.origin, result.subject),
      ).catch(() => report("本机登录状态未记住"));
      if (token !== generation.current || controller.signal.aborted) return;
      setBusy(false);
      await refresh();
    } catch (error) {
      if (token === generation.current && !controller.signal.aborted) {
        setLoginError({
          password: error instanceof ApiError && error.status === 401,
          message:
            error instanceof ApiError && error.status === 401
              ? "密码不正确，请重新输入。"
              : error instanceof TypeError
                ? "请检查网络和服务器地址，输入的密码已保留。"
                : errorMessage(error),
        });
      }
    } finally {
      if (token === generation.current && !controller.signal.aborted)
        setBusy(false);
    }
  }
  async function select(row: Series, timeframe?: string) {
    if (!profile || !row.ticker) return;
    await flush();
    const resolution = timeframe && ({ M1: "1", M5: "5", M15: "15", M30: "30", H1: "60", H4: "240", D1: "1D", W1: "1W", MN: "1M" } as Record<string, string>)[timeframe];
    setChartTarget(resolution ? { symbol: row.ticker, resolution, token: Date.now() } : undefined);
    setSymbol(row.ticker);
    navigate("/chart");
    await writeSnapshot(profile, "chart-selection", row.ticker).catch(() =>
      report("本次品种选择未记住"),
    );
  }
  return (
    <div
      className="mobile-app"
      data-theme={theme}
      data-page={location.pathname === "/" ? "watch" : undefined}
    >
      <a className="sr-only" href="#mobile-main">
        跳至主要内容
      </a>
      <main id="mobile-main">
        {state === "login" || !profile ? (
          <LoginPage
            password={password}
            changePassword={(value) => {
              setPassword(value);
              setLoginError(undefined);
            }}
            busy={busy}
            checking={checking || state === "loading"}
            error={loginError || (shell.error ? {message:shell.error} : undefined)}
            intent={loginIntent}
            setIntent={setLoginIntent}
            submit={login}
            reconnect={() => {
              setLoginError(undefined);
              void refresh();
            }}
            configure={async () => {
              await logout();
                        if (window.MWMobileHost) shell.configure();
            }}
          />
        ) : (
          <>
            {profile &&
              state === "online" &&
              connection &&
              symbol &&
              (chartOpened || location.pathname === "/chart") && (
                <MobileChart
                  ref={chart}
                  profile={profile}
                  connection={connection}
                  preparation={preparation!}
                  symbol={symbol}
                  target={chartTarget}
                  theme={theme}
                  rememberSymbol={(ticker) => {
                    setSymbol(ticker);
                    void writeSnapshot(
                      profile,
                      "chart-selection",
                      ticker,
                    ).catch(() => report("本次品种选择未记住"));
                  }}
                  visible={location.pathname === "/chart"}
                  report={scopedReports["图表"]}
                />
              )}
            {location.pathname === "/chart" && state !== "online" && (
              <ChartEmpty
                offline
                title="等待连接图表"
                action={
                  <Button disabled={checking} onClick={() => void refresh()}>
                    {checking ? "正在连接…" : "重新连接"}
                  </Button>
                }
              >
                上次图表设置已保留，连接核验后加载专业图表。
              </ChartEmpty>
            )}
            {location.pathname === "/chart" &&
              state === "online" &&
              !symbol && (
                <ChartEmpty
                  title="选择要查看的品种"
                  action={
                    <>
                      <Button onClick={() => navigate("/")}>前往自选</Button>
                      <Button variant="ghost" onClick={() => navigate("/data")}>
                        查看自建行情
                        <ChevronRight data-icon="inline-end" aria-hidden="true" />
                      </Button>
                    </>
                  }
                >
                  从自选或自建行情中选择。
                </ChartEmpty>
              )}
            {profile && (
              <WatchPage
                firstSymbol={setFirstWatchSymbol}
                profile={profile}
                online={state === "online"}
                connection={connection}
                visible={location.pathname === "/"}
                report={scopedReports["自选"]}
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
                report={scopedReports["数据"]}
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
                openChart={(ticker, frame) => void select({ ticker }, frame).catch(error => report(String(error)))}
                createToken={createAlert}
                runtime={notices.runtime}
                records={records}
                showRecords={() => setRecords(true)}
                closeRecords={() => setRecords(false)}
                report={scopedReports["告警"]}
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
                report={scopedReports["更多"]}
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
        <nav ref={navigation} className="mobile-nav" aria-label="主导航">
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
              <span className="mobile-nav-icon">
                <Icon aria-hidden="true" />
                {location.pathname === "/" &&
                  path === "/alerts" &&
                  Boolean(notices.state.alertUnread) && (
                    <small
                      className="mobile-watch-nav-count"
                      aria-label={`${notices.state.alertUnread} 条未处理告警`}
                    >
                      {notices.state.alertUnread}
                    </small>
                  )}
              </span>
              <span>
                {label}
                {location.pathname !== "/" &&
                  path === "/alerts" &&
                  Boolean(notices.state.alertUnread) && (
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
