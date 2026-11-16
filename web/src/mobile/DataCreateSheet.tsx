import SymbolIdentityRow from "./SymbolIdentityRow";
import { useEffect, useRef, useState } from "react";
import type { CatalogItem } from "../market-data/CreationCatalog";
import {
  frames,
  modeNames,
  type Dataset,
  type FrameRule,
} from "../market-data/types";
import { editableFramePlan } from "../market-data/FrameSchedules";
import { ApiError } from "../api";
import { profileActive, type Profile } from "./cache";
import { Button } from "./components/ui/button";
import { FieldGroup, FieldSet } from "./components/ui/field";
import {
  DataFeedback,
  DataFrames,
  DataInput,
  DataMore,
  DataSelect,
} from "./DataFormParts";
import { FrameSettings } from "./DataMaintenanceSheet";
import {
  dataRequest,
  recentDate,
  useDataCommand,
} from "./dataOperations";

type Check = {
  status: string;
  start: number | null;
  existing: Dataset | null;
  message?: string;
};
type Result = { dataset: Dataset; task: { id: string } };
export default function DataCreateSheet({
  item,
  profile,
  online,
  done,
  state,
}: {
  item: CatalogItem;
  profile: Profile;
  online: boolean;
  done(id: string, isNew?: boolean, archived?: boolean): void;
  state(busy: boolean, dirty: boolean): void;
}) {
  const initialMode = item.default_mode || "base_m1";
  const [mode, setMode] = useState(initialMode),
    [adjustment, setAdjustment] = useState("none");
  const [day, setDay] = useState(
    initialMode === "base_d1" ? item.default_start_date || "" : recentDate(),
  );
  const defaultCalendar: Record<string, string> = {
    forex: "ny17",
    metal: "ny17",
    crypto: "utc0",
  };
  const [calendar, setCalendar] = useState(
    initialMode !== "base_m1"
      ? "source_date"
      : defaultCalendar[item.asset_class] || "",
  );
  const [precision, setPrecision] = useState(
    item.precision == null ? "" : String(item.precision),
  );
  const [verified, setVerified] = useState(item.verified_frames || {});
  const probed = useRef(new Set<string>());
  const initialPeriods =
    initialMode === "base_m1"
      ? frames
      : initialMode === "base_d1"
        ? ["D1", "W1", "MN"]
        : frames.filter((f) =>
            (item.verified_frames?.none || []).includes(f),
          );
  const [periods, setPeriods] = useState(initialPeriods),
    [frequency, setFrequency] = useState("daily");
  const [clock, setClock] = useState(
    initialMode === "base_m1" ? "00:15" : "18:00",
  );
  const [timezone, setTimezone] = useState(
    initialMode === "base_m1" ? "UTC" : item.timezone || "UTC",
  );
  const [framePlan, setFramePlan] = useState<Record<string, FrameRule>>({});
  const [overlap, setOverlap] = useState(2880),
    [dirty, setDirty] = useState(false);
  const [check, setCheck] = useState<{ key: string; value: Check }>(),
    [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState("");
  const [probing, setProbing] = useState(false),
    [probeError, setProbeError] = useState(""),
    [probeEpoch, setProbeEpoch] = useState(0);
  const command = useDataCommand(profile, online),
    pending = useRef<{ body: any; params: string } | undefined>(undefined),
    requestId = useRef(crypto.randomUUID());
  const [uncertain, setUncertain] = useState(false);
  const native = mode !== "base_m1",
    available = verified[adjustment] || [];
  const allowed = !native
    ? frames
    : mode === "base_d1"
      ? available.includes("D1")
        ? ["D1", "W1", "MN"]
        : []
      : frames.filter((f) => available.includes(f));
  const dataset = {
    source: item.source,
    logical_symbol: item.logical_symbol,
    provider_symbol: item.provider_symbol,
    asset_class: item.asset_class,
    catalog_id: item.catalog_id,
    precision: /^(?:[0-9]|10)$/.test(precision) ? Number(precision) : null,
    aggregation_calendar: calendar || null,
    ...(native ? { mode, adjustment, timeframes: periods } : {}),
  };
  const key = JSON.stringify({ ...dataset, start_date: day || null });
  const current = check?.key === key ? check.value : undefined;
  useEffect(() => {
    state(command.busy, dirty || uncertain);
  }, [command.busy, dirty, uncertain, state]);
  useEffect(() => {
    setProbing(false);
    setProbeError("");
    const probeKey = mode + ":" + adjustment;
    const requested =
      mode === "base_d1"
        ? ["D1"]
        : item.supported_frames?.[adjustment] ||
          item.supported_frames?.none ||
          [];
    if (
      !native ||
      probed.current.has(probeKey) ||
      (available.length &&
        requested.every((frame) => available.includes(frame))) ||
      !online ||
      !["yahoo", "akshare"].includes(item.source)
    )
      return;
    const controller = new AbortController();
    setProbing(true);
    setProbeError("");
    const timeframes = requested;
    void dataRequest<{ frames: string[] }>(
      profile,
      "/market-data/history-catalog/probe",
      {
        source: item.source,
        provider_symbol: item.provider_symbol,
        adjustment,
        timeframes,
        start: Date.parse(`${day || "2000-01-01"}T00:00:00Z`),
      },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.frames.length)
          throw Error("没有验证到可用周期，请调整起点或重试");
        probed.current.add(probeKey);
        setVerified((old) => ({ ...old, [adjustment]: result.frames }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProbeError(String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setProbing(false);
      });
    return () => controller.abort();
  }, [mode, adjustment, probeEpoch, online, item.catalog_id]);
  useEffect(() => {
    setPeriods(allowed);
  }, [mode, adjustment, JSON.stringify(allowed)]);
  useEffect(() => {
    setChecking(false);
    setCheckError("");
    if (
      !online ||
      !calendar ||
      !day ||
      !periods.length ||
      dataset.precision == null ||
      probing ||
      !!probeError ||
      uncertain
    )
      return;
    const controller = new AbortController();
    setChecking(true);
    setCheckError("");
    const timer = setTimeout(() => {
      void dataRequest<Check>(
        profile,
        "/market-data/center/datasets/check?mobile_unique=true",
        JSON.parse(key),
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setCheck({ key, value });
        })
        .catch((error) => {
          if (!controller.signal.aborted) setCheckError(String(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, online, probing, probeError, uncertain]);
  async function submit() {
    await command.run(async (request) => {
      if (!pending.current) {
        if (current?.status !== "ready" || current.start == null) return;
        const [hour, minute] = clock.split(":").map(Number);
        pending.current = {
          body: {
            request_id: requestId.current,
            create_only: true,
            mobile_unique: true,
            dataset,
            maintenance: {
              target_start: current.start,
              timeframes: periods,
              frequency,
              timezone,
              daily_minute: hour * 60 + minute,
              overlap_minutes: overlap,
              ...(native
                ? {
                    frame_plan: editableFramePlan(
                      framePlan,
                      mode === "base_d1" ? ["D1"] : periods,
                    ),
                  }
                : {}),
            },
          },
          params: new URLSearchParams({
            source: item.source,
            provider_symbol: item.provider_symbol,
            asset_class: item.asset_class,
            aggregation_calendar: calendar,
            mode,
            adjustment,
          }).toString(),
        };
      }
      const submission = pending.current;
      const lookup = () =>
        request<{ found: boolean; dataset?: Dataset }>(
          profile,
          `/market-data/center/creations/${requestId.current}?${submission.params}`,
        );
      if (uncertain) {
        const known = await lookup();
        if (known.found && known.dataset) {
          done(known.dataset.id);
          return;
        }
      }
      try {
        const result = await request<Result>(
          profile,
          "/market-data/center/datasets",
          submission.body,
        );
        done(result.dataset.id);
      } catch (error) {
        if (!profileActive(profile)) throw error;
        if (error instanceof ApiError && error.status === 409) {
          const actual = await request<Check>(
            profile,
            "/market-data/center/datasets/check",
            JSON.parse(key),
          );
          if (actual.status === "existing" && actual.existing) {
            pending.current = undefined;
            setUncertain(false);
            setCheck({ key, value: actual });
            return;
          }
        }
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          pending.current = undefined;
          setUncertain(false);
          throw error;
        }
        setUncertain(true);
        try {
          const known = await lookup();
          if (known.found && known.dataset) {
            done(known.dataset.id);
            return;
          }
        } catch {
          /* Preserve the exact submission for explicit reconciliation. */
        }
        throw Error("创建结果待核实，输入已保留；请核查创建结果后继续");
      }
    });
  }
  const edit = () => setDirty(true);
  return (
    <div className="data-workflow-form">
      <div className="data-create-symbol">
        <SymbolIdentityRow row={item} code={item.display_symbol || item.provider_symbol} name={item.label} />
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FieldSet disabled={command.busy || uncertain}>
          <FieldGroup>
            <DataInput
              label="历史起点"
              type="date"
              required
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                edit();
              }}
            />
            {item.precision == null && (
              <DataInput
                label="价格精度（小数位）"
                type="number"
                min={0}
                max={10}
                required
                value={precision}
                onChange={(e) => {
                  setPrecision(e.target.value);
                  edit();
                }}
              />
            )}
            {!native && !defaultCalendar[item.asset_class] && (
              <DataSelect
                label="日线划分"
                value={calendar}
                items={[
                  { value: "", label: "请选择" },
                  { value: "ny17", label: "纽约 17:00（NY17）" },
                  { value: "utc0", label: "UTC 00:00" },
                ]}
                onChange={(v) => {
                  setCalendar(v);
                  edit();
                }}
              />
            )}
            <DataFrames
              frames={allowed}
              value={periods}
              change={(v) => {
                setPeriods(v);
                edit();
              }}
              required={!native ? "M1" : undefined}
            />
            <DataSelect
              label="自动更新"
              value={frequency}
              onChange={(v) => {
                setFrequency(v);
                edit();
              }}
              items={[
                { value: "daily", label: "每日更新" },
                { value: "once", label: "仅准备本次历史" },
              ]}
            />
            <p className="data-caption">
              {frequency === "daily"
                ? `每日 ${clock} · ${timezone}`
                : "本次历史准备完成后，不安排定时更新"}
            </p>
            <DataMore>
              <FieldGroup>
                {item.supported_modes && (
                  <DataSelect
                    label="历史模式"
                    value={mode}
                    items={item.supported_modes.map((value) => ({
                      value,
                      label: modeNames[value] || value,
                    }))}
                    onChange={(v) => {
                      setMode(v);
                      setFramePlan({});
                      edit();
                    }}
                  />
                )}
                {native && (
                  <DataSelect
                    label="价格口径"
                    value={adjustment}
                    items={Object.keys(
                      item.supported_frames || { none: [] },
                    ).map((value) => ({
                      value,
                      label:
                        {
                          none: "原始价格",
                          qfq: "前复权",
                          hfq: "后复权",
                          supplier: "来源价格",
                        }[value] || value,
                    }))}
                    onChange={(v) => {
                      setAdjustment(v);
                      edit();
                    }}
                  />
                )}
                {!native && !!defaultCalendar[item.asset_class] && (
                  <DataSelect
                    label="日线划分"
                    value={calendar}
                    items={[
                      { value: "", label: "请选择" },
                      { value: "ny17", label: "纽约 17:00（NY17）" },
                      { value: "utc0", label: "UTC 00:00" },
                    ]}
                    onChange={(v) => {
                      setCalendar(v);
                      edit();
                    }}
                  />
                )}
                {frequency === "daily" && (
                  <>
                    <DataInput
                      label="维护时间"
                      type="time"
                      required
                      value={clock}
                      onChange={(e) => {
                        setClock(e.target.value);
                        edit();
                      }}
                    />
                    <DataInput
                      label="维护时区"
                      required
                      value={timezone}
                      onChange={(e) => {
                        setTimezone(e.target.value);
                        edit();
                      }}
                    />
                  </>
                )}
                {!native && (
                  <DataInput
                    label="重叠复查窗口（分钟）"
                    type="number"
                    min={0}
                    max={44640}
                    value={overlap}
                    onChange={(e) => {
                      setOverlap(Number(e.target.value));
                      edit();
                    }}
                  />
                )}
                {native && (
                  <FrameSettings
                    frames={mode === "base_d1" ? ["D1"] : periods}
                    value={framePlan}
                    change={(v) => {
                      setFramePlan(v);
                      edit();
                    }}
                  />
                )}
              </FieldGroup>
            </DataMore>
          </FieldGroup>
        </FieldSet>
        <DataFeedback
          error={
            command.error ||
            probeError ||
            checkError ||
            current?.message ||
            (current?.status === "connection_required"
              ? "此来源尚未配置连接"
              : "")
          }
          notice={
            probing
              ? "正在验证可用周期…"
              : checking
                ? "正在核对创建配置…"
                : undefined
          }
        />
        {probeError && (
          <Button
            variant="outline"
            disabled={!online || probing}
            onClick={() => setProbeEpoch((n) => n + 1)}
          >
            重试验证
          </Button>
        )}
        {current?.status === "existing" && current.existing ? (
          <Button
            className="data-primary"
            onClick={() =>
              done(
                current.existing!.id,
                false,
                current.existing!.maintenance.archived,
              )
            }
          >
            查看已有自建
          </Button>
        ) : (
          <Button
            className="data-primary"
            type="submit"
            disabled={
              !online ||
              command.busy ||
              probing ||
              !!probeError ||
              (!uncertain &&
                (checking ||
                  current?.status !== "ready" ||
                  current.start == null))
            }
          >
            {command.busy
              ? "正在处理…"
              : uncertain
                ? "核查创建结果并重试"
                : "创建并准备历史"}
          </Button>
        )}
        <p className="data-caption">
          {native
            ? "沿用来源交易日"
            : calendar === "ny17"
              ? "纽约 17:00 日界"
              : "UTC 00:00 日界"}{" "}
          · 历史按来源实际可得范围准备。实时在历史就绪后单独开启。
        </p>
      </form>
    </div>
  );
}
