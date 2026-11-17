import NotificationSettings from "./NotificationSettings";
import { useLocation } from "react-router-dom";
import LogsSheet from "./LogsSheet";
import { setLogVersions } from "./logs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  History,
  Info,
  LogOut,
  Moon,
  Sun,
  Wifi,
  Download,
  ScrollText,
} from "lucide-react";
import { api, errorMessage } from "../api";
import type { MobileMarket } from "./market";
import type { MarketTransportState } from "../advanced/providerSubscriptions";
import MobileSheet from "./MobileSheet";
import { MobileOverlaysProvider, MobileConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import type { useMobileShell } from "./shell";

type Panel = "connection" | "notifications" | "about" | "update";
const titles: Record<Panel, string> = {
  connection: "连接状态",
  notifications: "后台通知",
  about: "关于守望",
  update: "检查更新",
};

function MoreTime({ value }: { value: unknown }) {
  if (typeof value !== "number" || !value) return <>尚无记录</>;
  const date = new Date(value);
  return (
    <time className="more-time" dateTime={date.toISOString()}>
      <span>
        {date.toLocaleDateString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })}
      </span>
      <span>{date.toLocaleTimeString("zh-CN", { hour12: false })}</span>
    </time>
  );
}

function Setting({
  icon,
  label,
  value,
  toggle,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  toggle?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      variant="ghost"
      className="mobile-setting-row"
      aria-pressed={toggle}
      aria-haspopup={toggle === undefined ? "dialog" : undefined}
      onClick={onClick}
    >
      <span className="more-setting-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="more-setting-label">{label}</span>
      {value && <small>{value}</small>}
      {toggle === undefined ? (
        <ChevronRight data-icon="inline-end" aria-hidden="true" />
      ) : (
        <span className="more-setting-tail" aria-hidden="true" />
      )}
    </Button>
  );
}

