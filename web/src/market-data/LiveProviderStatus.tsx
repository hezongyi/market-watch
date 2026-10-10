import { useEffect, useState } from "react";
import { time } from "./types";
import { useSnapshot } from "./useSnapshot";

type Provider = {
  error: string | null;
  authentication_hold: boolean;
  next_probe_at: number | null;
};
type Live = {
  dataset_id: string;
  logical_symbol: string;
  quality: string;
  market_session: string;
  next_session_at: number | null;
  authentication_hold: boolean;
  connection_error: string | null;
};
const labels: Record<string, string> = {
  unauthorized: "OANDA 鉴权失败",
  provider_maintenance: "OANDA 上游维护中",
  market_closed: "市场已闭市",
  recovering: "恢复与预热中",
  healthy: "行情正常",
  unavailable: "行情连接暂不可用",
  not_tradeable: "来源暂停交易",
  stale: "报价已陈旧",
  degraded: "完成柱迟到或确认失败",
};

/** Reads stored status only. Viewing the data center never creates live demand. */
export function LiveProviderStatus() {
  const [expanded, setExpanded] = useState(() => !window.matchMedia("(max-height:650px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-height:650px)");
    const resize = () => setExpanded(!media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const snapshot = useSnapshot<{ provider: Provider; datasets: Live[] }>(
    "/market-data/live/status",
  );
  const provider = snapshot.data?.provider;
  const rows = snapshot.data?.datasets ?? [];
  const connected = !!snapshot.data && !snapshot.error;
  return (
    <details className="panel dc-live-provider-status" aria-label="OANDA Practice 实时状态" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>OANDA Practice 实时状态{provider?.error ? ` · ${labels[provider.error] ?? "连接暂不可用"}` : ""}</summary>
      <div role="status" aria-atomic="true">
        {!connected && <p>状态连接正在恢复；已有历史仍可查看。</p>}
        {provider?.error && (
          <p>
            {labels[provider.error] ?? "OANDA 连接暂不可用"}。
            {provider.authentication_hold &&
              "鉴权暂停需通过配置账户和报价接口校验后解除。"}
            {provider.next_probe_at &&
              `下次检查：${time(provider.next_probe_at)}。`}
          </p>
        )}
        {!rows.length && connected && !provider?.error && (
          <p>尚无实时采集结果，等待后台账户目录与共享采集启动。</p>
        )}
        {rows.map((row) => (
          <p key={row.dataset_id}>
            <strong>
              {row.logical_symbol} · {labels[row.quality] ?? row.quality}
            </strong>
            {row.market_session === "closed"
              ? `。已核实闭市，历史图表仍可查看${row.next_session_at ? `；下一时段检查：${time(row.next_session_at)}` : ""}。`
              : row.market_session === "unknown"
                ? "。当前来源时段尚未核实。"
                : "。处于已核实的常规交易时段。"}
            {row.connection_error === "provider_maintenance" &&
              "上游维护期间已降低检查频率。"}
            {row.authentication_hold && "鉴权暂停仍保留。"}
          </p>
        ))}
      </div>
    </details>
  );
}
