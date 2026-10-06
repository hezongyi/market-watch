import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, type Bar } from "../api";
import Chart from "../Chart";
import { Feedback, Pager } from "./Center";
import { useSnapshot } from "./useSnapshot";
import { frames, names, phase, time, type Dataset, type Page } from "./types";

type Mapping = {
  id: string;
  current_account: boolean;
  target_identity: { provider_symbol: string; environment: string };
  match: any;
};
type Composite = {
  id: string;
  instrument_id: string;
  dataset_id: string;
  logical_symbol: string;
  precision: number;
  calendar: string;
  historical_source: string;
  status: string;
  active_revision_id: string;
  mapping: Mapping;
  revision: {
    history_version_id: string;
    history_start: number;
    seam: number;
    history_checksum: string;
  };
  preparation: {
    status: string;
    cursor: number;
    cutoff: number;
    confirmed_end: number;
    input_revision: number;
    error: string | null;
  };
  periods: {timeframe:string;status:string;applied_input_revision:number;input_revision:number;
    updated_at:number|null;error:string|null;next_at:number}[];
  usage: {
    charts: number;
    strategies: number;
    chart_alerts: number;
    total: number;
  };
  health: {
    connection: string;
    quote_ready: boolean;
    confirmed_tail_ready: boolean;
    quote_age_ms: number | null;
    strategy_readiness: string;
    rules?: {id:string;name:string;health:string;reason:string|null;revision_id:string;seam_policy:string}[];
  };
};
type Candidate = {
  dataset: Dataset;
  mappings: Mapping[];
  status: string;
  reason: string | null;
  recommended_mapping_id: string | null;
};
const statusNames: Record<string, string> = {
  needs_maintenance: "先维护M1历史",
  needs_mapping: "配置实时来源",
  ready_to_open: "可建立",
  preparing: "接续准备中",
  inactive: "未在采集",
  receiving: "确认尾部正常",
  recovering: "确认尾部恢复中",
  attention: "需处理",
  account_changed: "实时账户已改变",
  queried: "固定区间已查询",
};
const clientId = () => {
  const key = "market-watch-composite-chart-client";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `mc-${crypto.randomUUID()}`;
    sessionStorage.setItem(key, id);
  }
  return id;
};

