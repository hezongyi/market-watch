import { DetailPanel, useDetailPanel } from "./DetailPanel";
import { Link } from "./router";
import { NativeSelect } from "./NativeControls";
import { OpenChart } from "./OpenChart";
import { centerLink } from "./navigation";
import { names, phase, time, type Dataset } from "./types";
import { useSearchParams } from "./router";
import { useState } from "react";
import {
  MarketListHeader,
  MarketListStatus,
  MarketTabs,
  useMarketRows,
} from "./MarketList";

const statuses = [
  ["all", "全部"],
  ["available", "可用"],
  ["preparing", "准备中"],
  ["attention", "需处理"],
  ["paused", "已暂停"],
  ["archived", "已归档"],
] as const;
export function ManagedMarket() {
  const [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0);
  const query = params.get("query") || "",
    status = params.get("status") || "all",
    source = params.get("source") || "",
    asset = params.get("asset_class") || "";
  const calendar = params.get("calendar") || "";
  const filters = new URLSearchParams({
    query,
    status,
    source,
    asset_class: asset,
    calendar,
  });
  const rows = useMarketRows<Dataset>(
    "/market-data/center/datasets",
    filters,
    refresh,
  );
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next, { replace: true });
  };
  return (
    <section className="data-center dc-market-page">
      <MarketListHeader
        title="自建行情"
        query={query}
        onQuery={(value) => change("query", value)}
        refresh={() => setRefresh((v) => v + 1)}
      >
        <Link
          className="primary dc-button"
          to={centerLink("/market-data/datasets/new", params)}
        >
          添加行情
        </Link>
      </MarketListHeader>
      <MarketTabs
        label="自建状态"
        value={status}
        items={statuses}
        change={(value) => change("status", value)}
      />
      <div className="dc-market-table-head">
        <span>品种与来源</span>
        <div className="dc-market-head-filters">
          <NativeSelect
            aria-label="来源"
            value={source}
            onChange={(event) => change("source", event.target.value)}
          >
            <option value="">全部来源</option>
            {Object.entries(names)
              .filter(([key]) =>
                ["dukascopy", "oanda", "fxcm", "binance", "yahoo"].includes(key),
              )
              .map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
          </NativeSelect>
          <NativeSelect
            aria-label="资产类别"
            value={asset}
            onChange={(event) => change("asset_class", event.target.value)}
          >
            <option value="">全部类别</option>
            <option value="forex">外汇</option>
            <option value="metal">金属</option>
            <option value="crypto">加密</option>
            <option value="index">指数</option>
            <option value="other">其他</option>
          </NativeSelect>
          <NativeSelect
            aria-label="聚合日界"
            value={calendar}
            onChange={(event) => change("calendar", event.target.value)}
          >
            <option value="">全部日界</option>
            <option value="ny17">NY17</option>
            <option value="utc0">UTC0</option>
          </NativeSelect>
        </div>
      </div>
      <div className="dc-market-list" ref={rows.list}>
        {rows.items.map((d) => (
          <ManagedRow key={d.id} dataset={d} params={params} />
        ))}
        <div ref={rows.sentinel}>
          <MarketListStatus
            loading={rows.loading}
            error={rows.error}
            count={rows.items.length}
            total={rows.total}
            retry={rows.retry}
          />
        </div>
      </div>
    </section>
  );
}
function ManagedRow({
  dataset: d,
  params,
}: {
  dataset: Dataset;
  params: URLSearchParams;
}) {
  const detail = useDetailPanel();
  const lifecycleStatus = d.maintenance.archived
    ? "已归档"
    : d.maintenance.paused
      ? "维护已暂停"
      : names[d.availability] || d.availability;
  const maintenanceStatus = d.maintenance.configured
    ? d.maintenance.paused
      ? "暂停定时维护"
      : d.maintenance.frequency === "daily"
        ? "每日维护"
        : "一次性维护"
    : "未配置维护";
  return (
    <article className="dc-market-row" id={`dataset-${d.id}`} tabIndex={-1}>
      <div className="dc-market-main">
        <button className="dc-symbol-button" onClick={detail.open}>
          {d.display_symbol || d.logical_symbol}
        </button>
        <span>
          {names[d.identity.source]} · {d.identity.basis} ·{" "}
          {phase(d.aggregation_calendar)}
        </span>
        <small>
          可用历史：
          {d.available_end
            ? `${time(d.available_start)} 至 ${time(d.available_end)}`
            : "尚未发布"}
        </small>
      </div>
      <span>
        {(
          {
            forex: "外汇",
            metal: "金属",
            crypto: "加密",
            index: "指数",
            other: "其他",
            unspecified: "未分类",
          } as Record<string, string>
        )[d.asset_class] || "未分类"}
      </span>
      <span>
        {names[d.availability] || d.availability}
        <small>
          {d.maintenance.configured
            ? d.maintenance.paused
              ? "维护已暂停"
              : d.maintenance.frequency === "daily"
                ? "每日维护"
                : "一次性维护"
            : "未配置维护"}
        </small>
      </span>
      <div className="dc-market-actions">
        {d.latest_version_id && d.usable_timeframes.length > 0 && (
          <OpenChart
            ticker={`MWH:${d.periods.find((p) => p.timeframe === d.usable_timeframes[0])?.available_version_id || d.latest_version_id}`}
            frame={d.usable_timeframes[0]}
            label="打开图表"
          />
        )}
        <button onClick={detail.open} aria-expanded={detail.opened}>
          查看详情
        </button>
      </div>
      {detail.opened && (
        <DetailPanel
          title={`${d.display_symbol || d.logical_symbol} · 自建行情`}
          close={detail.close}
        >
          <div className="dc-detail-summary">
            <div className="dc-detail-status-line">
              <span className={`dc-status-pill state-${d.maintenance.archived ? "archived" : d.maintenance.paused ? "paused" : d.availability}`}>
                {lifecycleStatus}
              </span>
              <span className="dc-detail-muted">{maintenanceStatus}</span>
            </div>
            <dl className="dc-detail-facts">
              <div><dt>来源</dt><dd>{names[d.identity.source]} · {d.identity.basis.toUpperCase()}</dd></div>
              <div><dt>聚合日界</dt><dd>{phase(d.aggregation_calendar)}</dd></div>
              <div><dt>可用历史</dt><dd>{d.available_end ? `${time(d.available_start)} 至 ${time(d.available_end)}` : "尚未发布"}</dd></div>
              <div><dt>可用周期</dt><dd>{d.usable_timeframes.join(" · ") || "尚无可用周期"}</dd></div>
              <div><dt>准确来源代码</dt><dd>{d.provider_display_symbol || d.identity.provider_symbol}</dd></div>
              {d.maintenance.frequency === "daily" && !d.maintenance.paused && d.maintenance.next_at != null && (
                <div><dt>下次维护</dt><dd>{time(d.maintenance.next_at)}</dd></div>
              )}
            </dl>
            {!!d.unknown_minutes && <p className="dc-detail-muted">未观测区间：{d.unknown_minutes} 分钟</p>}
            {d.maintenance.task_error && <p className="error">本次维护：{d.maintenance.task_error}</p>}
          </div>
          <div className="dc-detail-actions" aria-label="行情操作">
            {d.latest_version_id && d.usable_timeframes.length > 0 && <OpenChart
              ticker={`MWH:${d.periods.find(p => p.timeframe === d.usable_timeframes[0])?.available_version_id || d.latest_version_id}`}
              frame={d.usable_timeframes[0]} label="打开图表" />}
            <Link className="primary" to={centerLink(`/market-data/datasets/${d.id}`, params, `dataset-${d.id}`)}>管理行情</Link>
          </div>
          <div className="dc-detail-lifecycle">
            <h3>生命周期</h3>
            <p>暂停维护会保留已发布历史；归档会从默认列表隐藏；删除历史数据会回收价格内容，且不可逆。</p>
            <Link className="dc-danger-link" to={centerLink(`/market-data/datasets/${d.id}?section=references&view=delete`, params, `dataset-${d.id}`)}>删除历史数据</Link>
          </div>
        </DetailPanel>
      )}
    </article>
  );
}
