import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronRight,
  History,
  Info,
  LogOut,
  Moon,
  Wifi,
  Download,
} from "lucide-react";
import { api, errorMessage } from "../api";
import type { MobileMarket } from "./market";
import type { MarketTransportState } from "../advanced/providerSubscriptions";
import { stamp } from "./RecordsSheet";
import MobileSheet from "./MobileSheet";
import type { useMobileShell } from "./shell";

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
    <button className="mobile-setting-row" onClick={onClick}>
      <span>
        {icon}
        {label}
      </span>
      <small>{value}</small>
      <ChevronRight aria-hidden="true" />
    </button>
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
  const [health, setHealth] = useState<any>(),
    [transport, setTransport] = useState<MarketTransportState>(),
    [readAt, setReadAt] = useState<number>();
  const [version, setVersion] = useState("");
  const [panel, setPanel] = useState<
    "connection" | "notifications" | "about" | "update"
  >();
  useEffect(() => connection?.observe(setTransport), [connection]);
  async function refresh() {
    if (!online) {
      report("连接核验后可读取服务状态");
      return;
    }
    try {
      const value = await api("/health");
      setHealth(value);
      setReadAt(Date.now());
    } catch (error) {
      report(errorMessage(error));
    }
  }
  useEffect(() => {
    void refresh();
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
  return (
    <section className="mobile-content mobile-more">
      <div className="mobile-profile">
        <span className="mobile-profile-mark" aria-hidden="true">
          W
        </span>
        <div>
          <strong>我的守望</strong>
          <small>个人工作区 · {shell.info ? "Android" : "手机浏览器"}</small>
        </div>
      </div>
      <section className="mobile-setting-group">
        <h2>行情与数据</h2>
        <div>
          <Setting
            icon={<Wifi aria-hidden="true" />}
            label="连接状态"
            value={online ? "已核验" : "待确认"}
            onClick={() => setPanel("connection")}
          />
        </div>
      </section>
      <section className="mobile-setting-group">
        <h2>通知与显示</h2>
        <div>
          <Setting
            icon={<Bell aria-hidden="true" />}
            label="后台通知"
            value={
              health?.ntfy_configured ? "ntfy" : health ? "待配置" : "待确认"
            }
            onClick={() => setPanel("notifications")}
          />
          <Setting
            icon={<History aria-hidden="true" />}
            label="告警记录"
            value="触发与异常"
            onClick={records}
          />
          <Setting
            icon={<Moon aria-hidden="true" />}
            label="显示主题"
            value={theme === "dark" ? "深色" : "浅色"}
            onClick={setTheme}
          />
        </div>
      </section>
      <section className="mobile-setting-group">
        <h2>账户与应用</h2>
        <div>
          <Setting
            icon={<Download aria-hidden="true" />}
            label="检查更新"
            value={shell.info?.appVersion || "网页与应用"}
            onClick={() => setPanel("update")}
          />
          <Setting
            icon={<Info aria-hidden="true" />}
            label="关于守望"
            value="版本与使用说明"
            onClick={() => setPanel("about")}
          />
          <Setting
            icon={<LogOut aria-hidden="true" />}
            label="退出登录"
            onClick={() => void logout()}
          />
        </div>
      </section>
      {panel && (
        <MobileSheet
          title={
            {
              connection: "连接状态",
              notifications: "后台通知",
              about: "关于守望",
              update: "检查更新",
            }[panel]
          }
          close={() => setPanel(undefined)}
        >
          {panel === "update" && (
            <>
              <p>当前应用：{shell.info?.appVersion || "手机浏览器"}</p>
              <p>网页构建：{version || "正在读取…"}</p>
              <p role="status">
                {shell.appUpdate?.label ||
                  "手动检查新版应用和网页，保留当前服务器设置与本机数据。"}
              </p>
              <button
                className="primary"
                disabled={
                  shell.appUpdate?.status === "checking" ||
                  shell.appUpdate?.status === "downloading"
                }
                onClick={() =>
                  void shell
                    .checkUpdates()
                    .catch((error) => report(errorMessage(error)))
                }
              >
                {shell.appUpdate?.status === "checking"
                  ? "正在检查…"
                  : "检查更新"}
              </button>
              {shell.update && (
                <button
                  onClick={() =>
                    void shell
                      .apply()
                      .catch((error) => report(errorMessage(error)))
                  }
                >
                  应用网页更新
                </button>
              )}
              {shell.appUpdate?.status === "unsupported" &&
                window.MWMobileHost && (
                  <p>本次请使用提供的安装包覆盖安装，无需卸载。</p>
                )}
            </>
          )}
          {panel === "connection" && (
            <>
              <p>{window.location.origin}</p>
              <p>{online ? "会话已核验" : "上次内容，连接尚未核验"}</p>
              <p>行情 SSE：{sse}</p>
              <p>
                最近心跳 {online ? stamp(transport?.heartbeatAt) : "待确认"}
              </p>
              <button onClick={() => void refresh()}>刷新服务状态</button>
              <button
                onClick={() => {
                  if (confirm("换服务器将清除本机内容，服务器告警继续运行。"))
                    void logout().then(() => shell.configure());
                }}
              >
                换服务器
              </button>
            </>
          )}
          {panel === "notifications" && (
            <>
              <p>
                服务器持续检测，退出 App 不停止规则。手机后台提醒由 ntfy 提供。
              </p>
              <p>
                {health
                  ? health.ntfy_configured
                    ? "ntfy 已配置"
                    : "ntfy 尚未配置"
                  : "ntfy 配置待确认"}{" "}
                ·{" "}
                {health?.delivery_enabled
                  ? "服务器投递已启用"
                  : "投递未确认启用"}
              </p>
              {readAt && <p>最近核验 {stamp(readAt)}</p>}
              <p>
                推送服务接受不代表手机送达。请在 ntfy 开启即时投递，并在 ColorOS
                允许通知和后台运行；锁屏实收需实际检查。
              </p>
              {health?.last_notification_test && (
                <p>
                  服务器最近通知测试：{health.last_notification_test.status} ·{" "}
                  {stamp(health.last_notification_test.at)}
                </p>
              )}
              <button
                onClick={() => {
                  setPanel(undefined);
                  records();
                }}
              >
                通知与事件记录
              </button>
            </>
          )}
          {panel === "about" && (
            <dl className="mobile-facts">
              <div>
                <dt>App</dt>
                <dd>{shell.info?.appVersion || "手机浏览器"}</dd>
              </div>
              <div>
                <dt>WebView</dt>
                <dd>{shell.info?.webViewVersion || navigator.userAgent}</dd>
              </div>
              <div>
                <dt>网页构建</dt>
                <dd>{version || "版本待读取"}</dd>
              </div>
              <div>
                <dt>服务器版本</dt>
                <dd>{health?.version || "服务器未提供版本标识"}</dd>
              </div>
            </dl>
          )}
        </MobileSheet>
      )}
    </section>
  );
}
