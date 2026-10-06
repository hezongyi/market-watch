import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, date, type Bar } from "./api";
import Chart from "./Chart";

const qualityNames: Record<string, string> = {
  healthy: "行情正常",
  unavailable: "主行情不可用",
  recovering: "恢复与预热中",
  not_tradeable: "来源暂停交易",
  stale: "报价已陈旧",
  degraded: "完成柱迟到或确认失败",
};
type Dataset = {
  id: string;
  instrument_id: string;
  logical_symbol: string;
  precision: number;
  identity: {
    source: string;
    environment: string;
    channel: string;
    basis: string;
    calendar_version: string;
  };
};
type Live = {
  dataset_id: string;
  instrument_id: string;
  logical_symbol: string;
  precision: number;
  quality: string;
  last_confirmed_m1: number;
  recovery_ready: boolean;
  quote_ready: boolean;
  candle_ready: boolean;
  connection_epoch: number;
  quote?: {
    bid: string | null;
    ask: string | null;
    source_time: number;
    received_at: number;
    tradeable: boolean;
  };
  forming?: Bar;
  quote_age_ms: number | null;
  calendar_verified: boolean;
  alert_readiness: {
    watch_id: string;
    reason: string | null;
    status: string;
  }[];
};
type Version = {
  id: string;
  dataset_id: string;
  start: number;
  end: number;
  cursor: number;
  status: string;
  error: string | null;
  manifest?: { rows: number; unknown_minutes: number; checksum: string };
};

