import { useEffect, useRef, useState } from "react";
import {
  CreationCatalog,
  type CatalogItem,
  type CatalogFilters,
} from "./CreationCatalog";
import { NativeInput, NativeSelect } from "./NativeControls";
import { centerReturn } from "./navigation";
import { Link, useSearchParams, useDirtyForm, useActionLock } from "./router";
import { api, ApiError } from "./api";
import { frames, names, phase, time, type Dataset } from "./types";
import { OpenChart } from "./OpenChart";

type Check = {
  status:
    | "ready"
    | "existing"
    | "precision_required"
    | "connection_required"
    | "invalid";
  start: number | null;
  existing: Dataset | null;
  field?: string;
  message?: string;
};
type Result = { dataset: Dataset; task: { id: string; status: string } };
const assetNames: Record<string, string> = {
  forex: "外汇",
  metal: "金属",
  crypto: "加密",
  index: "指数",
  other: "其他",
};
const defaults: Record<string, string> = {
  forex: "ny17",
  metal: "ny17",
  crypto: "utc0",
};
export function DatasetCreate() {
  const [params] = useSearchParams();
  const initialSource = ["dukascopy", "oanda"].includes(
    params.get("source") || "",
  )
    ? params.get("source")!
    : "";
  const [step, setStep] = useState(1),
    [manual, setManual] = useState(false);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [catalogFilters, setCatalogFilters] = useState<CatalogFilters>({
    source: initialSource,
    query: "",
    asset: "",
  });
  const [source, setSource] = useState(initialSource || "dukascopy"),
    [symbol, setSymbol] = useState(""),
    [logical, setLogical] = useState("");
  const [asset, setAsset] = useState("forex"),
    [calendar, setCalendar] = useState("ny17"),
    [precision, setPrecision] = useState("");
  const [day, setDay] = useState(""),
    [periods, setPeriods] = useState(["M1", "H4", "D1"]),
    [frequency, setFrequency] = useState("daily");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false),
    [check, setCheck] = useState<{ key: string; value: Check } | null>(null),
    [checkError, setCheckError] = useState<{
      key: string;
      message: string;
    } | null>(null),
    [checkRevision, retryCheck] = useState(0);
  const [result, setResult] = useState<Result | null>(null),
    [uncertain, setUncertain] = useState(false),
    [prefilling, setPrefilling] = useState(!!params.get("symbol"));
  const request = useRef(crypto.randomUUID()),
    pendingBody = useRef<any>(null),
    needsLookup = useRef(false),
    actionLock = useActionLock();
  const errorBox = useRef<HTMLDivElement>(null),
    configHeading = useRef<HTMLHeadingElement>(null);
  const back = centerReturn(params),
    backLabel = back.includes("tab=platform") ? "返回平台行情" : "返回自建行情";
  const dataset = {
    source,
    logical_symbol: logical,
    provider_symbol: symbol,
    asset_class: asset,
    precision: /^(?:[0-9]|10)$/.test(precision) ? Number(precision) : null,
    aggregation_calendar: calendar || null,
    ...(selected ? { catalog_id: selected.catalog_id } : {}),
  };
  const signature = JSON.stringify({ ...dataset, start_date: day || null }),
    currentCheck = check?.key === signature ? check.value : null;
  const currentError =
    currentCheck?.status === "invalid"
      ? currentCheck.message || "请修正配置"
      : checkError?.key === signature
        ? checkError.message
        : "";
  useDirtyForm(
    "dataset-create",
    [
      source,
      symbol,
      logical,
      asset,
      calendar,
      precision,
      day,
      periods,
      frequency,
    ],
    result ? "saved" : "draft",
  );
  function choose(item: CatalogItem) {
    setSelected(item);
    setSource(item.source);
    setSymbol(item.provider_symbol);
    setLogical(item.logical_symbol);
    setAsset(item.asset_class);
    setCalendar(defaults[item.asset_class] || "");
    setPrecision(item.precision == null ? "" : String(item.precision));
    setError("");
    setFieldErrors({});
  }
  useEffect(() => {
    const code = params.get("symbol");
    if (!code) return;
    const controller = new AbortController();
    void api<{ items: CatalogItem[] }>(
      `/market-data/history-catalog/search?${new URLSearchParams({ source: initialSource, query: code, limit: "100" })}`,
      undefined,
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        const item = page.items.find(
          (item) =>
            item.provider_symbol === code &&
            (!initialSource || item.source === initialSource),
        );
        if (item) {
          choose(item);
          setStep(2);
        } else setError("原品种未在当前来源目录中找到，请重新选择或手工登记。");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPrefilling(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (
      step !== 2 ||
      result ||
      uncertain ||
      !logical ||
      !symbol ||
      !calendar ||
      !/^[A-Z0-9]{1,10}$/.test(logical) ||
      !/^[A-Za-z0-9/_.-]{1,64}$/.test(symbol)
    ) {
      setChecking(false);
      return;
    }
    const controller = new AbortController();
    setChecking(true);
    setCheckError(null);
    const timer = setTimeout(() => {
      void api<Check>(
        "/market-data/center/datasets/check",
        JSON.parse(signature),
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setCheck({ key: signature, value });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setCheckError({ key: signature, message: String(e) });
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [signature, step, result, uncertain, checkRevision]);
  useEffect(() => {
    if (step === 2) configHeading.current?.focus({ preventScroll: true });
  }, [step]);
  function fail(message: string, fields: Record<string, string> = {}) {
    setError(message);
    setFieldErrors(fields);
    requestAnimationFrame(() => errorBox.current?.focus());
  }
  function inputProps(id: string) {
    const invalid =
      fieldErrors[id] ||
      (currentCheck?.status === "invalid" && currentCheck.field === id
        ? currentCheck.message
        : "");
    return {
      id,
      "aria-invalid": !!invalid,
      "aria-describedby": invalid ? `${id}-error` : undefined,
    };
  }
  function fieldError(id: string) {
    const message =
      fieldErrors[id] ||
      (currentCheck?.status === "invalid" && currentCheck.field === id
        ? currentCheck.message
        : "");
    return message ? (
      <small id={`${id}-error`} className="error">
        {message}
      </small>
    ) : null;
  }
  function validate() {
    const fields: Record<string, string> = {};
    if (!/^[A-Z0-9]{1,10}$/.test(logical))
      fields["create-logical"] = "填写 1–10 位大写字母或数字的品种标识。";
    if (!/^[A-Za-z0-9/_.-]{1,64}$/.test(symbol))
      fields["create-symbol"] = "填写准确来源代码。";
    if (!/^(?:[0-9]|10)$/.test(precision))
      fields["create-precision"] = "请确认 0–10 位的价格精度。";
    if (!day) fields["create-day"] = "选择起始交易日期。";
    if (!calendar) fields["create-calendar"] = "明确选择日线划分规则。";
    if (Object.keys(fields).length) {
      fail("请补全以下字段。", fields);
      return false;
    }
    return true;
  }
  async function submit() {
    if (
      !uncertain &&
      (!validate() ||
        currentCheck?.status !== "ready" ||
        currentCheck.start == null ||
        checking)
    )
      return;
    if (!actionLock.acquire()) return;
    setBusy(true);
    setError("");
    setFieldErrors({});
    const body = pendingBody.current || {
      request_id: request.current,
      create_only: true,
      dataset,
      maintenance: {
        target_start: currentCheck!.start,
        timeframes: periods,
        frequency,
        timezone: "UTC",
        daily_minute: 15,
      },
    };
    const lookup = () =>
      api<{ found: boolean; dataset?: Dataset; task?: Result["task"] }>(
        `/market-data/center/creations/${body.request_id}?${new URLSearchParams({ source: body.dataset.source, provider_symbol: body.dataset.provider_symbol, asset_class: body.dataset.asset_class, aggregation_calendar: body.dataset.aggregation_calendar })}`,
      );
    const reconcile = async () => {
      const known = await lookup();
      if (known.found && known.dataset && known.task) {
        setResult({ dataset: known.dataset, task: known.task });
        setUncertain(false);
        return true;
      }
      return false;
    };
    try {
      if (needsLookup.current) {
        if (await reconcile()) return;
        needsLookup.current = false;
        setUncertain(false);
      }
      pendingBody.current = body;
      try {
        setResult(await api<Result>("/market-data/center/datasets", body));
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          pendingBody.current = null;
          fail(String(e));
          retryCheck((v) => v + 1);
          return;
        }
        needsLookup.current = true;
        setUncertain(true);
        try {
          if (await reconcile()) return;
          fail("尚未查到创建结果。再次操作会先核查，再使用同一提交标识重试。");
        } catch {
          fail("创建结果暂无法核实。已保留提交内容，请先核查结果后重试。");
        }
      }
    } catch (e) {
      fail("核查创建结果失败，请稍后重试。" + String(e));
    } finally {
      actionLock.release();
      setBusy(false);
    }
  }
  function manualMode() {
    setManual(true);
    setSelected(null);
    setSymbol("");
    setLogical("");
    setPrecision("");
    setStep(2);
    setError("");
  }
  function restart() {
    setResult(null);
    setStep(1);
    setManual(false);
    setSelected(null);
    setSource(initialSource || "dukascopy");
    setSymbol("");
    setLogical("");
    setAsset("forex");
    setCalendar("ny17");
    setPrecision("");
    setDay("");
    setPeriods(["M1", "H4", "D1"]);
    setFrequency("daily");
    setError("");
    setFieldErrors({});
    setCheck(null);
    setCheckError(null);
    setUncertain(false);
    pendingBody.current = null;
    needsLookup.current = false;
    request.current = crypto.randomUUID();
  }
  const title = selected?.display_symbol || logical || symbol || "待选择品种";
  const ready =
    currentCheck?.status === "ready" &&
    currentCheck.start != null &&
    !checking &&
    !currentError;
  return (
    <section className="data-center dc-create-page">
      <div className="dc-create-title">
        <div>
          <small>自建行情 / 添加行情</small>
          <h1>{result ? "创建结果" : "添加自建行情"}</h1>
        </div>
        <Link to={back}>{backLabel}</Link>
      </div>
      {!result && (
        <nav className="dc-create-steps" aria-label="创建步骤">
          <span aria-current={step === 1 ? "step" : undefined}>① 选择品种</span>
          <span aria-current={step === 2 ? "step" : undefined}>
            ② 配置并创建
          </span>
        </nav>
      )}
      {error && (
        <div
          ref={errorBox}
          tabIndex={-1}
          role="alert"
          className="dc-create-notice error"
        >
          <p>{error}</p>
          {Object.entries(fieldErrors).map(([id, message]) => (
            <p key={id}>
              <a
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(id)?.focus();
                }}
              >
                {message}
              </a>
            </p>
          ))}
        </div>
      )}
      {prefilling ? (
        <p role="status" className="dc-create-notice">
          正在核对所选来源品种…
        </p>
      ) : result ? (
        <div className="dc-create-result" role="status">
          <h2>自建行情已创建，历史准备任务已提交</h2>
          <p>
            {result.dataset.display_symbol || result.dataset.logical_symbol} ·{" "}
            {names[result.dataset.identity.source]} ·{" "}
            {phase(result.dataset.aggregation_calendar)}
          </p>
          <p>
            任务状态：{names[result.task.status] || result.task.status}
            。后台继续准备历史，关闭窗口后任务继续运行。
          </p>
          <p>历史实际发布、周期可用后，可在自建行情列表打开图表。</p>
          <div className="dc-actions">
            <Link
              className="primary dc-button"
              to={`/market-data?tab=tasks&dataset_id=${result.dataset.id}#task-${result.task.id}`}
            >
              查看任务
            </Link>
            <Link to="/market-data?tab=managed">返回自建行情</Link>
            <Link to={`/market-data/datasets/${result.dataset.id}`}>
              管理行情
            </Link>
            <button onClick={restart}>继续添加行情</button>
            {result.dataset.latest_version_id &&
              result.dataset.usable_timeframes.length > 0 && (
                <OpenChart
                  ticker={`MWH:${result.dataset.latest_version_id}`}
                  frame={result.dataset.usable_timeframes[0]}
                  label="打开图表"
                />
              )}
          </div>
        </div>
      ) : step === 1 ? (
        <>
          <CreationCatalog
            initialFilters={catalogFilters}
            saveFilters={setCatalogFilters}
            selected={selected}
            select={choose}
          />
          <div className="dc-create-actionbar">
            <span>
              {selected
                ? `已选择：${selected.display_symbol || selected.logical_symbol} · ${names[selected.source]}`
                : "请选择支持自建历史的品种"}
            </span>
            <button onClick={manualMode}>手工登记</button>
            <button
              className="primary"
              disabled={!selected}
              onClick={() => {
                setManual(false);
                setStep(2);
              }}
            >
              配置历史 →
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="dc-create-selection">
            <h2 ref={configHeading} tabIndex={-1}>
              {title} · {names[source]}
            </h2>
            <button
              disabled={busy || uncertain}
              onClick={() => {
                setStep(1);
                setError("");
              }}
            >
              更换品种
            </button>
          </div>
          <div className="dc-create-config-scroll">
            <div className="dc-create-config-grid">
              <div className="dc-create-fields">
                <fieldset disabled={busy || uncertain}>
                  <legend>品种信息</legend>
                  {manual ? (
                    <>
                      <label>
                        来源
                        <NativeSelect
                          value={source}
                          onChange={(e) => {
                            setSource(e.target.value);
                            setSymbol("");
                            setLogical("");
                            setPrecision("");
                          }}
                        >
                          <option value="dukascopy">Dukascopy</option>
                          <option value="oanda">OANDA Practice</option>
                        </NativeSelect>
                      </label>
                      <label>
                        品种标识
                        <NativeInput
                          {...inputProps("create-logical")}
                          maxLength={10}
                          value={logical}
                          onChange={(e) =>
                            setLogical(e.target.value.toUpperCase())
                          }
                          placeholder="例如 EURUSD"
                        />
                        {fieldError("create-logical")}
                      </label>
                      <label>
                        准确来源代码
                        <NativeInput
                          {...inputProps("create-symbol")}
                          maxLength={64}
                          value={symbol}
                          onChange={(e) => setSymbol(e.target.value)}
                          placeholder={
                            source === "oanda" ? "例如 EUR_USD" : "例如 EUR/USD"
                          }
                        />
                        {fieldError("create-symbol")}
                      </label>
                      <label>
                        资产类别
                        <NativeSelect
                          value={asset}
                          onChange={(e) => {
                            setAsset(e.target.value);
                            setCalendar(defaults[e.target.value] || "");
                          }}
                        >
                          {Object.entries(assetNames).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                    </>
                  ) : (
                    <dl className="dc-create-facts">
                      <dt>准确来源代码</dt>
                      <dd>{symbol}</dd>
                      <dt>资产类别</dt>
                      <dd>{assetNames[asset] || asset}</dd>
                      <dt>报价</dt>
                      <dd>Bid</dd>
                    </dl>
                  )}
                  {selected?.precision != null ? (
                    <p>价格精度：{precision} 位 · 来自来源目录</p>
                  ) : (
                    <label>
                      价格精度（必填）
                      <NativeInput
                        {...inputProps("create-precision")}
                        type="number"
                        min="0"
                        max="10"
                        value={precision}
                        onChange={(e) => setPrecision(e.target.value)}
                      />
                      {fieldError("create-precision")}
                      <small>
                        来源目录未提供精度，请确认价格的小数位数；下载时仍会校验。
                      </small>
                    </label>
                  )}
                  <p>超出设定精度的价格自动四舍五入；未超精度的价格保持原值。</p>
                </fieldset>
                <fieldset disabled={busy || uncertain}>
                  <legend>历史范围与日线划分</legend>
                  <label>
                    起始交易日期
                    <NativeInput
                      {...inputProps("create-day")}
                      aria-label="起始交易日期"
                      type="date"
                      value={day}
                      onChange={(e) => setDay(e.target.value)}
                    />
                    {fieldError("create-day")}
                  </label>
                  <label>
                    日线划分
                    <NativeSelect
                      {...inputProps("create-calendar")}
                      value={calendar}
                      onChange={(e) => setCalendar(e.target.value)}
                    >
                      <option value="">请选择日线划分</option>
                      <option value="ny17">纽约当地 17:00（随夏令时）</option>
                      <option value="utc0">UTC 00:00</option>
                    </NativeSelect>
                    {fieldError("create-calendar")}
                  </label>
                  <p>
                    {calendar === "ny17"
                      ? "交易日期从前一天纽约当地 17:00 开始。"
                      : calendar === "utc0"
                        ? "交易日期从当日 UTC 00:00 开始。"
                        : "该类别需要明确选择日线划分规则。"}
                  </p>
                  <p>
                    对应起始时刻：
                    {currentCheck?.start == null
                      ? "待核对"
                      : time(currentCheck.start)}
                  </p>
                </fieldset>
                <fieldset disabled={busy || uncertain}>
                  <legend>需要的周期</legend>
                  <div className="dc-checks">
                    {frames.map((frame) => (
                      <label key={frame}>
                        <NativeInput
                          type="checkbox"
                          checked={periods.includes(frame)}
                          disabled={frame === "M1"}
                          onChange={(e) => {
                            // The native control and business form use separate
                            // React roots. Capture before controlled restoration.
                            const checked = e.target.checked;
                            setPeriods((old) =>
                              checked
                                ? [...old, frame]
                                : old.filter((value) => value !== frame),
                            );
                          }}
                        />
                        {frame}
                      </label>
                    ))}
                  </div>
                  <p>M1 是基础数据，其他周期按所选日线规则生成。</p>
                </fieldset>
                <fieldset disabled={busy || uncertain}>
                  <legend>后续更新</legend>
                  <label>
                    维护计划
                    <NativeSelect
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value)}
                    >
                      <option value="daily">每日更新 · 00:15 UTC</option>
                      <option value="once">仅下载本次</option>
                    </NativeSelect>
                  </label>
                  <p>
                    首次任务按提交时确定历史截止点。
                    {frequency === "daily"
                      ? "之后每日补充已完成的历史数据。"
                      : "完成本次后不安排每日更新。"}
                  </p>
                </fieldset>
              </div>
              <aside className="dc-create-summary" aria-label="创建摘要">
                <h2>创建摘要</h2>
                <dl className="dc-create-facts">
                  <dt>品种</dt>
                  <dd>{title}</dd>
                  <dt>来源</dt>
                  <dd>{names[source]}</dd>
                  <dt>报价</dt>
                  <dd>Bid</dd>
                  <dt>日线划分</dt>
                  <dd>{calendar ? phase(calendar) : "待选择"}</dd>
                  <dt>价格精度</dt>
                  <dd>{precision === "" ? "待确认" : `${precision} 位`}</dd>
                  <dt>历史起点</dt>
                  <dd>
                    {day || "待选择"}
                    <br />
                    {currentCheck?.start == null
                      ? ""
                      : time(currentCheck.start)}
                  </dd>
                  <dt>周期</dt>
                  <dd>
                    {frames
                      .filter((frame) => periods.includes(frame))
                      .join(" · ")}
                  </dd>
                  <dt>后续更新</dt>
                  <dd>
                    {frequency === "daily" ? "每日 00:15 UTC" : "仅下载本次"}
                  </dd>
                </dl>
                <div role="status">
                  {checking
                    ? "正在核对创建条件…"
                    : currentCheck?.status === "existing"
                      ? "此行情已有登记或维护配置，本次不会覆盖。"
                      : currentCheck?.status === "connection_required"
                        ? "OANDA Practice 连接未配置，请由管理员完成配置。"
                        : currentCheck?.status === "precision_required"
                          ? "请确认价格精度后继续。"
                          : ready
                            ? "已完成核对，可以创建。"
                            : "请补全历史起点及所需配置。"}
                </div>
                {currentCheck?.existing && (
                  <Link
                    to={`/market-data/datasets/${currentCheck.existing.id}`}
                  >
                    管理已有行情
                  </Link>
                )}
                {currentError && (
                  <p role="alert" className="error">
                    {currentError}
                    <button onClick={() => retryCheck((v) => v + 1)}>
                      重新核对
                    </button>
                  </p>
                )}
              </aside>
            </div>
          </div>
          <div className="dc-create-actionbar">
            <button
              disabled={busy || uncertain}
              onClick={() => {
                setStep(1);
                setError("");
              }}
            >
              返回选择品种
            </button>
            <Link
              to={
                uncertain
                  ? `/market-data?tab=tasks&query=${encodeURIComponent(logical)}`
                  : back
              }
            >
              {uncertain ? "查看任务核查" : "取消"}
            </Link>
            <button
              className="primary"
              disabled={busy || (!uncertain && !ready)}
              onClick={() => void submit()}
            >
              {busy
                ? "正在核查与提交…"
                : uncertain
                  ? "核查创建结果并重试"
                  : "创建并开始准备历史"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
