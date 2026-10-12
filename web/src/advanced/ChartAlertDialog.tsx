import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { AlertMenu } from "./AlertMenu";
import {
  AlertSelect,
  AlertCheckbox,
  AlertButton,
  AlertInput,
  AlertTextarea,
  NativeControlsDisabled,
} from "./NativeAlertControls";
import { api, date } from "../api";
import { createPortal } from "react-dom";
import type { AlertApi } from "./chartAlertUiApi";
import type {
  NativeAlertDialog,
  NativeAlertDialogHandle,
} from "./nativeAlertUI";
import {
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
}: {
  value: IndicatorSpec;
  onChange: (v: IndicatorSpec) => void;
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
          {key}
          <AlertInput
            type="number"
            min={2}
            max={500}
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
            <option key={key}>{key}</option>
          ))}
        </AlertSelect>
      </label>
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
}: {
  initial: AlertConfig;
  displayLabel?: string;
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
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    errorBox = useRef<HTMLParagraphElement>(null);
  const [draft, setDraft] = useState(initial),
    [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [page, setPage] = useState<"condition" | "message" | "notifications">(
      "condition",
    ),
    [error, setError] = useState("");
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
        title: `${editing ? "编辑警报" : "创建警报"} · ${displayLabel || initial.name}`,
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
            setError(String(error));
            onOpenError?.(String(error));
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
        if (current) setError(String(e));
      });
    return () => {
      current = false;
    };
  }, [draft.instrument, draft.timeframe]);
  const source = capabilities?.sources.find(
    (s) => s.source === draft.source && s.series_kind === draft.series_kind,
  );
  const interval = ["enter", "exit", "break_upper", "break_lower"].includes(
    draft.condition.relation,
  );
  function change(value: Partial<AlertConfig>) {
    setDraft((p) => ({ ...p, ...value }));
  }
  function operand(side: "left" | "right", value: Operand) {
    change({ condition: { ...draft.condition, [side]: value } });
  }
  async function submit() {
    if (submitting.current) return;
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
    try {
      let config = draft;
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
          ...draft,
          condition: {
            ...draft.condition,
            right: { kind: "line", line: mapped },
          },
        };
        setDraft(config);
      }
      const saved = await request<AlertRow>(
        editing ? `/chart-alerts/${editing.id}/edit` : "/chart-alerts",
        editing
          ? { version: editing.version, config }
          : { request_id: requestId, config },
      );
      if (mounted.current) onSaved(saved);
    } catch (e) {
      if (mounted.current) {
        setError(String(e));
        setTimeout(() => errorBox.current?.focus(), 0);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const expires = draft.expires_at
    ? new Date(
        draft.expires_at -
          new Date(draft.expires_at).getTimezoneOffset() * 60_000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
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
          : `${editing ? "编辑警报" : "创建警报"} · ${displayLabel || draft.name}`,
    );
    native.recenter();
  }, [native, page, busy]);
  const formRef = useRef<HTMLFormElement>(null);
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
            <h2 id="chart-alert-title">
              {page === "message"
                ? "编辑消息"
                : page === "notifications"
                  ? "通知"
                  : `${editing ? "编辑警报" : "创建警报"} · ${displayLabel || draft.name}`}
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
                  onChange={(event) => setName(event.target.value)}
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
                    value={draft.condition.left.indicator}
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
                      const relation = event.target.value,
                        range = [
                          "enter",
                          "exit",
                          "break_upper",
                          "break_lower",
                        ].includes(relation);
                      change({
                        condition: range
                          ? {
                              relation,
                              left: { kind: "price" },
                              lower: draft.condition.lower || "",
                              upper: draft.condition.upper || "",
                            }
                          : {
                              relation,
                              left: draft.condition.left,
                              right: draft.condition.right || {
                                kind: "constant",
                                value: "",
                              },
                            },
                      });
                    }}
                  >
                    {Object.entries(relations).map(([value, label]) => (
                      <option key={value} value={value}>
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
                        value={draft.condition.lower || ""}
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
                        value={draft.condition.upper || ""}
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
                          aria-label="比较值"
                          required
                          inputMode="decimal"
                          value={draft.condition.right.value || ""}
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
                        value={draft.condition.right.indicator}
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
                        run: () => change({ expires_at: null }),
                      },
                      ...[
                        ["1 天", 1],
                        ["1 周", 7],
                        ["1 月", 30],
                      ].map(([label, days]) => ({
                        label: String(label),
                        run: () =>
                          change({
                            expires_at: Date.now() + Number(days) * 86400000,
                          }),
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
                <label>
                  到期时间（{Intl.DateTimeFormat().resolvedOptions().timeZone}）
                  <AlertInput
                    type="datetime-local"
                    value={expires}
                    onChange={(event) =>
                      change({
                        expires_at: event.target.value
                          ? new Date(event.target.value).getTime()
                          : null,
                      })
                    }
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
          {error && (
            <p
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
                      if (mounted.current) setError(String(error));
                    } finally {
                      submitting.current = false;
                      if (mounted.current) setBusy(false);
                    }
                  }}
                >
                  <Trash2 size={18} aria-hidden />
                </button>
              )}
              <AlertButton disabled={busy} onClick={onClose}>
                取消（保留草稿）
              </AlertButton>
              <AlertButton
                primary
                disabled={busy || !source?.available}
                onClick={() => {
                  if (formRef.current?.reportValidity()) void submit();
                }}
              >
                {busy ? "正在提交…" : editing ? "保存新版本" : "创建告警"}
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
