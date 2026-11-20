import { PreviousDayAlertNote } from "../advanced/PreviousDayAlertNote";
import { logEvent, logFailure } from "./logs";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import {
  normalizeCondition,
  relations,
  indicatorDefaults,
  type AlertConfig,
  type PreviousDayPreset,
  type AlertRow,
  type Capabilities,
  type IndicatorSpec,
} from "../advanced/chartAlerts";
import { dateTimeInput } from "../time/chartTime";
import { admission, savePriceRule, uncertainError } from "./alerts";
import MobileSheet from "./MobileSheet";
import { MobileConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { DataMore, DataSelect } from "./DataFormParts";
import SymbolInfo from "./SymbolInfo";

type Props = {
  preset?: PreviousDayPreset;
  initial: AlertConfig;
  editing?: AlertRow;
  label: string;
  source?: string;
  name?: string;
  frames: string[];
  online: boolean;
  ntfy: boolean;
  open?: boolean;
  saved(row: AlertRow): void;
  close(): void;
  onClosed?(): void;
  recheck?: number;
  report(message: string): void;
  notifications?(): void;
  maintain?(): void;
};
export default function PriceRuleSheet({
  preset,
  initial,
  editing,
  label,
  source,
  name,
  frames,
  online,
  ntfy,
  open = true,
  saved,
  close,
  onClosed,
  notifications,
  maintain,
  recheck,
}: Props) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [caps, setCaps] = useState<Capabilities>();
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const [fields, setFields] = useState<{ field: string; message: string }[]>(
    [],
  );
  const [conflict, setConflict] = useState(false),
    [unknown, setUnknown] = useState(false),
    [reload, setReload] = useState(false);
  const [expiryText, setExpiryText] = useState(() =>
    dateTimeInput(initial.expires_at, "UTC"),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [capabilityRetry, setCapabilityRetry] = useState(0),
    [capabilityError, setCapabilityError] = useState("");
  const requestId = useRef(crypto.randomUUID()),
    flight = useRef(false),
    mounted = useRef(true);
  const pending = useRef<AlertConfig | undefined>(undefined),
    form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setCaps(undefined);
    setCapabilityError("");
    if (online && open)
      void api<Capabilities>(
        "/chart-alerts/capabilities",
        {
          instrument: draft.instrument,
          series_kind: draft.series_kind,
          timeframe: draft.timeframe,
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      )
        .then((value) => {
          if (!controller.signal.aborted) setCaps(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            logFailure("告警", "读取告警能力", error, label);
            setCapabilityError(errorMessage(error));
          }
        });
    return () => controller.abort();
  }, [
    draft.instrument,
    draft.timeframe,
    online,
    open,
    recheck,
    capabilityRetry,
  ]);
  const indicator = draft.condition.left.indicator;
  const available = indicator
    ? caps?.sources.find(
        (item) =>
          item.source === draft.source &&
          item.series_kind === draft.series_kind,
      )
    : admission(caps, draft);
  const interval = ["enter", "exit", "break_upper", "break_lower"].includes(
    draft.condition.relation,
  );
  const change = (values: Partial<AlertConfig>) => {
    if (unknown || busy || conflict) return;
    setDirty(true);
    setError("");
    setFields([]);
    setDraft((old) => ({ ...old, ...values,
      ...(values.mode === "intrabar" || values.expires_at === null ? {close_expiry_grace_ms:0} : {}) }));
  };
  const field = (key: string) =>
    fields.find((item) => item.field === key)?.message;
  const updateIndicator = (value: IndicatorSpec) =>
    change({
      condition: {
        ...draft.condition,
        left: { kind: "indicator", indicator: value },
      },
    });
  async function submit() {
    if (
      flight.current ||
      !online ||
      conflict ||
      (!unknown && !available?.available) ||
      (draft.notify_ntfy && !ntfy && !unknown)
    )
      return;
    // Preserve exact stored precision unless the user edits the expiry field.
    const expiry = draft.expires_at;
    if (
      !unknown &&
      expiry !== null &&
      (!Number.isFinite(expiry) || expiry <= Date.now())
    ) {
      setMoreOpen(true);
      setError("请选择未来的到期时间，或清空时间设为不限到期。");
      return;
    }
    const normalized = normalizeCondition(draft.condition);
    if (
      !unknown &&
      (interval
        ? !Number.isFinite(Number(normalized.lower)) ||
          !Number.isFinite(Number(normalized.upper)) ||
          Number(normalized.lower) >= Number(normalized.upper)
        : !String(
            normalized.right?.value ??
              normalized.right?.line?.points[0]?.price ??
              "",
          ).trim() ||
          !Number.isFinite(
            Number(
              normalized.right?.value ??
                normalized.right?.line?.points[0]?.price,
            ),
          ))
    ) {
      setError(interval ? "下沿价格须小于上沿价格。" : "请输入有效的目标值。");
      return;
    }
    const target = interval
      ? `${normalized.lower}–${normalized.upper}`
      : normalized.right?.value || normalized.right?.line?.points[0]?.price;
    const config = pending.current || {
      ...draft,
      expires_at: expiry,
      condition: normalized,
      name:
        draft.name.trim() ||
        `${label} ${indicator?.name || ""}${relations[normalized.relation]} ${target}`.slice(
          0,
          100,
        ),
    };
    flight.current = true;
    setBusy(true);
    setError("");
    setFields([]);
    try {
      pending.current = config;
      const row = await savePriceRule(
        config,
        requestId.current,
        editing,
        api,
        unknown,
      );
      if (mounted.current) {
        setDirty(false);
        setUnknown(false);
        saved(row);
        logEvent({
          module: "告警",
          action: editing ? "保存告警" : "创建告警",
          message: "已保存，运行状态以服务器为准",
          object: label,
          result: "success",
        });
      }
    } catch (error) {
      if (mounted.current) {
        logFailure("告警", editing ? "保存告警" : "创建告警", error, label);
        setError(errorMessage(error));
        setFields(error instanceof ApiError ? error.fieldErrors : []);
        const unknown = uncertainError(error);
        setUnknown(unknown);
        setConflict(error instanceof ApiError && error.status === 409);
        if (!unknown) pending.current = undefined;
        if (
          error instanceof ApiError &&
          error.fieldErrors.some((item) =>
            ["name", "expires_at", "message"].includes(item.field),
          )
        )
          setMoreOpen(true);
        requestAnimationFrame(() => {
          const key =
            error instanceof ApiError ? error.fieldErrors[0]?.field : undefined;
          const id =
            key &&
            (
              {
                "condition.right.value": "alert-target",
                "condition.lower": "alert-lower",
                "condition.upper": "alert-upper",
                name: "alert-name",
                expires_at: "alert-expiry",
                notify_ntfy: "alert-push",
              } as Record<string, string>
            )[key];
          const target = id
            ? form.current?.querySelector<HTMLElement>(`#${id}`)
            : undefined;
          (
            target ||
            form.current?.querySelector<HTMLElement>('[role="alert"][tabindex]')
          )?.focus();
        });
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const locked = busy || unknown || conflict || !online;
  const relationItems = Object.entries(relations)
    .filter(
      ([key]) =>
        !indicator ||
        !["enter", "exit", "break_upper", "break_lower"].includes(key),
    )
    .map(([value, label]) => ({ value, label }));
  return (
    <MobileSheet
      title={editing ? "编辑告警" : "设置告警"}
      open={open}
      dirty={dirty || unknown}
      dismissible={!busy && !unknown}
      close={close}
      onClosed={onClosed}
    >
      <form
        ref={form}
        className="alert-editor mobile-price-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="alert-editor-symbol">
          <SymbolInfo code={label} name={name} source={source} custom />
        </div>
        {preset && <PreviousDayAlertNote preset={preset} />}
        <FieldGroup>
          {indicator && (
            <>
              <DataSelect
                label="指标"
                value={indicator.name}
                disabled={locked}
                items={(caps?.indicators || [indicator.name]).map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(name) =>
                  updateIndicator({
                    name: name as IndicatorSpec["name"],
                    version: "1",
                    params: indicatorDefaults[name],
                    output:
                      caps?.indicator_metadata?.[name]?.series[0]?.key ||
                      "value",
                  })
                }
              />
              {Object.entries(
                caps?.indicator_metadata?.[indicator.name]?.parameter_schema ||
                  {},
              ).map(([key, schema]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`alert-indicator-${key}`}>
                    {schema.label || key}
                  </FieldLabel>
                  {schema.type === "boolean" ? (
                    <Switch
                      size="lg"
                      id={`alert-indicator-${key}`}
                      checked={Boolean(indicator.params[key])}
                      disabled={locked}
                      onCheckedChange={(value) =>
                        updateIndicator({
                          ...indicator,
                          params: { ...indicator.params, [key]: value },
                        })
                      }
                    />
                  ) : (
                    <Input
                      id={`alert-indicator-${key}`}
                      type="number"
                      step={schema.type === "integer" ? 1 : "any"}
                      min={schema.min}
                      max={schema.max}
                      required
                      value={String(indicator.params[key] ?? "")}
                      disabled={locked}
                      onChange={(event) =>
                        updateIndicator({
                          ...indicator,
                          params: {
                            ...indicator.params,
                            [key]: Number(event.target.value),
                          },
                        })
                      }
                    />
                  )}
                </Field>
              ))}
              <DataSelect
                label="指标输出"
                value={indicator.output}
                disabled={locked}
                items={(
                  caps?.indicator_metadata?.[indicator.name]?.series || [
                    { key: indicator.output, label: indicator.output },
                  ]
                ).map((item) => ({
                  value: item.key,
                  label: item.label || item.key,
                }))}
                onChange={(output) => updateIndicator({ ...indicator, output })}
              />
            </>
          )}
          <DataSelect
            label="触发条件"
            value={draft.condition.relation}
            disabled={locked}
            items={relationItems}
            onChange={(relation) =>
              change({
                condition: normalizeCondition(draft.condition, relation),
              })
            }
          />
          {interval ? (
            <FieldGroup className="alert-price-range">
              {(["lower", "upper"] as const).map((side) => (
                <Field key={side} data-invalid={!!field(`condition.${side}`)}>
                  <FieldLabel htmlFor={`alert-${side}`}>
                    {side === "lower" ? "下沿价格" : "上沿价格"}
                  </FieldLabel>
                  <Input
                    id={`alert-${side}`}
                    required
                    inputMode="decimal"
                    aria-invalid={!!field(`condition.${side}`)}
                    value={draft.condition[side] || ""}
                    disabled={locked}
                    onChange={(event) =>
                      change({
                        condition: {
                          ...draft.condition,
                          [side]: event.target.value,
                        },
                      })
                    }
                  />
                  <FieldError>{field(`condition.${side}`)}</FieldError>
                </Field>
              ))}
            </FieldGroup>
          ) : (
            <Field data-invalid={!!field("condition.right.value")}>
              <FieldLabel htmlFor="alert-target">
                {indicator ? "目标值" : "目标价格"}
              </FieldLabel>
              <Input
                id="alert-target"
                className="alert-target"
                required
                inputMode="decimal"
                placeholder={indicator ? "输入目标值" : "输入目标价格"}
                aria-invalid={!!field("condition.right.value")}
                value={
                  draft.condition.right?.value ??
                  draft.condition.right?.line?.points[0]?.price ??
                  ""
                }
                disabled={locked}
                onChange={(event) => {
                  const right = draft.condition.right,
                    price = event.target.value;
                  change({
                    condition: {
                      ...draft.condition,
                      right: right?.line
                        ? {
                            ...right,
                            line: {
                              ...right.line,
                              points: right.line.points.map((point) => ({
                                ...point,
                                price,
                              })),
                            },
                          }
                        : { kind: "constant", value: price },
                    },
                  });
                }}
              />
              <FieldError>{field("condition.right.value")}</FieldError>
            </Field>
          )}
          {!indicator && (
            <Field>
              <FieldLabel>判定方式</FieldLabel>
              <ToggleGroup
                aria-label="判定方式"
                value={[draft.mode]}
                disabled={locked}
                onValueChange={(value) => {
                  if (value.length)
                    change({ mode: value[0] as AlertConfig["mode"] });
                }}
              >
                <ToggleGroupItem value="close">收盘确认</ToggleGroupItem>
                <ToggleGroupItem value="intrabar">触价</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {draft.mode === "close"
                  ? "完成一根 K 线后确认条件"
                  : "按实时抽样判断，未观测路径无法补判"}
              </FieldDescription>
            </Field>
          )}
          <DataSelect
            label="判定周期"
            value={draft.timeframe}
            disabled={locked}
            items={[...new Set([...frames, draft.timeframe])].map((value) => ({
              value,
              label: value,
            }))}
            onChange={(timeframe) => change({ timeframe })}
          />
          <Field orientation="horizontal" className="alert-switch-field">
            <div>
              <FieldLabel htmlFor="alert-push">手机推送</FieldLabel>
              <FieldDescription>
                {ntfy ? "触发时发送后台通知" : "尚未配置，仍可保存站内记录"}
              </FieldDescription>
              {!ntfy && notifications && (
                <Button type="button" variant="link" onClick={notifications}>
                  查看通知设置
                </Button>
              )}
            </div>
            <Switch
              size="lg"
              id="alert-push"
              checked={draft.notify_ntfy}
              disabled={locked || (!ntfy && !draft.notify_ntfy)}
              onCheckedChange={(notify_ntfy) => change({ notify_ntfy })}
            />
          </Field>
        </FieldGroup>
        <DataMore title="更多设置" open={moreOpen} onOpenChange={setMoreOpen}>
          <FieldGroup>
            {!editing && !!caps?.indicators?.length && (
              <DataSelect
                label="条件类型"
                value={indicator ? "indicator" : "price"}
                disabled={locked}
                items={[
                  { value: "price", label: "价格" },
                  { value: "indicator", label: "指标" },
                ]}
                onChange={(value) => {
                  change({
                    mode: "close",
                    condition:
                      value === "price"
                        ? {
                            relation: "cross_up",
                            left: { kind: "price" },
                            right: { kind: "constant", value: "" },
                          }
                        : {
                            relation: "cross_up",
                            left: {
                              kind: "indicator",
                              indicator: {
                                name: caps
                                  .indicators[0] as IndicatorSpec["name"],
                                version: "1",
                                params: indicatorDefaults[caps.indicators[0]],
                                output:
                                  caps.indicator_metadata?.[caps.indicators[0]]
                                    ?.series[0]?.key || "value",
                              },
                            },
                            right: { kind: "constant", value: "" },
                          },
                  });
                }}
              />
            )}
            <DataSelect
              label="最多触发"
              value={String(draft.max_triggers)}
              disabled={locked}
              items={[1, 2, 3].map((value) => ({
                value: String(value),
                label: `${value} 次`,
              }))}
              onChange={(value) =>
                change({ max_triggers: Number(value) as 1 | 2 | 3 })
              }
            />
            <Field>
              <FieldLabel htmlFor="alert-expiry">到期时间（UTC）</FieldLabel>
              <Input
                id="alert-expiry"
                type="datetime-local"
                value={expiryText}
                disabled={locked}
                onChange={(event) => {
                  setExpiryText(event.target.value);
                  change({
                    expires_at: event.target.value
                      ? Date.parse(event.target.value + "Z")
                      : null,
                  });
                }}
              />
              <FieldDescription>留空表示不限到期；按 UTC 输入</FieldDescription>
              {expiryText && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => {
                    setExpiryText("");
                    change({ expires_at: null });
                  }}
                >
                  不限到期
                </Button>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="alert-name">名称</FieldLabel>
              <Input
                id="alert-name"
                maxLength={100}
                placeholder="根据品种和条件自动命名"
                value={draft.name}
                disabled={locked}
                onChange={(event) => change({ name: event.target.value })}
              />
              <FieldError>{field("name")}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="alert-message">备注</FieldLabel>
              <Input
                id="alert-message"
                maxLength={2000}
                value={draft.message}
                disabled={locked}
                onChange={(event) => change({ message: event.target.value })}
              />
            </Field>
            <Field orientation="horizontal" className="alert-switch-field">
              <FieldLabel htmlFor="alert-web">应用内提醒</FieldLabel>
              <Switch
                size="lg"
                id="alert-web"
                checked={draft.notify_web}
                disabled={locked}
                onCheckedChange={(notify_web) => change({ notify_web })}
              />
            </Field>
            <DataSelect
              label="迟到触发"
              value={draft.late_delivery}
              disabled={locked}
              items={[
                { value: "log_only", label: "仅记录" },
                { value: "notify", label: "仍然通知" },
              ]}
              onChange={(value) =>
                change({ late_delivery: value as AlertConfig["late_delivery"] })
              }
            />
          </FieldGroup>
        </DataMore>
        <p className="alert-defaults">
          {draft.max_triggers} 次 · {expiryText ? "指定时间到期" : "不限到期"} ·{" "}
          {draft.late_delivery === "log_only" ? "迟到仅记录" : "迟到仍通知"}
        </p>
        {error && (
          <p className="mobile-inline-error" role="alert" tabIndex={-1}>
            {error}
          </p>
        )}
        {conflict && (
          <>
            <p className="alert-muted">
              规则已在其他地方改变，当前输入已保留。
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReload(true)}
            >
              放弃输入并查看最新
            </Button>
          </>
        )}
        {unknown && (
          <p className="alert-muted">
            提交结果未知，输入已锁定。核查沿用同一次请求，不会重复创建。
          </p>
        )}
        {!unknown && (
          <p className="alert-capability" role="status">
            {!online
              ? "离线，只读；联网后可提交"
              : !caps
                ? capabilityError || "正在核验实时能力…"
                : !available?.available
                  ? available?.reason || "此条件暂不可用"
                  : "首次观察建立基准，不计为已发生穿越"}
          </p>
        )}
        {!unknown && capabilityError && (
          <Button
            type="button"
            variant="outline"
            disabled={!online || busy}
            onClick={() => setCapabilityRetry((value) => value + 1)}
          >
            重新核验能力
          </Button>
        )}
        {caps && !available?.available && maintain && (
          <Button type="button" variant="outline" onClick={maintain}>
            去数据详情
          </Button>
        )}
        <div className="alert-save-bar">
          <Button
            type="submit"
            disabled={
              !online ||
              busy ||
              conflict ||
              (!unknown &&
                (!available?.available || (draft.notify_ntfy && !ntfy)))
            }
          >
            {busy
              ? "正在核查…"
              : unknown
                ? "核查同一次提交"
                : editing
                  ? "保存告警"
                  : "创建告警"}
          </Button>
        </div>
      </form>
      {reload && (
        <MobileConfirm
          title="放弃输入并读取最新？"
          description="当前未保存的输入将丢失。"
          actionLabel="读取最新"
          destructive
          onClose={() => setReload(false)}
          onAccept={() => {
            setReload(false);
            if (!editing) return;
            void api<AlertRow>(`/chart-alerts/${editing.id}`)
              .then(saved)
              .catch((error) =>
                setError("读取最新失败：" + errorMessage(error)),
              );
          }}
        />
      )}
    </MobileSheet>
  );
}