export default function MorePage({
  online,
  theme,
  setTheme,
  connection,
  shell,
  records,
  logout,
  report,
}: {
  online: boolean;
  theme: string;
  setTheme(): void;
  connection?: MobileMarket;
  shell: ReturnType<typeof useMobileShell>;
  records(): void;
  logout(): Promise<void>;
  report(message: string): void;
}) {
  const [notificationDirty, setNotificationDirty] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [updateError, setUpdateError] = useState("");
  const pendingLogRecords = useRef(false);
  const [health, setHealth] = useState<any>();
  const [transport, setTransport] = useState<MarketTransportState>();
  const [readAt, setReadAt] = useState<number>();
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState("");
  const location = useLocation();
  const [panel, setPanel] = useState<Panel | undefined>(() => new URLSearchParams(location.search).get("panel") === "notifications" ? "notifications" : undefined);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("panel") === "notifications") setPanel("notifications");
  }, [location.key]);
  const [switchServer, setSwitchServer] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const pendingRecords = useRef(false);
  useEffect(() => connection?.observe(setTransport), [connection]);
  async function refresh() {
    if (!online) {
      report("连接核验后可读取服务状态");
      return;
    }
    if (refreshing) return;
    setRefreshing(true);
    setConnectionError("");
    try {
      setHealth(await api("/health"));
      setReadAt(Date.now());
    } catch (error) {
      setConnectionError(errorMessage(error));
      report(errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    if (online) void refresh();
  }, [online]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/m/shell-manifest.json", { signal: controller.signal })
      .then((response) => response.json())
      .then((value) => {
        if (!controller.signal.aborted) {
          setVersion(value.version || "");
          setLogVersions(value.version, shell.info?.appVersion);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const sse = !online
    ? "等待连接"
    : transport?.state === "open"
      ? "已连接"
      : transport?.state === "error"
        ? "正在重连"
        : "无活跃连接";
  const updateBusy =
    shell.appUpdate?.status === "checking" ||
    shell.appUpdate?.status === "downloading";
  const notificationState = !health
    ? "待核验"
    : !health.ntfy_configured
      ? "未配置"
      : health.delivery_enabled
        ? "已启用"
        : "未启用";
  return (
    <section
      className="mobile-content mobile-more mobile-controls"
      aria-label="更多设置"
    >
      <MobileOverlaysProvider>
        <header className="mobile-profile more-title">
          <span className="mobile-profile-mark" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
          </span>
          <h1>我的守望</h1>
        </header>
        <section className="mobile-setting-group" aria-labelledby="more-market">
          <h2 id="more-market">服务与通知</h2>
          <div>
            <Setting
              icon={<Wifi />}
              label="连接状态"
              value={sse}
              onClick={() => setPanel("connection")}
            />
            <Setting
              icon={<Bell />}
              label="后台通知"
              value={notificationState}
              onClick={() => setPanel("notifications")}
            />
            <Setting
              icon={<History />}
              label="告警记录"
              value="触发与异常"
              onClick={records}
            />
          </div>
        </section>
        <section className="mobile-setting-group" aria-labelledby="more-app">
          <h2 id="more-app">应用</h2>
          <div>
            <Setting
              icon={theme === "dark" ? <Moon /> : <Sun />}
              label="显示主题"
              value={theme === "dark" ? "深色" : "浅色"}
              toggle={theme === "dark"}
              onClick={setTheme}
            />
            <Setting
              icon={<ScrollText />}
              label="日志"
              value="操作与异常"
              onClick={() => setLogsOpen(true)}
            />
            <Setting
              icon={<Download />}
              label="检查更新"
              value={
                shell.update
                  ? "有网页更新"
                  : updateBusy
                    ? shell.appUpdate?.status === "downloading"
                      ? "下载中"
                      : "检查中"
                    : shell.info?.appVersion || "网页与应用"
              }
              onClick={() => {
                setUpdateError("");
                setPanel("update");
              }}
            />
            <Setting
              icon={<Info />}
              label="关于守望"
              value="版本信息"
              onClick={() => setPanel("about")}
            />
          </div>
        </section>
        <Button
          variant="ghost"
          className="more-logout"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void logout().catch((error) => {
              setLeaving(false);
              report(errorMessage(error));
            });
          }}
        >
          <LogOut data-icon="inline-start" aria-hidden="true" />
          {leaving ? "正在退出…" : "退出登录"}
        </Button>
        <LogsSheet
          open={logsOpen}
          close={() => setLogsOpen(false)}
          records={() => {
            pendingLogRecords.current = true;
            setLogsOpen(false);
          }}
          onClosed={() => {
            if (pendingLogRecords.current) {
              pendingLogRecords.current = false;
              records();
            }
          }}
        />
        <MobileSheet
          open={Boolean(panel)}
          dirty={panel === "notifications" && notificationDirty}
          dismissible={!notificationBusy}
          title={panel ? titles[panel] : "设置"}
          close={() => setPanel(undefined)}
          onClosed={() => {
            if (pendingRecords.current) {
              pendingRecords.current = false;
              records();
            }
          }}
        >
          {panel === "update" && (
            <div className="more-panel">
              <dl className="mobile-facts more-facts">
                <div>
                  <dt>当前应用</dt>
                  <dd>{shell.info?.appVersion || "手机浏览器"}</dd>
                </div>
                <div>
                  <dt>网页构建</dt>
                  <dd className="more-version">{version || "正在读取…"}</dd>
                </div>
              </dl>
              <p className="more-description" role="status">
                {shell.appUpdate?.label ||
                  "检查应用和网页更新，保留服务器设置与本机数据。"}
              </p>
              {(updateError || shell.error) && (
                <p className="mobile-inline-error" role="alert">
                  {updateError || shell.error}
                </p>
              )}
              <div className="mobile-sheet-actions more-panel-actions">
                <Button
                  disabled={updateBusy}
                  onClick={() => {
                    setUpdateError("");
                    void shell.checkUpdates().catch((error) => {
                      setUpdateError(errorMessage(error));
                      report(errorMessage(error));
                    });
                  }}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />
                  {shell.appUpdate?.status === "checking"
                    ? "正在检查…"
                    : shell.appUpdate?.status === "downloading"
                      ? "正在下载…"
                      : "检查更新"}
                </Button>
                {shell.update && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setUpdateError("");
                      void shell.apply().catch((error) => {
                        setUpdateError(errorMessage(error));
                        report(errorMessage(error));
                      });
                    }}
                  >
                    应用网页更新
                  </Button>
                )}
              </div>
              {shell.appUpdate?.status === "unsupported" &&
                window.MWMobileHost && (
                  <p className="more-description">
                    请使用安装包覆盖安装，无需卸载。
                  </p>
                )}
            </div>
          )}
          {panel === "connection" && (
            <div className="more-panel">
              <div className="more-connection-state" role="status">
                <span
                  data-connected={
                    (online && transport?.state === "open") || undefined
                  }
                  aria-hidden="true"
                />
                <strong>{sse}</strong>
                <small>行情连接</small>
              </div>
              {connectionError && (
                <p className="mobile-inline-error" role="alert">
                  {connectionError}
                </p>
              )}
              <dl className="mobile-facts more-facts">
                <div className="more-fact-wide">
                  <dt>服务器</dt>
                  <dd>{window.location.origin}</dd>
                </div>
                <div>
                  <dt>会话</dt>
                  <dd>{online ? "已核验" : "连接尚未核验"}</dd>
                </div>
                <div>
                  <dt>最近心跳</dt>
                  <dd>
                    {online ? (
                      <MoreTime value={transport?.heartbeatAt} />
                    ) : (
                      "待确认"
                    )}
                  </dd>
                </div>
              </dl>
              <div className="mobile-sheet-actions more-panel-actions">
                <Button
                  variant="outline"
                  disabled={!online || refreshing}
                  onClick={() => void refresh()}
                >
                  {refreshing ? "正在刷新…" : "刷新服务状态"}
                </Button>
                <Button variant="ghost" onClick={() => setSwitchServer(true)}>
                  换服务器
                </Button>
              </div>
            </div>
          )}
          {panel === "notifications" && <NotificationSettings
            online={online}
            state={(dirty, busy) => { setNotificationDirty(dirty); setNotificationBusy(busy); }}
            changed={() => void refresh()}
            records={() => { pendingRecords.current = true; setPanel(undefined); }}
          />}
          {panel === "about" && (
            <div className="more-panel">
              <dl className="mobile-facts more-facts">
                <div>
                  <dt>App</dt>
                  <dd>{shell.info?.appVersion || "手机浏览器"}</dd>
                </div>
                <div>
                  <dt>网页构建</dt>
                  <dd className="more-version">{version || "版本待读取"}</dd>
                </div>
                <div>
                  <dt>服务器版本</dt>
                  <dd>{health?.version || "服务器未提供版本标识"}</dd>
                </div>
              </dl>
              <Collapsible className="more-environment">
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="more-environment-trigger"
                    />
                  }
                >
                  运行环境
                  <ChevronDown data-icon="inline-end" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <dl className="mobile-facts more-facts">
                    <div>
                      <dt>客户端</dt>
                      <dd>{shell.info ? "Android" : "手机浏览器"}</dd>
                    </div>
                    <div className="more-fact-wide">
                      <dt>{shell.info ? "WebView" : "浏览器"}</dt>
                      <dd>
                        {shell.info?.webViewVersion || navigator.userAgent}
                      </dd>
                    </div>
                  </dl>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </MobileSheet>
        {switchServer && (
          <MobileConfirm
            title="切换服务器？"
            description="将退出当前账户并清除本机内容，服务器告警继续运行。"
            actionLabel="切换服务器"
            destructive
            onClose={() => setSwitchServer(false)}
            onAccept={() => {
              setSwitchServer(false);
              void logout()
                .then(() => shell.configure())
                .catch((error) => {
                  setConnectionError(errorMessage(error));
                  report(errorMessage(error));
                });
            }}
          />
        )}
      </MobileOverlaysProvider>
    </section>
  );
}
