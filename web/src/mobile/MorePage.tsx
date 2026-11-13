import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronRight,
  History,
  Info,
  LogOut,
  Moon,
  Sun,
  Wifi,
  Download,
} from "lucide-react";
import { api, errorMessage } from "../api";
import type { MobileMarket } from "./market";
import type { MarketTransportState } from "../advanced/providerSubscriptions";
import { stamp } from "./RecordsSheet";
import MobileSheet from "./MobileSheet";
import { MobileOverlaysProvider, MobileConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import type { useMobileShell } from "./shell";

type Panel = "connection" | "notifications" | "about" | "update";
const titles: Record<Panel, string> = {
  connection: "连接状态",
  notifications: "后台通知",
  about: "关于守望",
  update: "检查更新",
};

function Setting({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  onClick(): void;
}) {
  return (
    <Button variant="ghost" className="mobile-setting-row" onClick={onClick}>
      <span className="more-setting-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="more-setting-label">{label}</span>
      {value && <small>{value}</small>}
      <ChevronRight data-icon="inline-end" aria-hidden="true" />
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
  const [health, setHealth] = useState<any>();
  const [transport, setTransport] = useState<MarketTransportState>();
  const [readAt, setReadAt] = useState<number>();
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState("");
  const [panel, setPanel] = useState<Panel>();
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
    try {
      setHealth(await api("/health"));
      setReadAt(Date.now());
    } catch (error) {
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
        if (!controller.signal.aborted) setVersion(value.version || "");
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
  return (
    <section
      className="mobile-content mobile-more mobile-controls"
      aria-label="更多设置"
    >
      <MobileOverlaysProvider>
        <header className="mobile-profile">
          <span className="mobile-profile-mark" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
          </span>
          <div>
            <h1>我的守望</h1>
            <small>个人工作区</small>
          </div>
          <span className="more-device">
            {shell.info ? "Android" : "手机浏览器"}
          </span>
        </header>
        <section className="mobile-setting-group" aria-labelledby="more-market">
          <h2 id="more-market">行情与数据</h2>
          <div>
            <Setting
              icon={<Wifi />}
              label="连接状态"
              value={sse}
              onClick={() => setPanel("connection")}
            />
          </div>
        </section>
        <section
          className="mobile-setting-group"
          aria-labelledby="more-notifications"
        >
          <h2 id="more-notifications">通知与显示</h2>
          <div>
            <Setting
              icon={<Bell />}
              label="后台通知"
              value={
                health?.ntfy_configured
                  ? "ntfy 已配置"
                  : health
                    ? "待配置"
                    : "待确认"
              }
              onClick={() => setPanel("notifications")}
            />
            <Setting
              icon={<History />}
              label="告警记录"
              value="触发与异常"
              onClick={records}
            />
            <Setting
              icon={theme === "dark" ? <Moon /> : <Sun />}
              label="显示主题"
              value={theme === "dark" ? "深色" : "浅色"}
              onClick={setTheme}
            />
          </div>
        </section>
        <section className="mobile-setting-group" aria-labelledby="more-app">
          <h2 id="more-app">应用</h2>
          <div>
            <Setting
              icon={<Download />}
              label="检查更新"
              value={shell.info?.appVersion || "网页与应用"}
              onClick={() => setPanel("update")}
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
        <MobileSheet
          open={Boolean(panel)}
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
                  <dd>{version || "正在读取…"}</dd>
                </div>
              </dl>
              <p className="more-description" role="status">
                {shell.appUpdate?.label ||
                  "检查应用和网页更新，保留服务器设置与本机数据。"}
              </p>
              <div className="mobile-sheet-actions more-panel-actions">
                <Button
                  disabled={updateBusy}
                  onClick={() =>
                    void shell
                      .checkUpdates()
                      .catch((error) => report(errorMessage(error)))
                  }
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
                    onClick={() =>
                      void shell
                        .apply()
                        .catch((error) => report(errorMessage(error)))
                    }
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
              <dl className="mobile-facts more-facts">
                <div>
                  <dt>服务器</dt>
                  <dd>{window.location.origin}</dd>
                </div>
                <div>
                  <dt>会话</dt>
                  <dd>{online ? "已核验" : "连接尚未核验"}</dd>
                </div>
                <div>
                  <dt>行情连接</dt>
                  <dd>{sse}</dd>
                </div>
                <div>
                  <dt>最近心跳</dt>
                  <dd>{online ? stamp(transport?.heartbeatAt) : "待确认"}</dd>
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
          {panel === "notifications" && (
            <div className="more-panel">
              <p className="more-description">
                服务器持续检测，退出 App 不停止规则。手机后台提醒由 ntfy 提供。
              </p>
              <dl className="mobile-facts more-facts">
                <div>
                  <dt>推送配置</dt>
                  <dd>
                    {health
                      ? health.ntfy_configured
                        ? "ntfy 已配置"
                        : "ntfy 尚未配置"
                      : "待确认"}
                  </dd>
                </div>
                <div>
                  <dt>服务器投递</dt>
                  <dd>{health?.delivery_enabled ? "已启用" : "未确认启用"}</dd>
                </div>
                {readAt && (
                  <div>
                    <dt>最近核验</dt>
                    <dd>{stamp(readAt)}</dd>
                  </div>
                )}
                {health?.last_notification_test && (
                  <div>
                    <dt>最近测试</dt>
                    <dd>
                      {health.last_notification_test.status}
                      <br />
                      {stamp(health.last_notification_test.at)}
                    </dd>
                  </div>
                )}
              </dl>
              <p className="more-description">
                请在 ntfy 开启即时投递，并在 ColorOS
                允许通知和后台运行。推送服务接受不代表手机送达，锁屏实收需实际检查。
              </p>
              <div className="mobile-sheet-actions more-panel-actions">
                <Button
                  variant="outline"
                  onClick={() => {
                    pendingRecords.current = true;
                    setPanel(undefined);
                  }}
                >
                  通知与事件记录
                </Button>
              </div>
            </div>
          )}
          {panel === "about" && (
            <dl className="mobile-facts more-facts">
              <div>
                <dt>App</dt>
                <dd>{shell.info?.appVersion || "手机浏览器"}</dd>
              </div>
              <div>
                <dt>网页构建</dt>
                <dd>{version || "版本待读取"}</dd>
              </div>
              <div>
                <dt>服务器版本</dt>
                <dd>{health?.version || "服务器未提供版本标识"}</dd>
              </div>
              <div>
                <dt>WebView</dt>
                <dd>{shell.info?.webViewVersion || navigator.userAgent}</dd>
              </div>
            </dl>
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
                .catch((error) => report(errorMessage(error)));
            }}
          />
        )}
      </MobileOverlaysProvider>
    </section>
  );
}
