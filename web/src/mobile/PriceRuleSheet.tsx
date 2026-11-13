import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import {
  normalizeCondition,
  relations,
  type AlertConfig,
  type AlertRow,
  type Capabilities,
} from "../advanced/chartAlerts";
import { ZonedDateTimeInput } from "../time/ZonedDateTimeInput";
import { admission, savePriceRule, uncertainError } from "./alerts";
import MobileSheet from "./MobileSheet";

export default function PriceRuleSheet({
  initial,
  editing,
  label,
  frames,
  online,
  ntfy,
  saved,
  close,
  report,
}: {
  initial: AlertConfig;
  editing?: AlertRow;
  label: string;
  frames: string[];
  online: boolean;
  ntfy: boolean;
  saved(row: AlertRow): void;
  close(): void;
  report(message: string): void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial)),
    [caps, setCaps] = useState<Capabilities>();
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const [fields, setFields] = useState<{ field: string; message: string }[]>(
      [],
    ),
    [conflict, setConflict] = useState(false);
  const [unknown, setUnknown] = useState(false),
    [expiryValid, setExpiryValid] = useState(true);
  const requestId = useRef(crypto.randomUUID()),
    flight = useRef(false),
    mounted = useRef(true);
  const pending = useRef<AlertConfig | undefined>(undefined),
    form = useRef<HTMLFormElement>(null);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    setCaps(undefined);
    if (online)
      void api<Capabilities>(
        "/chart-alerts/capabilities",
        {
          instrument: draft.instrument,
          series_kind: draft.series_kind,
          timeframe: draft.timeframe,
        },
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setCaps(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        });
    return () => controller.abort();
  }, [draft.instrument, draft.timeframe, online]);
  const available = admission(caps, draft),
    interval = ["enter", "exit", "break_upper", "break_lower"].includes(
      draft.condition.relation,
    );
  const change = (values: Partial<AlertConfig>) => {
    if (unknown || busy) return;
    setDirty(true);
    setError("");
    setFields([]);
    setDraft((old) => ({ ...old, ...values }));
  };
  const field = (name: string) =>
    fields.find((item) => item.field === name)?.message;
  async function submit() {
    if (
      flight.current ||
      !online ||
      conflict ||
      !expiryValid ||
      !available?.available ||
      (draft.notify_ntfy && !ntfy)
    )
      return;
    const config = pending.current || {
      ...draft,
      condition: normalizeCondition(draft.condition),
    };
    flight.current = true;
    setBusy(true);
    setError("");
    setFields([]);
    try {
      pending.current = config;
      const row = await savePriceRule(config, requestId.current, editing);
      if (mounted.current) {
        setDirty(false);
        saved(row);
        report("规则已保存；接管与执行以服务器状态为准");
      }
    } catch (error) {
      if (mounted.current) {
        setError(errorMessage(error));
        setFields(error instanceof ApiError ? error.fieldErrors : []);
        const unknown = uncertainError(error);
        setUnknown(unknown);
        setConflict(error instanceof ApiError && error.status === 409);
        if (!unknown) pending.current = undefined;
        requestAnimationFrame(() => {
          const key =
            error instanceof ApiError ? error.fieldErrors[0]?.field : undefined;
          const target =
            key &&
            [
              ...(form.current?.querySelectorAll<HTMLElement>("[data-field]") ||
                []),
            ].find((el) => el.dataset.field === key);
          (
            target || form.current?.querySelector<HTMLElement>('[role="alert"]')
          )?.focus();
        });
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <MobileSheet
      title={editing ? "编辑价格告警" : "创建价格告警"}
      dirty={dirty || unknown}
      close={close}
    >
      <p>{label}</p>
      <p className="mobile-identity">
        MWC:{draft.instrument} · 修订{" "}
        {draft.composite_revision_id || "由服务器核验"}
      </p>
      <form
        ref={form}
        className="mobile-rule-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {dirty && <p role="status">尚未保存</p>}
        {error && (
          <p role="alert" tabIndex={-1}>
            {error}
          </p>
        )}
        {conflict && (
          <>
            <p>版本已改变。当前输入保留；查看最新前请明确放弃输入。</p>
            <button
              type="button"
              onClick={async () => {
                if (!editing || !confirm("放弃当前输入并读取最新规则？"))
                  return;
                try {
                  const row = await api<AlertRow>(
                    `/chart-alerts/${editing.id}`,
                  );
                  saved(row);
                } catch (error) {
                  report(errorMessage(error));
                }
              }}
            >
              放弃输入并查看最新
            </button>
          </>
        )}
        {unknown && (
          <p>
            提交结果未知。输入已锁定；再次核查使用同一次请求，不会创建第二条规则。
          </p>
        )}
        <fieldset disabled={busy || unknown || conflict || !online}>
          <label>
            方向
            <select
              aria-label="方向"
              data-field="condition.relation"
              value={draft.condition.relation}
              onChange={(event) =>
                change({
                  condition: normalizeCondition(
                    draft.condition,
                    event.target.value,
                  ),
                })
              }
            >
              {Object.entries(relations).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {interval ? (
            <>
              {["lower", "upper"].map((side) => (
                <label key={side}>
                  {side === "lower" ? "下沿价格" : "上沿价格"}
                  <input
                    required
                    inputMode="decimal"
                    data-field={`condition.${side}`}
                    value={draft.condition[side as "lower" | "upper"] || ""}
                    onChange={(event) =>
                      change({
                        condition: {
                          ...draft.condition,
                          [side]: event.target.value,
                        },
                      })
                    }
                  />
                  {field(`condition.${side}`) && (
                    <small role="alert">{field(`condition.${side}`)}</small>
                  )}
                </label>
              ))}
            </>
          ) : (
            <label>
              目标价格
              <input
                required
                inputMode="decimal"
                data-field="condition.right.value"
                value={
                  draft.condition.right?.value ??
                  draft.condition.right?.line?.points[0]?.price ??
                  ""
                }
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
              {field("condition.right.value") && (
                <small role="alert">{field("condition.right.value")}</small>
              )}
            </label>
          )}
          <label>
            判定方式
            <select
              aria-label="判定方式"
              value={draft.mode}
              onChange={(event) =>
                change({ mode: event.target.value as AlertConfig["mode"] })
              }
            >
              <option value="intrabar">触价 · 当前抽样观察</option>
              <option value="close">收盘 · 完成柱判定</option>
            </select>
          </label>
          <label>
            周期
            <select
              aria-label="周期"
              data-field="timeframe"
              value={draft.timeframe}
              onChange={(event) => change({ timeframe: event.target.value })}
            >
              {frames.map((frame) => (
                <option key={frame}>{frame}</option>
              ))}
            </select>
          </label>
          <label>
            最多触发
            <select
              aria-label="最多触发"
              value={draft.max_triggers}
              onChange={(event) =>
                change({
                  max_triggers: Number(event.target.value) as 1 | 2 | 3,
                })
              }
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} 次
                </option>
              ))}
            </select>
          </label>
          <label>
            到期时间（UTC）
            <ZonedDateTimeInput
              value={draft.expires_at}
              zone="UTC"
              label="到期时间（UTC）"
              onChange={(expires_at) => change({ expires_at })}
              onValidityChange={setExpiryValid}
            />
          </label>
          <button type="button" onClick={() => change({ expires_at: null })}>
            不限到期
          </button>
          <label>
            名称
            <input
              required
              maxLength={200}
              data-field="name"
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          </label>
          {field("name") && <small role="alert">{field("name")}</small>}
          <label>
            备注
            <input
              maxLength={2000}
              value={draft.message}
              onChange={(event) => change({ message: event.target.value })}
            />
          </label>
          <label className="mobile-check">
            <input
              type="checkbox"
              checked={draft.notify_web}
              onChange={(event) => change({ notify_web: event.target.checked })}
            />
            应用内提醒
          </label>
          <label className="mobile-check">
            <input
              type="checkbox"
              data-field="notify_ntfy"
              checked={draft.notify_ntfy}
              disabled={!ntfy}
              onChange={(event) =>
                change({ notify_ntfy: event.target.checked })
              }
            />
            ntfy 手机通知
          </label>
          {!ntfy && (
            <p>服务器尚未配置 ntfy 或投递未启用。请在桌面配置后重试。</p>
          )}
          <label>
            迟到触发
            <select
              aria-label="迟到触发"
              value={draft.late_delivery}
              onChange={(event) =>
                change({
                  late_delivery: event.target
                    .value as AlertConfig["late_delivery"],
                })
              }
            >
              <option value="log_only">仅记录</option>
              <option value="notify">仍然通知</option>
            </select>
          </label>
        </fieldset>
        <p>
          {!online
            ? "连接核验后才能提交"
            : !caps
              ? "正在核验实时接续能力…"
              : !available?.available
                ? available?.reason || "此判定方式暂不可用"
                : "创建时已在目标一侧，不视为已经发生穿越。断线未观测路径不保证能够补判。"}
        </p>
        <button
          className="primary"
          disabled={
            !online ||
            busy ||
            conflict ||
            !available?.available ||
            !expiryValid ||
            (draft.notify_ntfy && !ntfy)
          }
        >
          {busy ? "正在核查…" : unknown ? "核查同一次提交" : "保存告警"}
        </button>
      </form>
    </MobileSheet>
  );
}
