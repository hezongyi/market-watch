import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { MobileMarket } from "./market";
import type { MarketTransportState } from "../advanced/providerSubscriptions";
import { stamp } from "./RecordsSheet";

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
  shell: {
    info?: { appVersion?: string; webViewVersion?: string };
    configure(): void;
  };
  records(): void;
  logout(): Promise<void>;
  report(message: string): void;
}) {
  const [health, setHealth] = useState<any>(),
    [transport, setTransport] = useState<MarketTransportState>(),
    [readAt, setReadAt] = useState<number>();
  const [version, setVersion] = useState("");
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
  return (
    <section className="mobile-content">
      <h2>连接</h2>
      <p>{window.location.origin}</p>
      <p>{online ? "会话已核验" : "上次内容，连接尚未核验"}</p>
      <p>
        行情 SSE：
        {online
          ? transport?.state === "open"
            ? "已连接"
            : transport?.state === "error"
              ? "正在重连"
              : "无活跃连接"
          : "等待连接"}
      </p>
      <p>最近心跳 {online ? stamp(transport?.heartbeatAt) : "待确认"}</p>
      <button onClick={() => void refresh()}>刷新服务状态</button>
      <h2>后台通知</h2>
      <p>服务器持续检测，退出 App 不停止规则。手机后台提醒由 ntfy 提供。</p>
      {readAt && <p>最近核验 {stamp(readAt)}</p>}
      <p>
        {health
          ? health.ntfy_configured
            ? "ntfy 已配置"
            : "ntfy 尚未配置"
          : "ntfy 配置待确认"}{" "}
        · {health?.delivery_enabled ? "服务器投递已启用" : "投递未确认启用"}
      </p>
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
      <button onClick={records}>通知与事件记录</button>
      <h2>外观</h2>
      <button onClick={setTheme}>
        切换{theme === "dark" ? "浅色" : "深色"}
      </button>
      <h2>关于</h2>
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
  );
}