export default function MarketDataPage() {
  const [datasets, setDatasets] = useState<Dataset[]>([]),
    [versions, setVersions] = useState<Version[]>([]);
  const [live, setLive] = useState<Live[]>([]),
    [connected, setConnected] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(""),
    [bars, setBars] = useState<Bar[]>([]);
  const [historyDataset, setHistoryDataset] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [level, setLevel] = useState(""),
    [timeframe, setTimeframe] = useState("M1");
  const generation = useRef(0);
  const client = useRef(`md-${crypto.randomUUID()}`);
  async function load() {
    const [d, v] = await Promise.all([
      api<Dataset[]>("/market-data/datasets"),
      api<Version[]>("/market-data/versions"),
    ]);
    setDatasets(d);
    setVersions(v);
  }
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    async function poll() {
      try {
        const [d, v] = await Promise.all([
          api<Dataset[]>("/market-data/datasets", undefined, abort.signal),
          api<Version[]>("/market-data/versions", undefined, abort.signal),
        ]);
        if (active) {
          setDatasets(d);
          setVersions(v);
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    }
    void poll();
    const timer = setInterval(poll, 10000);
    let stream: EventSource | null = null;
    let received = Date.now();
    const heartbeat = () => {
      received = Date.now();
      if (active) setConnected(true);
    };
    const connect = () => {
      stream?.close();
      received = Date.now();
      stream = new EventSource("/api/market-data/live/events");
      stream.addEventListener("heartbeat", heartbeat);
      stream.addEventListener("snapshot", (event) => {
        if (active) {
          setLive(JSON.parse((event as MessageEvent).data));
          heartbeat();
        }
      });
      stream.onerror = () => {
        if (active) setConnected(false);
      };
    };
    const offline = () => {
      stream?.close();
      setConnected(false);
    };
    window.addEventListener("online", connect);
    window.addEventListener("offline", offline);
    connect();
    const watchdog = setInterval(() => {
      if (Date.now() - received > 15000) {
        setConnected(false);
        if (navigator.onLine) connect();
      }
    }, 1000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
      clearInterval(watchdog);
      stream?.close();
      window.removeEventListener("online", connect);
      window.removeEventListener("offline", offline);
    };
  }, []);
  const current =
    live.find((row) => row.dataset_id === selected) ??
    live.find((row) => row.logical_symbol === "EURUSD") ??
    live[0];
  useEffect(() => {
    const dataset = selected || current?.dataset_id;
    if (!dataset) return;
    const abort = new AbortController();
    const renew = () =>
      api(
        "/market-data/live/demand",
        { client: client.current, dataset_id: dataset },
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
  }, [selected, current?.dataset_id]);
  useEffect(() => {
    if (!current) return;
    const ident = current.instrument_id;
    const g = ++generation.current;
    setBars([]);
    const abort = new AbortController();
    async function read() {
      try {
        const rows = await api<Bar[]>(
          `/candles?instrument=${encodeURIComponent(ident)}&timeframe=M1&limit=120`,
          undefined,
          abort.signal,
        );
        if (g === generation.current) setBars(rows);
      } catch (e) {
        if (g === generation.current && !abort.signal.aborted)
          setError(String(e));
      }
    }
    void read();
    const timer = setInterval(read, 5000);
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
    };
  }, [current?.instrument_id]);
  const history = datasets.filter(
    (row) =>
      row.identity.source === "dukascopy" && row.identity.channel === "python",
  );
  async function createVersion(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/market-data/versions", {
        dataset_id: historyDataset,
        start: new Date(start).getTime(),
        end: new Date(end).getTime(),
      });
      await load();
      setNotice("导入任务已创建，截止时间已固定。完成后可选择该版本进行演练。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function createWatch(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/watches", {
        instrument_id: current.instrument_id,
        name: `${current.logical_symbol} 价格穿越`,
        kind: "price",
        timeframe,
        level,
        direction: "both",
        use_history: true,
      });
      setNotice("同源监控已创建，可在行情与监控查看。数据缺失时将暂停判断。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const chartBars = [...bars];
  if (
    bars.length > 0 &&
    connected &&
    current?.forming?.start &&
    current.forming.start > (bars.at(-1)?.start ?? 0)
  )
    chartBars.push({ ...current.forming, revision: 1 });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MARKET DATA</span>
          <h1>行情来源与历史版本</h1>
          <p>
            当前实时使用 OANDA practice；外汇与黄金历史演练使用独立的 Dukascopy
            数据集。
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              void load().catch((e) => setError(String(e)));
            }}
          >
            刷新
          </button>
        </div>
      )}
      {notice && (
        <p className="panel" role="status">
          {notice}
        </p>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>实时行情 · Practice</h2>
          <span role="status">
            {connected ? "浏览器订阅已连接" : "浏览器订阅断开，正在重连"}
          </span>
        </div>
        {!live.length ? (
          <p className="muted">
            尚无实时采集结果。等待后台账户目录与共享采集启动。
          </p>
        ) : (
          <>
            <div className="replay-controls">
              <label>
                品种
                <select
                  value={selected || current?.dataset_id || ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {datasets
                    .filter(
                      (row) =>
                        row.identity.source === "oanda" &&
                        row.identity.environment === "practice",
                    )
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.logical_symbol} · OANDA practice
                      </option>
                    ))}
                </select>
              </label>
              <strong>
                {selected && !live.some((row) => row.dataset_id === selected)
                  ? "正在订阅所选品种"
                  : connected
                    ? (qualityNames[current?.quality] ?? current?.quality)
                    : "页面报价暂停更新"}
              </strong>
            </div>
            {current && (
              <>
                <dl className="market-data-facts">
                  <div>
                    <dt>Bid / Ask</dt>
                    <dd>
                      {current.quote?.bid ?? "—"} / {current.quote?.ask ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>源更新时间</dt>
                    <dd>
                      {current.quote?.source_time
                        ? date(current.quote.source_time)
                        : "尚无报价"}
                    </dd>
                  </div>
                  <div>
                    <dt>最后确认 M1</dt>
                    <dd>
                      {current.last_confirmed_m1
                        ? date(current.last_confirmed_m1)
                        : "等待完成柱"}
                    </dd>
                  </div>
                  <div>
                    <dt>完成柱恢复</dt>
                    <dd>
                      {current.candle_ready ? "最近完成柱已恢复" : "正在补齐"}
                    </dd>
                  </div>
                </dl>
                <p className="muted">
                  临时柱来自采样报价，极值可能不完整，成交量未知；完成柱由 REST
                  确认。日历：{current.calendar_verified ? "已核实" : "待核实"}
                  。备用尚未接入。
                </p>
                {current.alert_readiness.some((row) => row.reason) && (
                  <p role="status">
                    部分监控仍等待完整数据：
                    {current.alert_readiness
                      .filter((row) => row.reason)
                      .map((row) => row.reason)
                      .join("；")}
                  </p>
                )}
                {chartBars.length ? (
                  <Chart
                    key={current.dataset_id}
                    bars={chartBars}
                    precision={current.precision}
                  />
                ) : (
                  <p className="muted">等待已确认分钟数据。</p>
                )}
                <form className="replay-controls" onSubmit={createWatch}>
                  <label>
                    价格阈值
                    <input
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                    />
                  </label>
                  <label>
                    判断周期
                    <select
                      value={timeframe}
                      onChange={(e) => setTimeframe(e.target.value)}
                    >
                      <option value="M1">M1 收盘</option>
                      <option value="tick">实时采样报价</option>
                    </select>
                  </label>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !connected ||
                      (!!selected && selected !== current.dataset_id) ||
                      (timeframe === "tick"
                        ? !current.quote_ready
                        : !current.candle_ready)
                    }
                  >
                    创建价格穿越监控
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Dukascopy 历史导入</h2>
        </div>
        {!history.length ? (
          <p className="muted">
            尚未注册历史数据集。后台验证品种精度与日历规则后，可创建导入版本。
          </p>
        ) : (
          <form className="replay-controls" onSubmit={createVersion}>
            <label>
              历史品种
              <select
                required
                value={historyDataset}
                onChange={(e) => setHistoryDataset(e.target.value)}
              >
                <option value="">选择历史数据集</option>
                {history.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.logical_symbol} · Dukascopy BID
                  </option>
                ))}
              </select>
            </label>
            <label>
              开始时间（本地）
              <input
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              截止时间（本地）
              <input
                type="datetime-local"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              创建历史版本
            </button>
          </form>
        )}
        <p className="muted">
          每个版本保留原始观测与内容校验。未知区间不会由实时源补平；后续修订发布新版本。
        </p>
        <div className="market-data-versions">
          {versions.map((version) => (
            <article key={version.id}>
              <strong>
                {datasets.find((row) => row.id === version.dataset_id)
                  ?.logical_symbol ?? "历史数据集"}
              </strong>
              <p>
                {date(version.start)} — {date(version.end)}
              </p>
              <p>
                状态：{version.status} · 查询进度{" "}
                {Math.floor(
                  ((version.cursor - version.start) /
                    (version.end - version.start)) *
                    100,
                )}
                %
              </p>
              {version.error && <p role="status">等待重试：{version.error}</p>}
              {version.manifest?.rows !== undefined && (
                <p>
                  已观测 {version.manifest.rows.toLocaleString()} 根，未知{" "}
                  {version.manifest.unknown_minutes.toLocaleString()} 分钟
                </p>
              )}
              {version.status === "published" && (
                <NavLink
                  className="text-button"
                  to={`/replay?dataset_version=${encodeURIComponent(version.id)}`}
                >
                  选择此版本演练
                </NavLink>
              )}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
