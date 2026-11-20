import type { PreviousDayPreset } from "./chartAlerts";

export function PreviousDayAlertNote({preset}: {preset: PreviousDayPreset}) {
  return <aside className="alert-preset-note" aria-label="前日高低模板说明">
    <span>已预填 · 参考交易日 {preset.reference_date}</span>
    <span>当日截止 {new Date(preset.day_end).toLocaleString("zh-CN",{hour12:false})} · 含最后一根 M5</span>
    {preset.outside && <span role="status">最近 M5 收盘已在区间外，回到区间后再次离开才触发。</span>}
  </aside>;
}
