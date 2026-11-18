import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../api";
import {
  type Profile,
  profileActive,
  readSnapshot,
  writeSnapshot,
} from "./cache";
import {
  calculatePosition,
  decimalUnits,
  normalizePrice,
} from "./positionCalculator";
import { positionContracts } from "./positionContracts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Field, FieldLabel, FieldGroup } from "./components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./components/ui/collapsible";
import MobileSelect from "./MobileSelect";
import { useOverlayActive } from "./WatchOverlays";
import { logFailure } from "./logs";

type Preferences = {
  model: "dukascopy-mt4-usd-v1";
  symbol: string;
  risk: string;
  overrides: Record<string, { units: string; minimum: string; step: string }>;
  rates: Record<string, { price: string; at?: number }>;
};
const initial: Preferences = {
  model: "dukascopy-mt4-usd-v1",
  symbol: "EUR/USD",
  risk: "100.00",
  overrides: {},
  rates: {},
};
const cacheKey = "position-calculator-preferences-v1";
export default function PositionCalculatorSheet({
  profile,
  online,
}: {
  profile: Profile;
  online: boolean;
}) {
  const active = useOverlayActive();
  const [preferences, setPreferences] = useState<Preferences>(initial);
  const [loaded, setLoaded] = useState(false);
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [search, setSearch] = useState("");
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [overrideDrafts, setOverrideDrafts] = useState<
    Record<string, Partial<{ units: string; minimum: string; step: string }>>
  >({});
  const [reference, setReference] = useState<{ price: string; at?: number }>();
  const [referenceError, setReferenceError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [riskDraft, setRiskDraft] = useState<string>();
  const entryEdited = useRef(false),
    writes = useRef(Promise.resolve());
  const preset =
    positionContracts.find((x) => x.symbol === preferences.symbol) ||
    positionContracts.find((x) => x.symbol === "EUR/USD")!;
  const contract = {
    ...preset,
    ...preferences.overrides[preset.symbol],
    ...overrideDrafts[preset.symbol],
  };
  const rate = preset.conversion
    ? (rateDrafts[preset.conversion] ??
      preferences.rates[preset.conversion]?.price ??
      "")
    : "";
  useEffect(() => {
    let live = true;
    void readSnapshot<Preferences>(profile, cacheKey)
      .then((snapshot) => {
        if (
          live &&
          profileActive(profile) &&
          snapshot?.value.model === initial.model
        )
          setPreferences({ ...initial, ...snapshot.value });
      })
      .catch((e) => logFailure("头寸", "读取参数", e))
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [profile]);
  useEffect(() => {
    if (!loaded) return;
    writes.current = writes.current
      .catch(() => {})
      .then(() => writeSnapshot(profile, cacheKey, preferences))
      .catch((e) => logFailure("头寸", "记住参数", e));
  }, [loaded, preferences, profile]);
  useEffect(() => {
    if (!loaded || !active || !online || document.hidden) return;
    const abort = new AbortController();
    const hide = () => {
      if (document.hidden) {
        abort.abort();
        setBusy(false);
      } else setRefresh((x) => x + 1);
    };
    document.addEventListener("visibilitychange", hide);
    setBusy(true);
    setReferenceError("");
    setReference(undefined);
    const conversion = positionContracts.find(
      (x) => x.symbol === preset.conversion,
    );
    void api<any>(
      "/market-data/quotes",
      { symbols: [preset.ticker, ...(conversion ? [conversion.ticker] : [])] },
      abort.signal,
    )
      .then((data) => {
        if (abort.signal.aborted) return;
        const rows = Array.isArray(data) ? data : data.quotes || [];
        const parse = (ticker: string, precision: number) => {
          const row = rows.find((x: any) => x.n === ticker),
            v = row?.v;
          if (row?.s !== "ok" || v?.lp == null) return;
          const price = normalizePrice(String(v.lp), precision),
            at = v.data_end || v.quote_time;
          return price
            ? { price, at: typeof at === "number" ? at : undefined }
            : undefined;
        };
        const value = parse(preset.ticker, preset.precision);
        if (!value) {
          setReferenceError("参考价暂不可用，可直接手填");
          return;
        }
        setReference(value);
        if (
          !entryEdited.current &&
          value.at &&
          Date.now() - value.at < 5 * 60000 &&
          value.at <= Date.now()
        )
          setEntry((old) => old || value.price);
        if (conversion) {
          const next = parse(conversion.ticker, conversion.precision);
          if (next)
            setPreferences((old) =>
              old.rates[conversion.symbol]?.price
                ? old
                : {
                    ...old,
                    rates: { ...old.rates, [conversion.symbol]: next },
                  },
            );
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setReferenceError(errorMessage(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => {
      abort.abort();
      document.removeEventListener("visibilitychange", hide);
    };
  }, [active, online, loaded, preset.symbol, refresh]);
  const risk = riskDraft ?? preferences.risk;
  const calculation = calculatePosition(contract, {
    risk,
    entry,
    stop,
    direction,
    conversion: rate,
  });
  const setOverride = (key: "units" | "minimum" | "step", value: string) => {
    setOverrideDrafts((old) => ({
      ...old,
      [preset.symbol]: { ...old[preset.symbol], [key]: value },
    }));
    const next = { ...contract, [key]: value };
    if (
      (decimalUnits(next.units, 0) || 0n) > 0n &&
      (decimalUnits(next.minimum, 2) || 0n) > 0n &&
      (decimalUnits(next.step, 2) || 0n) > 0n
    ) {
      setPreferences((old) => ({
        ...old,
        overrides: {
          ...old.overrides,
          [preset.symbol]: {
            units: next.units,
            minimum: next.minimum,
            step: next.step,
          },
        },
      }));
    }
  };
  const items = positionContracts
    .filter((x) =>
      x.symbol
        .replace("/", "")
        .toLowerCase()
        .includes(search.replace(/\s|\//g, "").toLowerCase()),
    )
    .map((x) => ({
      value: x.symbol,
      label: x.symbol === "XAU/USD" ? "XAU/USD · 黄金" : x.symbol,
    }));
  if (!loaded) return <p role="status">正在读取本机参数…</p>;
  return (
    <div className="position-tool more-panel">
      <p className="more-description">Dukascopy MT4 · USD 账户</p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="position-search">品种</FieldLabel>
          <Input
            id="position-search"
            aria-label="搜索本地品种"
            placeholder="搜索 60 个内置品种"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {items.length ? (
            <MobileSelect
              label="计算品种"
              value={preset.symbol}
              items={items}
              onChange={(symbol) => {
                entryEdited.current = false;
                setEntry("");
                setStop("");
                setSearch("");
                setReference(undefined);
                setCopied(false);
                setPreferences((old) => ({ ...old, symbol }));
              }}
            />
          ) : (
            <p className="more-description">无匹配品种</p>
          )}
        </Field>
        <Field>
          <FieldLabel>方向</FieldLabel>
          <ToggleGroup
            value={[direction]}
            onValueChange={(values) => {
              if (values[0]) setDirection(values[0] as "long" | "short");
            }}
            aria-label="持仓方向"
          >
            <ToggleGroupItem value="long">做多</ToggleGroupItem>
            <ToggleGroupItem value="short">做空</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="position-risk">允许亏损 · USD</FieldLabel>
          <Input
            id="position-risk"
            inputMode="decimal"
            value={risk}
            onChange={(e) => {
              const value = e.target.value;
              setRiskDraft(value);
              if ((decimalUnits(value, 2) || 0n) > 0n)
                setPreferences((old) => ({ ...old, risk: value }));
            }}
            onBlur={() => {
              const value = normalizePrice(risk, 2);
              if (value && (decimalUnits(value, 2) || 0n) > 0n) {
                setRiskDraft(value);
                setPreferences((old) => ({ ...old, risk: value }));
              }
            }}
          />
        </Field>
        <div className="position-price-fields">
          <Field>
            <FieldLabel htmlFor="position-entry">入场价</FieldLabel>
            <Input
              id="position-entry"
              inputMode="decimal"
              value={entry}
              placeholder={preset.precision === 4 ? "0.0000" : "0.00"}
              onChange={(e) => {
                entryEdited.current = true;
                setEntry(e.target.value);
                setCopied(false);
              }}
              onBlur={() => {
                const v = normalizePrice(entry, preset.precision);
                if (v) setEntry(v);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="position-stop">止损价</FieldLabel>
            <Input
              id="position-stop"
              inputMode="decimal"
              value={stop}
              placeholder={preset.precision === 4 ? "0.0000" : "0.00"}
              onChange={(e) => {
                setStop(e.target.value);
                setCopied(false);
              }}
              onBlur={() => {
                const v = normalizePrice(stop, preset.precision);
                if (v) setStop(v);
              }}
            />
          </Field>
        </div>
        {preset.conversion && (
          <Field>
            <FieldLabel htmlFor="position-rate">
              换算报价 · {preset.conversion}
            </FieldLabel>
            <Input
              id="position-rate"
              inputMode="decimal"
              value={rate}
              onChange={(e) => {
                const value = e.target.value;
                setRateDrafts((old) => ({
                  ...old,
                  [preset.conversion!]: value,
                }));
                const precision = preset.conversion!.endsWith("/JPY") ? 2 : 4;
                if ((decimalUnits(value, precision) || 0n) > 0n)
                  setPreferences((old) => ({
                    ...old,
                    rates: {
                      ...old.rates,
                      [preset.conversion!]: {
                        price: normalizePrice(value, precision)!,
                      },
                    },
                  }));
              }}
              onBlur={() => {
                const value = normalizePrice(
                  rate,
                  preset.conversion!.endsWith("/JPY") ? 2 : 4,
                );
                if (value) {
                  setRateDrafts((old) => ({
                    ...old,
                    [preset.conversion!]: value,
                  }));
                  setPreferences((old) => ({
                    ...old,
                    rates: {
                      ...old.rates,
                      [preset.conversion!]: { price: value },
                    },
                  }));
                }
              }}
            />
            <small className="more-description">
              固定参考汇率估算，可手填；
              {preferences.rates[preset.conversion]?.at
                ? `参考时间 ${new Date(preferences.rates[preset.conversion].at!).toLocaleString("zh-CN")}`
                : "手填换算价 · 沿用本机记忆"}
              。
            </small>
          </Field>
        )}
      </FieldGroup>
      <section
        className="position-result"
        aria-label="计算结果"
        aria-live="polite"
      >
        {calculation.result ? (
          <>
            <small>风险预算内手数</small>
            <strong>
              {calculation.result.lots}
              <span> 手</span>
            </strong>
            <p>
              止损 {calculation.result.distance}
              {preset.gold ? " USD/盎司" : " pip"}
            </p>
            <dl className="mobile-facts">
              <div>
                <dt>预计止损亏损</dt>
                <dd>{calculation.result.loss} USD</dd>
              </div>
              <div>
                <dt>剩余预算</dt>
                <dd>{calculation.result.remaining} USD</dd>
              </div>
              <div>
                <dt>{preset.gold ? "每手每变动 1 美元" : "每手每 pip"}</dt>
                <dd>
                  {preset.gold ? contract.units : calculation.result.pipValue}{" "}
                  USD
                </dd>
              </div>
            </dl>
            <Button
              variant="outline"
              onClick={() => {
                const r = calculation.result!;
                void navigator.clipboard
                  .writeText(
                    `${preset.symbol} ${direction === "long" ? "做多" : "做空"}\n允许亏损 ${risk} USD\n入场 ${entry} · 止损 ${stop}\n止损距离 ${r.distance} ${preset.gold ? "USD/盎司" : "pip"}\n${preset.conversion ? `${preset.conversion} ${rate}\n` : preset.base === "USD" ? "按止损价换算 USD\n" : "USD 报价\n"}风险预算内 ${r.lots} 手\n预计价格亏损 ${r.loss} USD`,
                  )
                  .then(() => setCopied(true))
                  .catch((e) => logFailure("头寸", "复制结果", e));
              }}
            >
              <Copy data-icon="inline-start" />
              {copied ? "已复制" : "复制结果"}
            </Button>
          </>
        ) : (
          <p>
            {entry || stop ? calculation.error : "输入入场价与止损价，即可计算"}
          </p>
        )}
        <small>按输入价格估算</small>
      </section>
      <Collapsible className="more-environment">
        <CollapsibleTrigger
          render={
            <Button variant="ghost" className="more-environment-trigger" />
          }
        >
          参考价与合约{preferences.overrides[preset.symbol] ? " · 自定义" : ""}
          <ChevronDown data-icon="inline-end" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="position-reference">
            <p className="more-description">Dukascopy · Bid · M1 参考价</p>
            <p>
              {reference
                ? `${reference.price} · ${reference.at ? new Date(reference.at).toLocaleString("zh-CN") : "数据时间未知"}`
                : referenceError ||
                  (online ? "尚无参考价" : "离线，可直接手填")}
            </p>
            <div className="mobile-sheet-actions">
              <Button
                variant="outline"
                disabled={!online || busy}
                onClick={() => setRefresh((x) => x + 1)}
              >
                <RefreshCw data-icon="inline-start" />
                {busy ? "读取中…" : "刷新参考价"}
              </Button>
              <Button
                variant="outline"
                disabled={!reference}
                onClick={() => {
                  if (reference) {
                    entryEdited.current = true;
                    setEntry(reference.price);
                  }
                }}
              >
                使用参考价
              </Button>
            </div>
          </div>
          <FieldGroup>
            {(
              [
                ["units", "每手数量"],
                ["minimum", "最小手数"],
                ["step", "手数步长"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key}>
                <FieldLabel htmlFor={`position-${key}`}>{label}</FieldLabel>
                <Input
                  id={`position-${key}`}
                  inputMode="decimal"
                  value={contract[key]}
                  onChange={(e) => setOverride(key, e.target.value)}
                />
              </Field>
            ))}
          </FieldGroup>
          {preferences.overrides[preset.symbol] && (
            <Button
              variant="ghost"
              onClick={() =>
                setPreferences((old) => {
                  setOverrideDrafts((drafts) => {
                    const next = { ...drafts };
                    delete next[preset.symbol];
                    return next;
                  });
                  const overrides = { ...old.overrides };
                  delete overrides[preset.symbol];
                  return { ...old, overrides };
                })
              }
            >
              恢复内置合约
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
