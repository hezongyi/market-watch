import { useChartTime } from "../time/ChartTimeContext";
import { formatTimestamp } from "../time/chartTime";
import { ZonedDateTimeInput } from "../time/ZonedDateTimeInput";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { AlertSymbolIcon } from "./alertPresentation";
import { AlertMenu } from "./AlertMenu";
import {
  AlertSelect,
  AlertCheckbox,
  AlertButton,
  AlertInput,
  AlertTextarea,
  NativeControlsDisabled,
} from "./NativeAlertControls";
import { api, ApiError, errorMessage } from "../api";
import { createPortal } from "react-dom";
import type { AlertApi } from "./chartAlertUiApi";
import type {
  NativeAlertDialog,
  NativeAlertDialogHandle,
} from "./nativeAlertUI";
import {
  normalizeCondition,
  indicatorDefaults,
  relations,
  type AlertConfig,
  type AlertRow,
  type Capabilities,
  type IndicatorSpec,
  type LineGeometry,
  type Operand,
} from "./chartAlerts";

function IndicatorFields({
  value,
  onChange,
  metadata,
  side,
}: {
  side: "left" | "right";
  value: IndicatorSpec;
  onChange: (v: IndicatorSpec) => void;
  metadata?: Capabilities["indicator_metadata"];
}) {
  return (
    <fieldset className="alert-indicator-fields">
      <legend>指标参数快照</legend>
      <label>
        指标
        <AlertSelect
          aria-label="指标"
          value={value.name}
          onChange={(e) => {
            const name = e.target.value as IndicatorSpec["name"];
            onChange({
              name,
              version: "1",
              params: { ...indicatorDefaults[name] },
              output: name === "MACD" ? "macd" : "value",
            });
          }}
        >
          {Object.keys(indicatorDefaults).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </AlertSelect>
      </label>
      {Object.entries(value.params).map(([key, n]) => (
        <label key={key}>
          {metadata?.[value.name]?.parameter_schema[key]?.label || key}
          <AlertInput
            data-alert-field={`condition.${side}.indicator.params.${key}`}
            type="number"
            min={metadata?.[value.name]?.parameter_schema[key]?.min ?? 2}
            max={metadata?.[value.name]?.parameter_schema[key]?.max ?? 500}
            step={1}
            required
            value={n}
            onChange={(e) =>
              onChange({
                ...value,
                params: { ...value.params, [key]: Number(e.target.value) },
              })
            }
          />
        </label>
      ))}
      <label>
        输出
        <AlertSelect
          aria-label="输出"
          value={value.output}
          onChange={(e) => onChange({ ...value, output: e.target.value })}
        >
          {(value.name === "MACD"
            ? ["macd", "signal", "histogram"]
            : ["value"]
          ).map((key) => (
            <option key={key} value={key}>
              {metadata?.[value.name]?.series.find((item) => item.key === key)
                ?.label || key}
            </option>
          ))}
        </AlertSelect>
      </label>
      <p>
        手动选择指标时使用告警默认参数，需要自行核对图表。通过已映射的 Python
        指标创建时，初始值读取该指标当时的实际参数；同名内置指标不自动同步。
      </p>
      <p>
        以上可编辑值是告警判定的参数快照；保存后独立于图表参数，修改图表不会同步已保存告警。
      </p>
      <details>
        <summary>参数技术键与实际值</summary>
        <p>
          {Object.entries(value.params)
            .map(([key, n]) => `${key}=${n}`)
            .join(" · ")}{" "}
          · output={value.output}
        </p>
      </details>
    </fieldset>
  );
}
const defaultIndicator = (): IndicatorSpec => ({
  name: "SMA",
  version: "1",
  params: { period: 20 },
  output: "value",
});

export function ChartAlertDialog({
  initial,
  displayLabel,
  displayCode,
  automaticName = false,
  onAutomaticName,
  requestId,
  editing,
  theme,
  onDraft,
  onSaved,
  onClose,
  request = api,
  nativeDialog,
  onOpenError,
  onDelete,
  onReload,
}: {
  initial: AlertConfig;
  displayLabel?: string;
  displayCode?: string;
  automaticName?: boolean;
  onAutomaticName?: (automatic: boolean) => void;
  requestId: string;
  editing: { id: string; version: number } | null;
  theme: string;
  onDraft: (v: AlertConfig) => void;
  onSaved: (row: AlertRow) => void;
  onClose: () => void;
  request?: AlertApi;
  nativeDialog?: NativeAlertDialog;
  onOpenError?: (message: string) => void;
  onDelete?: () => Promise<void>;
  onReload?: (row: AlertRow) => void;
}) {
  const { zone } = useChartTime();
  const date = (stamp: number) => formatTimestamp(stamp, zone);
  const [expiryValid, setExpiryValid] = useState(true);
  const [expiryInputRevision, setExpiryInputRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    errorBox = useRef<HTMLParagraphElement>(null);
  const [draft, setDraft] = useState(() => ({
      ...initial,
      condition: normalizeCondition(initial.condition),
    })),
    [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [page, setPage] = useState<"condition" | "message" | "notifications">(
      "condition",
    ),
    [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    { field: string; message: string }[]
  >([]);
  const [editVersion, setEditVersion] = useState(editing?.version);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(initial.message),
    [name, setName] = useState(initial.name);
  const [web, setWeb] = useState(initial.notify_web),
    [phone, setPhone] = useState(initial.notify_ntfy),
    [late, setLate] = useState(initial.late_delivery);
  const mounted = useRef(true),
    submitting = useRef(false);
  const [native, setNative] = useState<NativeAlertDialogHandle | null>(null);
  const nativeRef = useRef<NativeAlertDialogHandle | null>(null);
  const mappedGeometry = useRef<{ key: string; line: LineGeometry } | null>(
    null,
  );
  useEffect(() => {
    mounted.current = true;
    if (nativeDialog) {
      nativeDialog({
        title: `${editing ? "编辑警报" : "创建警报"} · ${displayCode || displayLabel || initial.name}`,
        symbol: displayCode,
        onClose: () => {
          if (mounted.current) onClose();
        },
      })
        .then((handle) => {
          if (mounted.current) {
            nativeRef.current = handle;
            setNative(handle);
          } else handle.close();
        })
        .catch((error) => {
          if (mounted.current) {
            setError(errorMessage(error));
            onOpenError?.(errorMessage(error));
          }
        });
    } else dialog.current?.showModal();
    return () => {
      mounted.current = false;
      nativeRef.current?.close();
    };
  }, []);
  useEffect(() => {
    onDraft(draft);
  }, [draft]);
  useEffect(() => {
    let current = true;
    setCapabilities(null);
    request<Capabilities>("/chart-alerts/capabilities", {
      instrument: draft.instrument,
      series_kind: draft.series_kind,
      timeframe: draft.timeframe,
    })
      .then((value) => {
        if (current) {
          setCapabilities(value);
          setDraft((previous) =>
            previous.source
              ? previous
              : {
                  ...previous,
                  source:
                    value.sources.find(
                      (s) => s.series_kind === previous.series_kind,
                    )?.source || "",
                },
          );
        }
      })
      .catch((e) => {
        if (current) setError(errorMessage(e));
      });
    return () => {
      current = false;
    };
  }, [draft.instrument, draft.timeframe, draft.series_kind]);
  const source = capabilities?.sources.find(
    (s) => s.source === draft.source && s.series_kind === draft.series_kind,
  );
  const interval = ["enter", "exit", "break_upper", "break_lower"].includes(
    draft.condition.relation,
  );
  const offset = draft.condition.offset;
  const priceUnit = (value?: Operand | null) =>
    !value?.indicator || ["SMA", "EMA"].includes(value.indicator.name);
  const offsetSupported =
    ["cross_up", "cross_down", "above", "below"].includes(
      draft.condition.relation,
    ) &&
    priceUnit(draft.condition.left) &&
    priceUnit(draft.condition.right) &&
    ["constant", "line", "indicator"].includes(
      draft.condition.right?.kind || "",
    );
  const atrFrames = source?.atr_frames || [];
  function change(value: Partial<AlertConfig>) {
    setDraft((p) => ({
      ...p,
      ...value,
      condition: normalizeCondition(value.condition ?? p.condition),
    }));
  }
  function expirationPreset(expires_at: number | null) {
    change({ expires_at });
    setExpiryValid(true);
    setExpiryInputRevision((value) => value + 1);
  }
  function operand(side: "left" | "right", value: Operand) {
    change({ condition: { ...draft.condition, [side]: value } });
  }
  async function submit() {
    if (submitting.current) return;
    if (!expiryValid) {
      setError("请修正到期时间并明确夏令时重复时刻");
      return;
    }
    if (offset && (!offsetSupported || !atrFrames.includes(offset.timeframe))) {
      setError(
        "ATR 阈值需要价格单位的有向比较，并选择此来源支持的 ATR K线周期",
      );
      errorBox.current?.focus();
      return;
    }
    if (!source?.available) {
      setError(
        source?.reason || "行情来源尚未可用，请等待能力查询或显式选择来源",
      );
      errorBox.current?.focus();
      return;
    }
    setBusy(true);
    submitting.current = true;
    setError("");
    setFieldErrors([]);
    setConflict(false);
    try {
      let config = { ...draft, condition: normalizeCondition(draft.condition) };
      const line = draft.condition.right?.line;
      if (draft.condition.right?.kind === "line" && line) {
        // Bar indices belong to a market/period. Recompute them from timestamps
        // before saving, including after a source or timeframe change.
        const query = {
          instrument: draft.instrument,
          source: draft.source,
          series_kind: draft.series_kind,
          timeframe: draft.timeframe,
          published: draft.published ?? false,
          ...(draft.composite_revision_id
            ? { composite_revision_id: draft.composite_revision_id }
            : {}),
          kind: line.kind,
          scale: line.scale,
          extend_left: line.extend_left,
          extend_right: line.extend_right,
          points: line.points.map(({ time, price }) => ({ time, price })),
        };
        const key = JSON.stringify(query);
        const mapped =
          mappedGeometry.current?.key === key
            ? mappedGeometry.current.line
            : await request<LineGeometry>("/chart-alerts/geometry", query);
        if (!mounted.current) return;
        // A retry after an uncertain save must reuse the same configuration.
        mappedGeometry.current = { key, line: mapped };
        config = {
          ...config,
          condition: {
            ...config.condition,
            right: { kind: "line", line: mapped },
          },
        };
        setDraft(config);
      }
      const saved = await request<AlertRow>(
        editing ? `/chart-alerts/${editing.id}/edit` : "/chart-alerts",
        editing
          ? { version: editVersion, config }
          : { request_id: requestId, config },
      );
      if (mounted.current) onSaved(saved);
    } catch (e) {
      if (mounted.current) {
        setError(errorMessage(e));
        setFieldErrors(e instanceof ApiError ? e.fieldErrors : []);
        setConflict(e instanceof ApiError && e.status === 409);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!native) return;
    native.setBusy(busy);
    native.onEscape = () =>
      page !== "condition" ? returnToCondition() : onClose();
    native.setTitle(
      page === "message"
        ? "编辑消息"
        : page === "notifications"
          ? "通知"
          : `${editing ? "编辑警报" : "创建警报"} · ${displayCode || displayLabel || draft.name}`,
      page === "condition" ? displayCode : undefined,
    );
    native.shell.title = displayLabel || draft.name;
    native.recenter();
  }, [native, page, busy]);
  useEffect(() => {
    if (
      !automaticName ||
      editing ||
      !displayCode ||
      draft.condition.left.kind !== "price" ||
      draft.condition.right?.kind !== "constant"
    )
      return;
    const next = `${displayCode} ${relations[draft.condition.relation] || draft.condition.relation} ${draft.condition.right.value || ""}`;
    if (draft.name !== next) {
      setDraft((previous) => ({ ...previous, name: next }));
      setName(next);
    }
  }, [automaticName, editing?.id, displayCode, draft.condition]);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      const controls = [
        ...(formRef.current?.querySelectorAll<HTMLElement>(
          "[data-alert-field]",
        ) || []),
      ];
      const affected = controls.filter((control) =>
        fieldErrors.some((issue) => {
          const field = control.dataset.alertField!;
          return field === issue.field || field.startsWith(issue.field + ".");
        }),
      );
      const inputs = affected
        .map((control) =>
          control.matches("input,select,textarea,button")
            ? control
            : control.querySelector<HTMLElement>(
                "input,select,textarea,button",
              ),
        )
        .filter((control): control is HTMLElement => !!control);
      for (const control of inputs) {
        control.setAttribute("aria-invalid", "true");
        control.setAttribute(
          "aria-describedby",
          [control.getAttribute("aria-describedby"), "alert-validation-error"]
            .filter(Boolean)
            .join(" "),
        );
        control.dataset.serverInvalid = "true";
      }
      const target = inputs[0];
      target?.closest("details")?.setAttribute("open", "");
      (target || errorBox.current)?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      for (const control of formRef.current?.querySelectorAll<HTMLElement>(
        "[data-server-invalid]",
      ) || []) {
        control.removeAttribute("aria-invalid");
        const description = (control.getAttribute("aria-describedby") || "")
          .split(" ")
          .filter((id) => id !== "alert-validation-error")
          .join(" ");
        if (description) control.setAttribute("aria-describedby", description);
        else control.removeAttribute("aria-describedby");
        delete control.dataset.serverInvalid;
      }
    };
  }, [error, fieldErrors, native, busy]);
  const pageTrigger = useRef<HTMLButtonElement | null>(null);
  const returning = useRef(false);
  function returnToCondition() {
    returning.current = true;
    setPage("condition");
  }
  function openPage(
    value: "message" | "notifications",
    trigger: HTMLButtonElement,
  ) {
    pageTrigger.current = trigger;
    setName(draft.name);
    setMessage(draft.message);
    setWeb(draft.notify_web);
    setPhone(draft.notify_ntfy);
    setLate(draft.late_delivery);
    setPage(value);
  }
  useEffect(() => {
    native?.recenter();
    const restore = returning.current && page === "condition";
    returning.current = false;
    const timer = setTimeout(() => {
      if (restore)
        formRef.current
          ?.querySelector<HTMLButtonElement>(
            `[aria-label="${pageTrigger.current?.getAttribute("aria-label")}"]`,
          )
          ?.focus();
      else
        formRef.current
          ?.querySelector<HTMLElement>("input,select,textarea,button")
          ?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [page, native]);
  const compareTarget = (
    <label
      className={
        draft.condition.right?.kind === "constant" ? "alert-compare-type" : ""
      }
    >
      <span>比较目标</span>
      <AlertSelect
        aria-label="比较目标"
        value={draft.condition.right?.kind}
        onChange={(event) =>
          operand(
            "right",
            event.target.value === "indicator"
              ? {
                  kind: "indicator",
                  indicator: defaultIndicator(),
                }
              : event.target.value === "price"
                ? { kind: "price" }
                : { kind: "constant", value: "" },
          )
        }
      >
        <option value="constant">常数 / 价位</option>
        <option value="price">价格</option>
        <option value="indicator">指标输出</option>
        {draft.condition.right?.line && (
          <option value="line">关联画线快照</option>
        )}
      </AlertSelect>
    </label>
  );
  const form = (
    <NativeControlsDisabled.Provider value={busy}>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          if (page === "condition" && !busy) void submit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.key === "Enter" &&
            (event.target as HTMLElement).tagName === "INPUT"
          ) {
            event.preventDefault();
            if (
              page === "condition" &&
              formRef.current?.reportValidity() &&
              !busy
            )
              void submit();
          }
        }}
      >
        {!nativeDialog && (
          <header>
            <h2 id="chart-alert-title" title={displayLabel || draft.name}>
              {page === "condition" && displayCode && (
                <AlertSymbolIcon code={displayCode} />
              )}
              {page === "message"
                ? "编辑消息"
                : page === "notifications"
                  ? "通知"
                  : `${editing ? "编辑警报" : "创建警报"} · ${displayCode || displayLabel || draft.name}`}
            </h2>
            <button
              type="button"
              disabled={busy}
              aria-label="关闭告警表单"
              onClick={onClose}
            >
              关闭
            </button>
          </header>
        )}
        {page !== "condition" && (
          <button
            className="alert-subpage-back"
            type="button"
            onClick={returnToCondition}
          >
            <ChevronLeft size={16} aria-hidden />
            返回
          </button>
        )}
        <fieldset disabled={busy} className="alert-form-body">
          {page === "message" ? (
            <div className="alert-message-page">
              <label>
                警报名称
                <AlertInput
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </label>
              <label>
                消息正文
                <AlertTextarea
                  maxLength={2000}
                  rows={6}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <AlertMenu
                label="添加占位符"
                items={[
                  "symbol",
                  "source",
                  "timeframe",
                  "condition",
                  "value",
                  "threshold",
                  "price",
                  "event_time",
                  "delay",
                ].map((key) => ({
                  label: "{" + key + "}",
                  run: () => setMessage((value) => value + "{" + key + "}"),
                }))}
              />
              <p>正文为空时使用自动消息。</p>
            </div>
          ) : page === "notifications" ? (
            <div className="alert-notification-page">
              <AlertCheckbox
                label="网页声音与提醒"
                checked={web}
                onChange={setWeb}
              />
              <p>在打开的网页中显示提醒，并使用已有声音设置。</p>
              <AlertCheckbox
                label="已有 ntfy 推送通道"
                checked={phone}
                onChange={setPhone}
              />
              <p>需要后台已配置通道并启用投递。服务接受与设备接收分别记录。</p>
              <label>
                迟到事件
                <AlertSelect
                  aria-label="迟到事件"
                  value={late}
                  onChange={(event) =>
                    setLate(event.target.value as AlertConfig["late_delivery"])
                  }
                >
                  <option value="log_only">仅记录日志</option>
                  <option value="notify">仍发送通知</option>
                </AlertSelect>
              </label>
            </div>
          ) : (
            <>
              <fieldset disabled={busy} className="alert-condition-fields">
                <legend className="sr-only">条件</legend>
                <label>
                  <span>条件</span>
                  <AlertSelect
                    aria-label="条件"
                    value={draft.condition.left.kind}
                    onChange={(event) =>
                      operand(
                        "left",
                        event.target.value === "indicator"
                          ? { kind: "indicator", indicator: defaultIndicator() }
                          : { kind: "price" },
                      )
                    }
                  >
                    <option value="price">价格</option>
                    <option value="indicator" disabled={interval}>
                      指标输出
                    </option>
                  </AlertSelect>
                </label>
                {draft.condition.left.indicator && (
                  <IndicatorFields
                    side="left"
                    value={draft.condition.left.indicator}
                    metadata={capabilities?.indicator_metadata}
                    onChange={(indicator) =>
                      operand("left", { kind: "indicator", indicator })
                    }
                  />
                )}
                <label>
                  <span className="sr-only">关系</span>
                  <AlertSelect
                    aria-label="关系"
                    value={draft.condition.relation}
                    onChange={(event) => {
                      change({
                        condition: normalizeCondition(
                          draft.condition,
                          event.target.value,
                        ),
                      });
                    }}
                  >
                    {Object.entries(relations).map(([value, label]) => (
                      <option
                        key={value}
                        value={value}
                        disabled={
                          !!offset &&
                          ![
                            "cross_up",
                            "cross_down",
                            "above",
                            "below",
                          ].includes(value)
                        }
                      >
                        {label}
                      </option>
                    ))}
                  </AlertSelect>
                </label>
                {interval ? (
                  <div className="alert-two-fields">
                    <label>
                      下限
                      <AlertInput
                        required
                        inputMode="decimal"
                        data-alert-field="condition.lower"
                        value={draft.condition.lower ?? ""}
                        onChange={(event) =>
                          change({
                            condition: {
                              ...draft.condition,
                              lower: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      上限
                      <AlertInput
                        required
                        inputMode="decimal"
                        data-alert-field="condition.upper"
                        value={draft.condition.upper ?? ""}
                        onChange={(event) =>
                          change({
                            condition: {
                              ...draft.condition,
                              upper: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    {draft.condition.right?.kind !== "constant" &&
                      compareTarget}
                    {draft.condition.right?.kind === "constant" && (
                      <label>
                        <span className="sr-only">比较值</span>
                        <AlertInput
                          data-alert-field="condition.right.value"
                          aria-label="比较值"
                          required
                          inputMode="decimal"
                          value={draft.condition.right.value ?? ""}
                          onChange={(event) =>
                            operand("right", {
                              kind: "constant",
                              value: event.target.value,
                            })
                          }
                        />
                      </label>
                    )}
                    {draft.condition.right?.indicator && (
                      <IndicatorFields
                        side="right"
                        value={draft.condition.right.indicator}
                        metadata={capabilities?.indicator_metadata}
                        onChange={(indicator) =>
                          operand("right", { kind: "indicator", indicator })
                        }
                      />
                    )}
                    {draft.condition.right?.line && (
                      <p className="alert-line-summary">
                        {draft.condition.right.line.kind} ·{" "}
                        {draft.condition.right.line.scale === "log"
                          ? "对数轴"
                          : "线性轴"}
                        <br />
                        拖动结束后提交新版本
                      </p>
                    )}
                  </>
                )}
              </fieldset>
              <div className="alert-add-condition">
                <button
                  type="button"
                  aria-disabled="true"
                  aria-describedby="alert-single-condition-help"
                  onClick={() => setError("当前版本仅支持单条件")}
                >
                  ＋ 添加条件
                </button>
                <span
                  id="alert-single-condition-help"
                  title="当前版本仅支持单条件"
                  aria-label="当前版本仅支持单条件"
                >
                  ⓘ
                </span>
              </div>
              {offset && (
                <p className="alert-atr-active">
                  已启用 ATR · {offset.multiplier} × {offset.timeframe} ATR(
                  {offset.period})；实际边界以运行详情为准
                </p>
              )}
              <div className="alert-summary-fields">
                <label>
                  <span>触发</span>
                  <AlertSelect
                    aria-label="触发次数"
                    value={draft.max_triggers}
                    onChange={(event) =>
                      change({
                        max_triggers: Number(event.target.value) as 1 | 2 | 3,
                      })
                    }
                  >
                    <option value={1}>仅一次</option>
                    <option value={2}>最多 2 次</option>
                    <option value={3}>最多 3 次</option>
                  </AlertSelect>
                </label>
                <div className="alert-summary-row">
                  <span>到期时间</span>
                  <AlertMenu
                    label="到期时间"
                    items={[
                      {
                        label: "不限",
                        checked: !draft.expires_at,
                        run: () => expirationPreset(null),
                      },
                      ...[
                        ["1 天", 1],
                        ["1 周", 7],
                        ["1 月", 30],
                      ].map(([label, days]) => ({
                        label: String(label),
                        run: () =>
                          expirationPreset(
                            Date.now() + Number(days) * 86400000,
                          ),
                      })),
                      {
                        label: "自定义日期",
                        run: () => {
                          const node =
                            formRef.current?.querySelector<HTMLDetailsElement>(
                              ".alert-advanced-options",
                            );
                          if (node) node.open = true;
                          setTimeout(
                            () =>
                              formRef.current
                                ?.querySelector<HTMLInputElement>(
                                  '[type="datetime-local"]',
                                )
                                ?.focus(),
                            0,
                          );
                        },
                      },
                    ]}
                  >
                    {draft.expires_at ? date(draft.expires_at) : "不限"}
                    <ChevronRight size={14} aria-hidden />
                  </AlertMenu>
                </div>
                <div className="alert-summary-row">
                  <span>消息</span>
                  <button
                    type="button"
                    aria-label="消息"
                    onClick={(event) =>
                      openPage("message", event.currentTarget)
                    }
                    title={draft.message || draft.name}
                  >
                    {draft.message || draft.name}
                    <ChevronRight size={14} aria-hidden />
                  </button>
                </div>
                <div className="alert-summary-row">
                  <span>通知</span>
                  <button
                    type="button"
                    aria-label="通知"
                    onClick={(event) =>
                      openPage("notifications", event.currentTarget)
                    }
                  >
                    {[
                      draft.notify_web ? "网页" : "",
                      draft.notify_ntfy ? "ntfy" : "",
                    ]
                      .filter(Boolean)
                      .join(" / ") || "仅日志"}
                    <ChevronRight size={14} aria-hidden />
                  </button>
                </div>
              </div>
              <details className="alert-advanced-options">
                <summary>
                  行情与高级选项 · {draft.source || "查询中"} ·{" "}
                  {draft.timeframe} ·{" "}
                  {draft.mode === "close" ? "收盘确认" : "盘中观察"}
                </summary>
                <fieldset className="alert-indicator-fields" disabled={busy}>
                  <legend className="sr-only">突破阈值参数</legend>
                  <label>
                    突破阈值
                    <AlertSelect
                      aria-label="突破阈值"
                      value={offset ? "atr" : "none"}
                      onChange={(event) =>
                        change({
                          condition: {
                            ...draft.condition,
                            offset:
                              event.target.value === "atr"
                                ? {
                                    kind: "atr",
                                    version: "1",
                                    timeframe: atrFrames.includes("D1")
                                      ? "D1"
                                      : atrFrames[0],
                                    period: 14,
                                    multiplier: "0.2",
                                    reference: "closed_at_evaluation_bar_open",
                                  }
                                : null,
                          },
                        })
                      }
                    >
                      <option value="none">无</option>
                      <option
                        value="atr"
                        disabled={!offsetSupported || !atrFrames.length}
                      >
                        ATR
                      </option>
                    </AlertSelect>
                  </label>
                  {!offsetSupported && (
                    <p>ATR 仅支持价格单位的上穿、下穿、高于或低于比较。</p>
                  )}
                  {offset && (
                    <>
                      <label>
                        ATR K线周期
                        <AlertSelect
                          aria-label="ATR K线周期"
                          value={offset.timeframe}
                          onChange={(event) =>
                            change({
                              condition: {
                                ...draft.condition,
                                offset: {
                                  ...offset,
                                  timeframe: event.target.value,
                                },
                              },
                            })
                          }
                        >
                          {!atrFrames.includes(offset.timeframe) && (
                            <option value={offset.timeframe} disabled>
                              {offset.timeframe}（来源不支持）
                            </option>
                          )}
                          {atrFrames.map((frame) => (
                            <option key={frame}>{frame}</option>
                          ))}
                        </AlertSelect>
                      </label>
                      <label>
                        ATR 计算长度
                        <AlertInput
                          aria-label="ATR 计算长度"
                          type="number"
                          required
                          min={2}
                          max={500}
                          step={1}
                          value={offset.period}
                          onChange={(event) =>
                            change({
                              condition: {
                                ...draft.condition,
                                offset: {
                                  ...offset,
                                  period: Number(event.target.value),
                                },
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        ATR 乘数
                        <AlertInput
                          aria-label="ATR 乘数"
                          type="number"
                          required
                          min="0.01"
                          max="100"
                          step="0.01"
                          value={offset.multiplier}
                          onChange={(event) =>
                            change({
                              condition: {
                                ...draft.condition,
                                offset: {
                                  ...offset,
                                  multiplier: event.target.value,
                                },
                              },
                            })
                          }
                        />
                      </label>
                      <p>
                        {draft.timeframe}{" "}
                        {draft.mode === "close" ? "收盘确认" : "盘中观察"} ·{" "}
                        {relations[draft.condition.relation]}
                        {draft.condition.relation === "cross_up" ||
                        draft.condition.relation === "above"
                          ? " + "
                          : " − "}
                        {offset.multiplier} × {offset.timeframe} ATR(
                        {offset.period})。ATR 取判定柱开盘前最近已收盘值。
                      </p>
                    </>
                  )}
                </fieldset>
                <label>
                  行情来源
                  <AlertSelect
                    aria-label="行情来源"
                    value={`${draft.series_kind}:${draft.source}`}
                    disabled={!capabilities || busy}
                    onChange={(event) => {
                      const [series_kind, source] =
                        event.target.value.split(":");
                      change({
                        source,
                        series_kind: series_kind as AlertConfig["series_kind"],
                        association: null,
                        calculation_origin: null,
                        published: series_kind === "managed",
                      });
                    }}
                  >
                    {!draft.source && (
                      <option value={`${draft.series_kind}:`}>
                        正在查询图表来源…
                      </option>
                    )}
                    {capabilities?.sources.map((source) => (
                      <option
                        key={`${source.series_kind}:${source.source}`}
                        value={`${source.series_kind}:${source.source}`}
                        disabled={!source.available}
                      >
                        {source.source} ·{" "}
                        {source.series_kind === "managed"
                          ? "自建系列"
                          : source.series_kind === "composite"
                            ? "组合行情"
                            : "平台原生"}{" "}
                        · {source.basis}
                        {source.reason ? " · " + source.reason : ""}
                      </option>
                    ))}
                  </AlertSelect>
                </label>
                {!interval &&
                  draft.condition.right?.kind === "constant" &&
                  compareTarget}
                <label>
                  判定周期
                  <AlertSelect
                    aria-label="判定周期"
                    value={draft.timeframe}
                    onChange={(event) =>
                      change({
                        timeframe: event.target.value,
                        association: null,
                        calculation_origin: null,
                      })
                    }
                  >
                    {[
                      "M1",
                      "M5",
                      "M15",
                      "M30",
                      "H1",
                      "H4",
                      "D1",
                      "W1",
                      "MN",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </AlertSelect>
                </label>
                <label>
                  判定
                  <AlertSelect
                    aria-label="判定"
                    value={draft.mode}
                    onChange={(event) =>
                      change({
                        mode: event.target.value as AlertConfig["mode"],
                      })
                    }
                  >
                    <option value="close">收盘确认</option>
                    <option value="intrabar">盘中观察</option>
                  </AlertSelect>
                </label>
                <p>
                  {source?.observation_basis}。
                  {draft.mode === "close"
                    ? "等待来源确认完整 K 线。"
                    : "后台按收到的观察值判定，不代表完整市场逐笔。"}
                </p>
                <label data-alert-field="expires_at">
                  到期时间
                  <ZonedDateTimeInput
                    key={expiryInputRevision}
                    label="到期时间"
                    zone={zone}
                    value={draft.expires_at ?? null}
                    onChange={(expires_at) => change({ expires_at })}
                    onValidityChange={setExpiryValid}
                  />
                </label>
                {draft.series_kind === "composite" && (
                  <>
                    <label>
                      指标依赖含原价接缝时
                      <AlertSelect
                        aria-label="指标依赖含原价接缝时"
                        value={draft.seam_policy || "reject"}
                        onChange={(event) =>
                          change({
                            seam_policy: event.target.value as
                              "reject" | "accept_raw",
                          })
                        }
                      >
                        <option value="reject">
                          等待完整同源依赖，不接受接缝影响
                        </option>
                        <option value="accept_raw">
                          接受历史与实时来源原价差对指标的影响
                        </option>
                      </AlertSelect>
                    </label>
                    <p>
                      保存时固定组合修订：{draft.composite_revision_id}
                      。跨接缝先建立基准，不补发过期事件。
                    </p>
                  </>
                )}
                <p>
                  发起图表身份已固定，后台监控在关闭网页后继续。创建时条件已成立不会立即触发。
                </p>
              </details>
              {source?.reason && <p role="status">{source.reason}</p>}
            </>
          )}
          {conflict && editing && (
            <AlertButton
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const latest = await request<AlertRow>(
                    `/chart-alerts/${editing.id}`,
                  );
                  if (!mounted.current) return;
                  if (latest.status === "archived")
                    throw Error("告警已归档，请复制草稿创建新告警");
                  setEditVersion(latest.version);
                  onReload?.(latest);
                  setConflict(false);
                  setError(
                    `已读取版本 ${latest.version}，草稿已保留；请核对后再次保存`,
                  );
                } catch (e) {
                  if (mounted.current) setError(errorMessage(e));
                } finally {
                  if (mounted.current) setBusy(false);
                }
              }}
            >
              保留草稿并重新读取
            </AlertButton>
          )}
          {error && (
            <p
              id="alert-validation-error"
              ref={errorBox}
              tabIndex={-1}
              className="alert-error"
              role="alert"
            >
              {error}
            </p>
          )}
        </fieldset>
        <footer>
          {page === "condition" ? (
            <>
              {onDelete && (
                <button
                  className="alert-delete"
                  type="button"
                  aria-label="删除告警"
                  disabled={busy}
                  onClick={async () => {
                    if (submitting.current) return;
                    submitting.current = true;
                    setBusy(true);
                    setError("");
                    try {
                      await onDelete();
                    } catch (error) {
                      if (mounted.current) setError(errorMessage(error));
                    } finally {
                      submitting.current = false;
                      if (mounted.current) setBusy(false);
                    }
                  }}
                >
                  <Trash2 size={18} aria-hidden />
                </button>
              )}
              <AlertButton
                title="取消并保留草稿"
                disabled={busy}
                onClick={onClose}
              >
                取消
              </AlertButton>
              <AlertButton
                primary
                title={editing ? "保存为新的规则版本" : "创建告警"}
                disabled={busy || !source?.available || !expiryValid}
                onClick={() => {
                  if (formRef.current?.reportValidity()) void submit();
                }}
              >
                {busy ? "正在提交…" : editing ? "保存" : "创建"}
              </AlertButton>
            </>
          ) : (
            <>
              <AlertButton onClick={returnToCondition}>取消</AlertButton>
              <AlertButton
                primary
                onClick={() => {
                  if (page === "message") {
                    if (!name.trim()) {
                      setError("请填写警报名称");
                      return;
                    }
                    if (name !== draft.name) onAutomaticName?.(false);
                    change({ name, message });
                  } else
                    change({
                      notify_web: web,
                      notify_ntfy: phone,
                      late_delivery: late,
                    });
                  setError("");
                  returnToCondition();
                }}
              >
                应用到草稿
              </AlertButton>
            </>
          )}
        </footer>
      </form>
    </NativeControlsDisabled.Provider>
  );
  if (nativeDialog)
    return native
      ? createPortal(
          <section className="chart-alert-dialog" data-theme={theme}>
            {form}
          </section>,
          native.body,
        )
      : null;
  return (
    <dialog
      ref={dialog}
      className="chart-alert-dialog"
      data-theme={theme}
      aria-labelledby="chart-alert-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) page !== "condition" ? returnToCondition() : onClose();
      }}
    >
      {form}
    </dialog>
  );
}
