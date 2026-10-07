import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  indicatorDefaults,
  relations,
  type AlertConfig,
  type AlertRow,
  type Capabilities,
  type IndicatorSpec,
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
        <select
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
        </select>
      </label>
      {Object.entries(value.params).map(([key, n]) => (
        <label key={key}>
          {key}
          <input
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
        <select
          value={value.output}
          onChange={(e) => onChange({ ...value, output: e.target.value })}
        >
          {(value.name === "MACD"
            ? ["macd", "signal", "histogram"]
            : ["value"]
          ).map((key) => (
            <option key={key}>{key}</option>
          ))}
        </select>
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
  requestId,
  editing,
  theme,
  onDraft,
  onSaved,
  onClose,
}: {
  initial: AlertConfig;
  requestId: string;
  editing: { id: string; version: number } | null;
  theme: string;
  onDraft: (v: AlertConfig) => void;
  onSaved: (row: AlertRow) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    errorBox = useRef<HTMLParagraphElement>(null);
  const [draft, setDraft] = useState(initial),
    [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [page, setPage] = useState<"condition" | "message">("condition"),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(initial.message);
  const [web, setWeb] = useState(initial.notify_web),
    [phone, setPhone] = useState(initial.notify_ntfy),
    [late, setLate] = useState(initial.late_delivery);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDraft(draft);
  }, [draft]);
  useEffect(() => {
    let current = true;
    setCapabilities(null);
    api<Capabilities>("/chart-alerts/capabilities", {
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
    if (!source?.available) {
      setError(
        source?.reason || "行情来源尚未可用，请等待能力查询或显式选择来源",
      );
      errorBox.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api<AlertRow>(
        editing ? `/chart-alerts/${editing.id}/edit` : "/chart-alerts",
        editing
          ? { version: editing.version, config: draft }
          : { request_id: requestId, config: draft },
      );
      if (mounted.current) onSaved(saved);
    } catch (e) {
      if (mounted.current) {
        setError(String(e));
        setTimeout(() => errorBox.current?.focus(), 0);
      }
    } finally {
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
  return (
    <dialog
      ref={dialog}
      className="chart-alert-dialog"
      data-theme={theme}
      aria-labelledby="chart-alert-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) page === "message" ? setPage("condition") : onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2 id="chart-alert-title">
            {page === "message"
              ? "消息与通知"
              : editing
                ? "编辑告警"
                : "创建告警"}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              page === "message" ? setPage("condition") : onClose()
            }
            aria-label="关闭告警表单"
          >
            关闭
          </button>
        </header>
        {page === "message" ? (
          <>
            <label>
              消息正文
              <textarea
                maxLength={2000}
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <p>
              可用占位符：
              {
                "{symbol} {source} {timeframe} {condition} {value} {threshold} {price} {event_time} {delay}"
              }
              。为空时使用自动消息。
            </p>
            <label className="alert-check">
              <input
                type="checkbox"
                checked={web}
                onChange={(e) => setWeb(e.target.checked)}
              />
              网页声音与提醒
            </label>
            <label className="alert-check">
              <input
                type="checkbox"
                checked={phone}
                onChange={(e) => setPhone(e.target.checked)}
              />
              已有 ntfy 推送通道
            </label>
            <p>
              需要后台已配置通道并启用投递；“推送服务已接受”与设备接收分别记录。
            </p>
            <label>
              迟到事件
              <select
                value={late}
                onChange={(e) =>
                  setLate(e.target.value as AlertConfig["late_delivery"])
                }
              >
                <option value="log_only">仅记录日志</option>
                <option value="notify">仍发送通知</option>
              </select>
            </label>
            <footer>
              <button type="button" onClick={() => setPage("condition")}>
                取消子页更改
              </button>
              <button
                type="button"
                onClick={() => {
                  change({
                    message,
                    notify_web: web,
                    notify_ntfy: phone,
                    late_delivery: late,
                  });
                  setPage("condition");
                }}
              >
                应用到草稿
              </button>
            </footer>
          </>
        ) : (
          <>
            <label>
              名称
              <input
                required
                maxLength={100}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>
            <div className="alert-context-summary">
              {draft.instrument} · {draft.timeframe}
              <br />
              发起图表身份已固定，后台监控在关闭网页后继续。
            </div>
            <label>
              行情来源
              <select
                value={`${draft.series_kind}:${draft.source}`}
                disabled={!capabilities || busy}
                onChange={(e) => {
                  const [series_kind, source] = e.target.value.split(":");
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
                {capabilities?.sources.map((s) => (
                  <option
                    key={`${s.series_kind}:${s.source}`}
                    value={`${s.series_kind}:${s.source}`}
                    disabled={!s.available}
                  >
                    {s.source} ·{" "}
                    {s.series_kind === "managed" ? "自建系列" : s.series_kind === "composite" ? "组合行情" : "平台原生"} ·{" "}
                    {s.basis}
                    {s.reason ? ` · ${s.reason}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {source?.reason && <p role="status">{source.reason}</p>}
            {draft.series_kind === "composite" && (
              <fieldset disabled={busy}>
                <legend>组合输入与接缝</legend>
                <p>保存时固定组合修订；历史日更不会更换正在监控的基线。修订或恢复后先建立新基准，不补发过期事件。</p>
                {draft.composite_revision_id && <p>修订：{draft.composite_revision_id}</p>}
                <label>
                  指标依赖含原价接缝时
                  <select value={draft.seam_policy || "reject"}
                    onChange={event=>change({seam_policy:event.target.value as "reject" | "accept_raw"})}>
                    <option value="reject">等待完整同源依赖，不接受接缝影响</option>
                    <option value="accept_raw">接受历史与实时来源原价差对指标的影响</option>
                  </select>
                </label>
                <p>跨接缝事件比较始终先建立基准。选择接受后也不会消除价差或重算成另一来源。</p>
              </fieldset>
            )}
            <fieldset disabled={busy}>
              <legend>条件</legend>
              <label>
                条件对象
                <select
                  value={draft.condition.left.kind}
                  onChange={(e) =>
                    operand(
                      "left",
                      e.target.value === "price"
                        ? { kind: "price" }
                        : { kind: "indicator", indicator: defaultIndicator() },
                    )
                  }
                >
                  <option value="price">价格</option>
                  <option value="indicator" disabled={interval}>
                    指标
                  </option>
                </select>
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
                关系
                <select
                  value={draft.condition.relation}
                  onChange={(e) => {
                    const relation = e.target.value,
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
                  {Object.entries(relations).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
              {interval ? (
                <div className="alert-two-fields">
                  <label>
                    下限
                    <input
                      required
                      inputMode="decimal"
                      value={draft.condition.lower || ""}
                      onChange={(e) =>
                        change({
                          condition: {
                            ...draft.condition,
                            lower: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    上限
                    <input
                      required
                      inputMode="decimal"
                      value={draft.condition.upper || ""}
                      onChange={(e) =>
                        change({
                          condition: {
                            ...draft.condition,
                            upper: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <>
                  <label>
                    比较目标
                    <select
                      value={draft.condition.right?.kind}
                      onChange={(e) =>
                        operand(
                          "right",
                          e.target.value === "indicator"
                            ? {
                                kind: "indicator",
                                indicator: defaultIndicator(),
                              }
                            : e.target.value === "price"
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
                    </select>
                  </label>
                  {draft.condition.right?.kind === "constant" && (
                    <label>
                      比较值
                      <input
                        required
                        inputMode="decimal"
                        value={draft.condition.right.value || ""}
                        onChange={(e) =>
                          operand("right", {
                            kind: "constant",
                            value: e.target.value,
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
                    <p>
                      画线：{draft.condition.right.line.kind} ·{" "}
                      {draft.condition.right.line.scale === "log"
                        ? "对数轴"
                        : "线性轴"}
                      ；拖动结束后另行提交新版本。
                    </p>
                  )}
                </>
              )}
            </fieldset>
            <label>
              判定
              <select
                value={draft.mode}
                onChange={(e) =>
                  change({ mode: e.target.value as AlertConfig["mode"] })
                }
              >
                <option value="close">收盘确认</option>
                <option value="intrabar">盘中观察</option>
              </select>
            </label>
            <p>
              {draft.mode === "close"
                ? `固定周期 ${draft.timeframe}；等待来源确认完整 K 线。`
                : source?.observation_basis ||
                  "按实际观察样本判定，不推测缺失盘中路径。"}
            </p>
            <label>
              触发次数
              <select
                value={draft.max_triggers}
                onChange={(e) =>
                  change({ max_triggers: Number(e.target.value) as 1 | 2 | 3 })
                }
              >
                <option value={1}>仅一次</option>
                <option value={2}>多次 · 2 次（默认）</option>
                <option value={3}>多次 · 3 次</option>
              </select>
            </label>
            <p>条件解除后再次成立才增加次数；达到上限自动停止。</p>
            <label>
              到期（{Intl.DateTimeFormat().resolvedOptions().timeZone}）
              <input
                type="datetime-local"
                value={expires}
                onChange={(e) =>
                  change({
                    expires_at: e.target.value
                      ? new Date(e.target.value).getTime()
                      : null,
                  })
                }
              />
            </label>
            <div className="alert-inline-actions">
              <button
                type="button"
                onClick={() => change({ expires_at: null })}
              >
                不限
              </button>
              {[
                ["1 天", 1],
                ["1 周", 7],
                ["1 月", 30],
              ].map(([label, days]) => (
                <button
                  type="button"
                  key={label}
                  onClick={() =>
                    change({
                      expires_at: Date.now() + Number(days) * 86_400_000,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setMessage(draft.message);
                setWeb(draft.notify_web);
                setPhone(draft.notify_ntfy);
                setLate(draft.late_delivery);
                setPage("message");
              }}
            >
              消息与通知 · {draft.notify_ntfy ? "网页 / ntfy" : "网页"}
              {draft.message ? " · 自定义正文" : " · 自动正文"}
            </button>
            <p>创建时条件已成立不会立即触发；生效后先建立比较基准。</p>
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
            <footer>
              <button type="button" disabled={busy} onClick={onClose}>
                取消（保留草稿）
              </button>
              <button type="submit" disabled={busy || !source?.available}>
                {busy ? "正在提交…" : editing ? "保存新版本" : "创建告警"}
              </button>
            </footer>
          </>
        )}
      </form>
    </dialog>
  );
}
