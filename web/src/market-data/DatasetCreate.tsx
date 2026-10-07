import { centerReturn } from "./navigation";
import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { frames, names, phase, time, type Dataset } from "./types";
import { useSnapshot } from "./useSnapshot";
import { Feedback, Pager } from "./Center";

type CatalogItem = {
  catalog_id: string;
  provider_symbol: string;
  logical_symbol: string;
  label: string;
  asset_class: string;
  precision: number | null;
  precision_status: string;
};

export function DatasetCreate() {
  const [params] = useSearchParams(),
    navigate = useNavigate();
  const [step, setStep] = useState(1),
    [source, setSource] = useState(params.get("source") || "dukascopy");
  const [symbol, setSymbol] = useState(params.get("symbol") || ""),
    [logical, setLogical] = useState("");
  const [asset, setAsset] = useState("forex"),
    [calendar, setCalendar] = useState("ny17");
  const [precision, setPrecision] = useState(params.get("precision") || ""),
    [day, setDay] = useState("");
  const [periods, setPeriods] = useState(["M1", "H4", "D1"]),
    [frequency, setFrequency] = useState("daily");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef(crypto.randomUUID());
  const errorBox = useRef<HTMLDivElement>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string,string>>({});
  const [uncertain, setUncertain] = useState(false);
  const pendingBody = useRef<any>(null);
  const needsLookup = useRef(false);
  function fail(message: string, fields: Record<string,string> = {}) {
    setError(message); setFieldErrors(fields);
    requestAnimationFrame(() => errorBox.current?.focus());
  }
  function fieldProps(id: string) {
    return {id, "aria-invalid": !!fieldErrors[id], "aria-describedby": fieldErrors[id] ? `${id}-error` : undefined};
  }
  function fieldError(id: string) {
    return fieldErrors[id] ? <small id={`${id}-error`} className="error">{fieldErrors[id]}</small> : null;
  }
  // Resolve dates on the backend using the selected aggregation calendar. A
  // browser's local timezone must not reinterpret a NY17 trading date.
  const [boundary, setBoundary] = useState<number | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogPage, setCatalogPage] = useState(1),
    [catalogRefresh, setCatalogRefresh] = useState(0);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const catalog = useSnapshot<{
    items: CatalogItem[];
    total: number;
    requires_refresh: boolean;
  }>(
    step === 1
      ? `/market-data/history-catalog?source=${source}&query=${encodeURIComponent(catalogQuery)}&page=${catalogPage}&page_size=10`
      : null,
    catalogRefresh,
  );
  function choose(item: CatalogItem) {
    setSelected(item);
    setSymbol(item.provider_symbol);
    setLogical(item.logical_symbol);
    changeAsset(item.asset_class);
    setPrecision(item.precision == null ? "" : String(item.precision));
  }
  async function refreshCatalog() {
    setBusy(true);
    setError("");
    try {
      await api("/market-data/history-catalog/refresh", {});
      setCatalogRefresh((v) => v + 1);
    } catch (e) {
      fail(String(e));
    } finally {
      setBusy(false);
    }
  }
  function changeAsset(value: string) {
    setAsset(value);
    setCalendar(
      value === "crypto"
        ? "utc0"
        : ["forex", "metal"].includes(value)
          ? "ny17"
          : "",
    );
    setBoundary(null);
  }
  async function next() {
    setError("");
    setFieldErrors({});
    const invalid: Record<string,string> = {};
    if (step === 1) {
      if (!/^[A-Z0-9]{1,10}$/.test(logical)) invalid["create-logical"] = "填写1–10位大写字母或数字的逻辑品种。";
      if (!/^[A-Za-z0-9/_.-]{1,64}$/.test(symbol)) invalid["create-symbol"] = "填写准确来源代码。";
      if (!/^(?:[0-9]|10)$/.test(precision)) invalid["create-precision"] = "填写0–10的小数位数。";
    }
    if (step === 2) {
      if (!day) invalid["create-day"] = "选择起始交易日期。";
      if (!calendar) invalid["create-calendar"] = "明确选择聚合日界。";
    }
    if (Object.keys(invalid).length) { fail("请修正以下字段后继续。", invalid); return; }
    if (step === 2) {
      setBusy(true);
      try {
        const value = await api<{ start: number }>(
          `/market-data/date-boundary?date=${day}&calendar=${calendar}`,
        );
        setBoundary(value.start);
        setStep(3);
      } catch (e) {
        fail(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setStep(step + 1);
  }
  async function submit() {
    if (boundary === null) return;
    setBusy(true); setError(""); setFieldErrors({});
    const body = pendingBody.current || {
      request_id: request.current,
      dataset: {source, logical_symbol: logical, provider_symbol: symbol, asset_class: asset,
        precision: Number(precision), aggregation_calendar: calendar,
        ...(selected ? {catalog_id: selected.catalog_id} : {})},
      maintenance: {target_start: boundary, timeframes: periods, frequency, timezone: "UTC", daily_minute: 15},
    };
    const lookup = async () => {
      const query = new URLSearchParams({source: body.dataset.source,
        provider_symbol: body.dataset.provider_symbol, asset_class: body.dataset.asset_class,
        aggregation_calendar: body.dataset.aggregation_calendar});
      return api<{found: boolean; dataset?: Dataset}>(`/market-data/center/creations/${body.request_id}?${query}`);
    };
    try {
      // An unknown outcome pins the exact submitted body. Reconcile using a
      // read before permitting another POST with the same idempotency key.
      if (needsLookup.current) {
        const known = await lookup();
        if (known.found && known.dataset) { navigate(`/market-data/datasets/${known.dataset.id}`); return; }
        needsLookup.current = false; setUncertain(false);
      }
      pendingBody.current = body;
      try {
        const result = await api<{dataset: Dataset}>("/market-data/center/datasets", body);
        navigate(`/market-data/datasets/${result.dataset.id}`);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          pendingBody.current = null; fail(String(e)); return;
        }
        needsLookup.current = true; setUncertain(true);
        try {
          const known = await lookup();
          if (known.found && known.dataset) { navigate(`/market-data/datasets/${known.dataset.id}`); return; }
          fail("尚未查到创建结果。再次操作会先核查，再使用同一提交标识重试。");
        } catch { fail("创建结果暂无法核实，请核查创建结果后继续；已保留本次提交内容。"); }
      }
    } catch (e) { fail("创建结果核查失败，请稍后重试。" + String(e)); }
    finally { setBusy(false); }
  }
  return (
    <section className="data-center dc-form">
      <Link to={centerReturn(params)}>返回自建行情</Link>
      <h1>添加自建行情</h1>
      <ol className="dc-steps" aria-label="创建步骤">
        {["选择来源品种", "配置历史", "核对并创建"].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? "step" : undefined}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      {error && (
        <div ref={errorBox} tabIndex={-1} role="alert" className="error">
          <p>{error}</p>
          {Object.keys(fieldErrors).length > 0 && <ul>{Object.entries(fieldErrors).map(([id,message]) =>
            <li key={id}><a href={`#${id}`} onClick={e => {e.preventDefault(); document.getElementById(id)?.focus();}}>{message}</a></li>)}</ul>}
        </div>
      )}
      {step === 1 && (
        <div className="dc-fields">
          <label>
            来源
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setSelected(null);
                setLogical("");
                setSymbol("");
                setCatalogPage(1);
                setCatalogQuery("");
              }}
            >
              <option value="dukascopy">Dukascopy</option>
              <option value="oanda">OANDA Practice</option>
            </select>
          </label>
          <label>
            搜索来源目录
            <input
              value={catalogQuery}
              onChange={(e) => {
                setCatalogQuery(e.target.value);
                setCatalogPage(1);
              }}
              placeholder="来源代码或品种名称"
            />
          </label>
          {source === "oanda" && (
            <button disabled={busy} onClick={() => void refreshCatalog()}>
              刷新当前账户目录
            </button>
          )}
          <Feedback
            error={catalog.error}
            loading={catalog.loading}
            empty={!catalog.data}
          />
          {catalog.data && (
            <>
              {catalog.data.items.length > 0 ? (
                <div className="dc-table">
                  <table>
                    <caption>可选择的来源品种；实际M1覆盖在维护时核实</caption>
                    <thead>
                      <tr>
                        <th>准确来源代码</th>
                        <th>类别与精度</th>
                        <th>选择</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.data.items.map((item) => (
                        <tr key={item.provider_symbol}>
                          <td>
                            {item.provider_symbol}
                            <span>{item.label}</span>
                          </td>
                          <td>
                            {(
                              {
                                forex: "外汇",
                                metal: "金属",
                                crypto: "加密",
                                index: "指数",
                                other: "其他",
                              } as Record<string, string>
                            )[item.asset_class] || item.asset_class}{" "}
                            ·{" "}
                            {item.precision == null
                              ? "精度待填写"
                              : `${item.precision}位小数`}
                          </td>
                          <td>
                            <button
                              aria-pressed={
                                selected?.provider_symbol ===
                                item.provider_symbol
                              }
                              onClick={() => choose(item)}
                            >
                              选择 {item.provider_symbol}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>
                  {catalog.data.requires_refresh
                    ? "尚无当前账户目录，请主动刷新，或在下方手工登记。"
                    : "未找到品种；可调整搜索或手工登记。"}
                </p>
              )}
              <Pager
                total={catalog.data.total}
                page={catalogPage}
                size={10}
                change={setCatalogPage}
              />
            </>
          )}
          <label>
            逻辑品种
            <input {...fieldProps("create-logical")}
              value={logical}
              readOnly={selected !== null}
              onChange={(e) => setLogical(e.target.value.toUpperCase())}
              placeholder="例如 EURUSD"
              maxLength={10}
            />
          {fieldError("create-logical")}
          </label>
          <label>
            准确来源代码
            <input {...fieldProps("create-symbol")}
              value={symbol}
              readOnly={selected !== null}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder={source === "oanda" ? "例如 EUR_USD" : "例如 EUR/USD"}
            />
          {fieldError("create-symbol")}
          </label>
          <label>
            资产类别
            <select
              value={asset}
              disabled={selected !== null}
              onChange={(e) => changeAsset(e.target.value)}
            >
              <option value="forex">外汇</option>
              <option value="metal">金属</option>
              <option value="crypto">加密</option>
              <option value="index">指数</option>
              <option value="other">其他</option>
            </select>
          </label>
          {selected && (
            <button onClick={() => setSelected(null)}>改为手工登记</button>
          )}
          <details open={selected?.precision === null || !!fieldErrors["create-precision"] || undefined}>
            <summary>高级登记：价格精度</summary>
            <label>
              小数位数
              <input {...fieldProps("create-precision")}
                type="number"
                min={0}
                max={10}
                value={precision}
                readOnly={selected?.precision != null}
                onChange={(e) => setPrecision(e.target.value)}
              />
            {fieldError("create-precision")}
          </label>
            <p>
              {selected?.precision != null
                ? "精度来自当前账户目录，准确代码与类别已带入。"
                : "目录不足或手工登记时需明确精度；真实下载时校验，不能据此认定来源已可用。"}
            </p>
          </details>
          <p>
            原始 M1 · Bid。OANDA 使用后端配置的 Practice
            账户；凭据不会保存到公开数据集信息。
          </p>
        </div>
      )}
      {step === 2 && (
        <div className="dc-fields">
          <label>
            起始交易日期
            <input {...fieldProps("create-day")}
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                setBoundary(null);
              }}
            />
          {fieldError("create-day")}
          </label>
          <label>
            聚合日界
            <select {...fieldProps("create-calendar")}
              value={calendar}
              onChange={(e) => {
                setCalendar(e.target.value);
                setBoundary(null);
              }}
            >
              <option value="">请选择日界</option>
              <option value="ny17">纽约当地 17:00（随夏令时）</option>
              <option value="utc0">UTC 00:00</option>
            </select>
          {fieldError("create-calendar")}
          </label>
          <p>
            {calendar === "ny17"
              ? "交易日期从前一天纽约当地 17:00 开始。"
              : calendar === "utc0" ? "交易日期从当日 UTC 00:00 开始。" : "请明确选择聚合日界，以确定起始时刻。"}
            任务固定创建时的历史截止点。
          </p>
          <fieldset>
            <legend>需要的周期</legend>
            <div className="dc-checks">
              {frames.map((frame) => (
                <label key={frame}>
                  <input
                    type="checkbox"
                    checked={periods.includes(frame)}
                    disabled={frame === "M1"}
                    onChange={(e) =>
                      setPeriods(
                        e.target.checked
                          ? [...periods, frame]
                          : periods.filter((p) => p !== frame),
                      )
                    }
                  />
                  {frame}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            维护计划
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
            >
              <option value="daily">每日 00:15 UTC</option>
              <option value="once">仅本次维护</option>
            </select>
          </label>
        </div>
      )}
      {step === 3 && (
        <div className="dc-review">
          <h2>
            {logical} · {names[source]} · Bid · {phase(calendar)}
          </h2>
          <p>
            准确代码：{symbol}；精度：{precision} 位
          </p>
          <p>
            起始日期：{day}，对应 {time(boundary)}
          </p>
          <p>
            周期：{periods.join(" · ")}；维护：
            {frequency === "daily" ? "每日 00:15 UTC" : "一次性"}
          </p>
          <p>
            后台下载、校验并派生各周期。提交成功后可离开页面；组合在首次实际使用时建立。
          </p>
        </div>
      )}
      <div className="dc-actions">
        {step > 1 && (
          <button disabled={busy || uncertain} onClick={() => {pendingBody.current = null; setStep(step - 1);}}>
            上一步
          </button>
        )}
        <Link to={uncertain ? `/market-data?tab=tasks&query=${encodeURIComponent(logical)}` : centerReturn(params)}>{uncertain ? "返回列表核查" : "取消"}</Link>
        {step < 3 ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void next()}
          >
            {busy ? "核对中…" : "下一步"}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "正在核查与提交…" : uncertain ? "核查创建结果并重试" : "创建并开始维护"}
          </button>
        )}
      </div>
    </section>
  );
}