export function CompositeList() {
  const [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const navigate = useNavigate(),
    client = useRef(clientId());
  const mode = params.get("view") === "candidates" ? "candidates" : "existing",
    query = params.get("query") || "",
    page = Math.max(1, Number(params.get("page")) || 1);
  const result = useSnapshot<Page<Composite | Candidate>>(
    `/market-data/center/${mode === "candidates" ? "composite-candidates" : "composites"}?query=${encodeURIComponent(query)}&page=${page}`,
    refresh,
  );
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key !== "page") next.delete("page");
    setParams(next);
  }
  async function open(dataset: string, mapping: string) {
    setBusy(true);
    setError("");
    try {
      const row = await api<Composite>("/market-data/composites/use", {
        dataset_id: dataset,
        mapping_id: mapping,
        client: client.current,
      });
      navigate(`/market-data/composites/${row.id}?section=chart`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="dc-filters">
        <button
          aria-pressed={mode === "existing"}
          onClick={() => filter("view", "existing")}
        >
          已建立组合
        </button>
        <button
          aria-pressed={mode === "candidates"}
          onClick={() => filter("view", "candidates")}
        >
          可建立候选
        </button>
        <label>
          搜索品种
          <input
            value={query}
            onChange={(e) => filter("query", e.target.value)}
          />
        </label>
        <button onClick={() => setRefresh((v) => v + 1)}>刷新</button>
      </div>
      <p>
        固定自建历史接续 OANDA Practice
        确认M1及实时观察，供策略与人工交易辅助使用。浏览此列表不会启动采集。
      </p>
      <Feedback
        error={result.error || error}
        loading={result.loading}
        empty={!result.data}
      />
      {result.data && (
        <>
          <p className="dc-subtle">
            快照：{time(result.at)}
            {result.error ? " · 刷新失败，实时健康未知" : ""}
          </p>
          {!result.data.items.length ? (
            <p>
              暂无符合筛选的条目。可切换到“可建立候选”配置已有自建历史的实时映射。
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>品种与来源</th>
                    <th>日界</th>
                    <th>历史基线 / 确认尾部（UTC）</th>
                    <th>需求与状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((item) => {
                    if ("dataset" in item) {
                      const row = item as Candidate,
                        d = row.dataset;
                      return (
                        <tr key={d.id}>
                          <td>
                            {d.logical_symbol}
                            <small>
                              {names[d.identity.source]} ·{" "}
                              {d.identity.provider_symbol} → OANDA Practice ·
                              Bid
                            </small>
                          </td>
                          <td>{phase(d.aggregation_calendar)}</td>
                          <td>
                            {time(d.available_start)} — {time(d.available_end)}
                          </td>
                          <td>
                            {statusNames[row.status]}
                            {row.reason && <small>{row.reason}</small>}
                          </td>
                          <td>
                            <div className="dc-actions">
                              {row.status === "needs_maintenance" ? (
                                <Link to={`/market-data/datasets/${d.id}`}>
                                  去维护
                                </Link>
                              ) : (
                                <Link
                                  to={`/market-data/datasets/${d.id}/mapping`}
                                >
                                  配置实时来源
                                </Link>
                              )}
                              {row.status === "ready_to_open" &&
                                row.recommended_mapping_id && (
                                  <button
                                    disabled={busy}
                                    onClick={() =>
                                      open(d.id, row.recommended_mapping_id!)
                                    }
                                  >
                                    打开组合行情
                                  </button>
                                )}
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    const row = item as Composite;
                    return (
                      <tr key={row.id}>
                        <td>
                          {row.logical_symbol}
                          <small>
                            {names[row.historical_source]} → OANDA Practice ·{" "}
                            {row.mapping.target_identity.provider_symbol} · Bid
                          </small>
                        </td>
                        <td>{phase(row.calendar)}</td>
                        <td>
                          基线 {time(row.revision.seam)}
                          <small>
                            确认至{" "}
                            {row.preparation.confirmed_end
                              ? time(row.preparation.confirmed_end)
                              : "尚无确认M1"}
                          </small>
                        </td>
                        <td>
                          {row.usage.total} 个需求 ·{" "}
                          {result.error ? "健康未知" : statusNames[row.status]}
                          <small>
                            {row.health.strategy_readiness === "no_strategies"
                              ? "暂无策略"
                              : row.health.strategy_readiness === "ready" ? "规则依赖就绪"
                              : "策略依赖待检查"}
                          </small>
                        </td>
                        <td>
                          <Link to={`/market-data/composites/${row.id}`}>
                            查看详情
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager
            total={result.data.total}
            page={page}
            size={25}
            change={(value) => filter("page", String(value))}
          />
        </>
      )}
    </>
  );
}

export function MappingForm() {
  const { id } = useParams(),
    navigate = useNavigate();
  const [targetQuery, setTargetQuery] = useState(""),
    [catalogPage, setCatalogPage] = useState(1),
    [catalogRefresh, setCatalogRefresh] = useState(0);
  const dataset = useSnapshot<Dataset>(`/market-data/center/datasets/${id}`),
    catalog = useSnapshot<Page<any> & { requires_refresh?: boolean }>(
      `/market-data/history-catalog?source=oanda&page_size=25&page=${catalogPage}&query=${encodeURIComponent(targetQuery)}`,
      catalogRefresh,
    );
  const [code, setCode] = useState(""),
    [underlying, setUnderlying] = useState(""),
    [currency, setCurrency] = useState("USD"),
    [historicalProduct, setHistoricalProduct] = useState("spot_fx"),
    [liveProduct, setLiveProduct] = useState("spot_fx"),
    [relationship, setRelationship] = useState("same_product"),
    [historicalEvidence, setHistoricalEvidence] = useState(""),
    [liveEvidence, setLiveEvidence] = useState(
      "https://developer.oanda.com/rest-live-v20/instrument-ep/",
    ),
    [rationale, setRationale] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const selected = catalog.data?.items.find((row) => row.catalog_id === code);
  const products = [
    ["spot_fx", "现货外汇"],
    ["spot_metal", "现货金属"],
    ["crypto", "加密资产"],
    ["index", "指数"],
    ["cfd", "差价合约"],
    ["future", "期货"],
    ["other", "其他"],
  ];
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/market-data/datasets/${id}/mappings`, {
        catalog_id: code,
        match: {
          underlying,
          quote_currency: currency,
          historical_product: historicalProduct,
          live_product: liveProduct,
          relationship,
          historical_evidence: historicalEvidence,
          live_evidence: liveEvidence,
          rationale,
          reviewed,
        },
      });
      navigate(
        `/market-data?tab=composite&view=candidates&query=${encodeURIComponent(dataset.data?.logical_symbol || "")}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="data-center">
      <Link to="/market-data?tab=composite&view=candidates">返回组合候选</Link>
      <h1>配置实时来源</h1>
      <Feedback
        error={dataset.error || catalog.error}
        loading={dataset.loading || catalog.loading}
        empty={!dataset.data || !catalog.data}
      />
      {dataset.data && (
        <>
          <p>
            {dataset.data.logical_symbol} ·{" "}
            {names[dataset.data.identity.source]} ·{" "}
            {dataset.data.identity.provider_symbol} · Bid ·{" "}
            {phase(dataset.data.aggregation_calendar)}
          </p>
          <p>
            保存明确映射版本，不创建组合或启动实时采集。同名代码不能证明不同来源产品等价。
          </p>
          {catalog.data?.requires_refresh && (
            <p>尚未读取当前账户的来源目录，请显式刷新。</p>
          )}
          <div className="dc-filters">
            <label>
              查找目标准确品种
              <input
                value={targetQuery}
                onChange={(e) => {
                  setTargetQuery(e.target.value);
                  setCatalogPage(1);
                }}
              />
            </label>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/market-data/history-catalog/refresh", {});
                  setCatalogRefresh((v) => v + 1);
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              刷新当前OANDA账户目录
            </button>
          </div>
          {catalog.data && (
            <Pager
              total={catalog.data.total}
              page={catalogPage}
              size={25}
              change={setCatalogPage}
            />
          )}
          <form onSubmit={save} className="dc-form">
            {error && (
              <p ref={errorRef} tabIndex={-1} role="alert" className="error">
                {error}
              </p>
            )}
            <label>
              目标准确品种（OANDA Practice）
              <select
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              >
                <option value="">请选择当前账户品种</option>
                {catalog.data?.items.map((row) => (
                  <option key={row.catalog_id} value={row.catalog_id}>
                    {row.provider_symbol} · {row.label} · {row.asset_class}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <p>
                Practice · {selected.provider_symbol} · 来源精度{" "}
                {selected.precision} · Bid；未授权交易执行。
              </p>
            )}
            <label>
              标的代码
              <input
                required
                pattern="[A-Z0-9]{1,30}"
                value={underlying}
                onChange={(e) => setUnderlying(e.target.value.toUpperCase())}
              />
            </label>
            <label>
              报价币种
              <input
                required
                pattern="[A-Z]{3,8}"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </label>
            <label>
              历史产品类型
              <select
                value={historicalProduct}
                onChange={(e) => setHistoricalProduct(e.target.value)}
              >
                {products.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              实时产品类型
              <select
                value={liveProduct}
                onChange={(e) => setLiveProduct(e.target.value)}
              >
                {products.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              产品关系
              <select
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
              >
                <option value="same_product">相同产品</option>
                <option value="same_underlying_different_product">
                  相同标的、不同产品
                </option>
              </select>
            </label>
            <label>
              历史产品官方依据
              <input
                required
                type="url"
                value={historicalEvidence}
                onChange={(e) => setHistoricalEvidence(e.target.value)}
              />
            </label>
            <label>
              实时产品官方依据
              <input
                required
                type="url"
                value={liveEvidence}
                onChange={(e) => setLiveEvidence(e.target.value)}
              />
            </label>
            <label>
              匹配复核说明
              <textarea
                required
                minLength={10}
                maxLength={1000}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
            </label>
            <label>
              <input
                required
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              已核对标的、币种、产品类型及Bid口径，接受两来源原价差异。
            </label>
            <div className="dc-actions">
              <button className="primary" disabled={busy || !catalog.data}>
                保存映射版本
              </button>
              <Link to="/market-data?tab=composite&view=candidates">取消</Link>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

export function CompositeDetail() {
  const { id } = useParams(),
    [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState("");
  const client = useRef(clientId()),
    section = params.get("section") || "overview",
    frame = params.get("frame") || "M1",
    before = params.get("before");
  const result = useSnapshot<Composite>(
      `/market-data/composites/${id}`,
      refresh,
    ),
    row = result.data;
  const page = useSnapshot<{
    bars: Bar[];
    next_before: number | null;
    revision_id: string;
    input_revision: number;
    pending: string[];
  }>(
    row && section === "chart"
      ? `/market-data/composites/${id}/chart?timeframe=${frame}&count=300&provisional=true${before ? `&before=${before}` : ""}`
      : null,
    refresh,
  );
  const requests = useSnapshot<Page<any>>(
    row && section === "seam" ? `/market-data/composites/${id}/requests` : null,
    refresh,
  );
  useEffect(() => {
    if (!row || section !== "chart") return;
    const abort = new AbortController();
    const renew = () =>
      api(
        "/market-data/composites/use",
        {
          dataset_id: row.dataset_id,
          mapping_id: row.mapping.id,
          client: client.current,
        },
        abort.signal,
      ).catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    void renew();
    const timer = setInterval(renew, 60000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [row?.id, section]);
  function select(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key === "frame") next.delete("before");
    setParams(next);
  }
  return (
    <section className="data-center">
      <Link to="/market-data?tab=composite">返回组合行情</Link>
      <Feedback
        error={result.error || error}
        loading={result.loading}
        empty={!row}
      />
      {row && (
        <>
          <div className="dc-heading">
            <div>
              <h1>{row.logical_symbol} 组合行情</h1>
              <p>
                {names[row.historical_source]} → OANDA Practice · Bid ·{" "}
                {phase(row.calendar)}
              </p>
            </div>
            <button onClick={() => setRefresh((v) => v + 1)}>刷新</button>
          </div>
          <nav className="dc-tabs" aria-label="组合详情页签">
            {[
              ["overview", "概览"],
              ["chart", "打开组合图表"],
              ["seam", "接续与修订"],
              ["usage", "使用与健康"],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={section === key}
                onClick={() => select("section", key)}
              >
                {label}
              </button>
            ))}
          </nav>
          <p>
            {result.error
              ? "实时健康未知；以下为上次快照"
              : statusNames[row.status]}{" "}
            · 快照 {time(result.at)}
          </p>
          {section === "overview" && (
            <>
              <dl className="dc-facts">
                <div>
                  <dt>历史基线</dt>
                  <dd>
                    <Link
                      to={`/market-data/datasets/${row.dataset_id}?section=chart&version=${row.revision.history_version_id}`}
                    >
                      {time(row.revision.history_start)} —{" "}
                      {time(row.revision.seam)}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt>固定接续点 T</dt>
                  <dd>{time(row.revision.seam)}</dd>
                </div>
                <div>
                  <dt>最新确认M1结束</dt>
                  <dd>
                    {row.preparation.confirmed_end
                      ? time(row.preparation.confirmed_end)
                      : "尚无确认观测"}
                  </dd>
                </div>
                <div>
                  <dt>准备查询</dt>
                  <dd>
                    {statusNames[row.preparation.status] ||
                      names[row.preparation.status] ||
                      row.preparation.status}{" "}
                    · {time(row.preparation.cursor)} /{" "}
                    {time(row.preparation.cutoff)}
                  </dd>
                </div>
              </dl>
              <p>
                每日历史发布不会移动基线或接续点。查询完成不代表覆盖完整、指标预热完成或策略可以判断。
              </p>
              <h3>接续周期产物</h3>
              <div className="table-scroll dc-period-table" tabIndex={0} role="region" aria-label="接续周期产物滚动区"><table aria-label="接续周期产物">
                <thead><tr><th>周期</th><th>状态</th><th>已处理 / 当前输入</th><th>最近处理</th></tr></thead>
                <tbody>{row.periods.map(period=><tr key={period.timeframe}>
                  <td>{period.timeframe}</td>
                  <td>{({caught_up:"已处理当前输入",building:"正在派生",pending:"等待派生",retrying:"失败待重试"} as Record<string,string>)[period.status] || period.status}
                    {period.error && <> · {period.error} · 重试 {time(period.next_at)}</>}</td>
                  <td>{period.applied_input_revision<0?"尚未处理":period.applied_input_revision} / {period.input_revision}</td>
                  <td>{period.updated_at?time(period.updated_at):"尚无记录"}</td>
                </tr>)}</tbody>
              </table></div>
              <p>周期产物处理完成不代表覆盖完整或策略依赖已就绪。</p>
              <Link to={`/market-data/datasets/${row.dataset_id}/mapping`}>
                保存新的实时映射
              </Link>
            </>
          )}
          {section === "chart" && (
            <>
              <div className="dc-filters">
                <label>
                  周期
                  <select
                    aria-label="周期"
                    value={frame}
                    onChange={(e) => select("frame", e.target.value)}
                  >
                    {frames.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
                {before && (
                  <button
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.delete("before");
                      setParams(next);
                    }}
                  >
                    返回最新
                  </button>
                )}
                <button
                  disabled={!page.data?.next_before}
                  onClick={() =>
                    select("before", String(page.data?.next_before))
                  }
                >
                  更早历史
                </button>
              </div>
              <p>
                打开图表会维持临时行情需求，关闭后按租约和宽限释放。当前未确认分钟来自采样流。
              </p>
              <Feedback
                error={page.error}
                loading={page.loading}
                empty={!page.data}
              />
              {page.data?.pending.map((reason) => (
                <p key={reason} role="status">
                  {reason}
                </p>
              ))}
              {page.data && (
                <>
                  <details className="dc-source">
                    <summary>查看输入版本依据</summary>
                    <p>
                      固定组合修订 {page.data.revision_id} · 输入修订{" "}
                      {page.data.input_revision}
                    </p>
                  </details>
                  <Chart
                    key={`${id}-${frame}`}
                    bars={page.data.bars}
                    precision={row.precision}
                  />
                  <div className="table-scroll">
                    <table>
                      <caption>最近20根柱的确认、覆盖与接缝事实</caption>
                      <thead>
                        <tr>
                          <th>UTC起点</th>
                          <th>时间结束</th>
                          <th>来源确认</th>
                          <th>覆盖完整</th>
                          <th>接缝</th>
                          <th>量口径</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.data.bars.slice(-20).map((b: any) => (
                          <tr key={b.start}>
                            <td>{time(b.start)}</td>
                            <td>{b.time_closed ? "是" : "否"}</td>
                            <td>{b.source_confirmed ? "是" : "临时观察"}</td>
                            <td>
                              {b.coverage_complete
                                ? "是"
                                : `未知 ${b.unknown_minutes ?? "—"} 分钟`}
                            </td>
                            <td>
                              {b.seam_crossing
                                ? "跨接缝"
                                : b.seam_at_start
                                  ? "接续首柱"
                                  : "—"}
                            </td>
                            <td>
                              {b.mixed_source
                                ? "跨源总量为空"
                                : `${b.volume_kind} · ${b.volume_unit || "—"}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
          {section === "seam" && (
            <>
              <h2>固定分段归属</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>分段</th>
                      <th>来源</th>
                      <th>区间（UTC）</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>历史基线</td>
                      <td>{names[row.historical_source]}</td>
                      <td>
                        [{time(row.revision.history_start)},{" "}
                        {time(row.revision.seam)})
                      </td>
                    </tr>
                    <tr>
                      <td>确认尾部</td>
                      <td>
                        OANDA Practice ·{" "}
                        {row.mapping.target_identity.provider_symbol}
                      </td>
                      <td>[{time(row.revision.seam)}, 最新确认观测)</td>
                    </tr>
                    <tr>
                      <td>临时分钟</td>
                      <td>OANDA采样流</td>
                      <td>未确认分钟，缺失极值不可追认</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                价格不平均、不平移；跨源量不相加。最新确认结束时间不能证明中间无缺口。
              </p>
              <details>
                <summary>映射复核依据</summary>
                <p>{row.mapping.match.rationale}</p>
                <a
                  href={row.mapping.match.historical_evidence}
                  target="_blank"
                  rel="noreferrer"
                >
                  历史产品依据
                </a>{" "}
                ·{" "}
                <a
                  href={row.mapping.match.live_evidence}
                  target="_blank"
                  rel="noreferrer"
                >
                  实时产品依据
                </a>
              </details>
              <h2>补数请求记录</h2>
              <Feedback
                error={requests.error}
                loading={requests.loading}
                empty={!requests.data}
              />
              {requests.data && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>查询区间</th>
                        <th>读取方式</th>
                        <th>结果</th>
                        <th>观测根数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.data.items.map((r) => (
                        <tr key={r.id}>
                          <td>
                            {time(r.start)} — {time(r.end)}
                          </td>
                          <td>{r.read_kind}</td>
                          <td>
                            {r.result} · {r.accepted ? "已接纳" : "未接纳"}
                          </td>
                          <td>{r.observations ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {section === "usage" && (
            <>
              <dl className="dc-facts">
                <div>
                  <dt>图表租约</dt>
                  <dd>{row.usage.charts}</dd>
                </div>
                <div>
                  <dt>策略 / 图表预警</dt>
                  <dd>
                    {row.usage.strategies} / {row.usage.chart_alerts}
                  </dd>
                </div>
                <div>
                  <dt>报价新鲜</dt>
                  <dd>
                    {result.error
                      ? "未知"
                      : row.health.quote_ready
                        ? "可读"
                        : "未就绪"}
                  </dd>
                </div>
                <div>
                  <dt>确认尾部</dt>
                  <dd>
                    {result.error
                      ? "未知"
                      : row.health.confirmed_tail_ready
                        ? "来源恢复完成"
                        : "未就绪"}
                  </dd>
                </div>
              </dl>
              <p>
                {row.health.strategy_readiness === "no_strategies"
                  ? "暂无策略，不代表策略已就绪。"
                  : row.health.strategy_readiness === "ready" ? "当前规则依赖已验证。"
                  : "策略需要单独检查实际依赖与接缝政策。"}{" "}
                持久策略与预警会在浏览器关闭后维持共享采集。
              </p>
              {row.health.rules?.length ? <div className="dc-scroll dc-period-table" tabIndex={0} aria-label="组合规则依赖状态">
                <table><thead><tr><th>规则</th><th>状态 / 原因</th><th>固定修订</th><th>接缝政策</th></tr></thead>
                  <tbody>{row.health.rules.map(rule=><tr key={rule.id}><td>{rule.name}</td>
                    <td>{rule.health === "ready" ? "数据就绪" : rule.reason || "等待依赖"}</td>
                    <td>{rule.revision_id}</td><td>{rule.seam_policy === "accept_raw" ? "接受原价影响" : "等待同源依赖"}</td></tr>)}</tbody>
                </table></div> : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
