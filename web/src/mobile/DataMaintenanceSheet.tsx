import { sourceLabel } from "./marketIdentity";
import { useRef, useState } from "react";
import { ApiError } from "../api";
import { editableFramePlan } from "../market-data/FrameSchedules";
import {
  frames,
  type Dataset,
  type FrameRule,
  type Plan,
  type Task,
} from "../market-data/types";
import { tradingDate } from "../market-data/MaintenanceSettings";
import { type Profile } from "./cache";
import MobileSheet from "./MobileSheet";
import { managedCode } from "./dataMarkets";
import { MobileConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { FieldGroup, FieldSet } from "./components/ui/field";
import {
  DataFeedback,
  DataFrames,
  DataInput,
  DataMore,
  DataSelect,
} from "./DataFormParts";
import { DataEmpty, DataLoading } from "./DataStates";
import {
  dataTime,
  taskName,
  useDataCommand,
  useDataRead,
} from "./dataOperations";

export type MaintenanceView = "settings" | "tasks" | "range" | "versions";
export function FrameSettings({
  frames: choices,
  value,
  change,
  disabled,
}: {
  frames: string[];
  value: Record<string, FrameRule>;
  change(value: Record<string, FrameRule>): void;
  disabled?: boolean;
}) {
  return (
    <>
      {choices.map((frame) => {
        const rule = value[frame] || {
          schedule: "daily",
          interval_minutes: 60,
          overlap_bars: 2,
        };
        const update = (patch: Partial<FrameRule>) =>
          change({ ...value, [frame]: { ...rule, ...patch } });
        return (
          <FieldSet
            key={frame}
            disabled={disabled}
            className="data-period-settings"
          >
            <legend>{frame} 维护计划</legend>
            <FieldGroup>
              <DataSelect
                label={`${frame} 更新方式`}
                value={rule.schedule}
                onChange={(schedule) => update({ schedule })}
                items={[
                  { value: "daily", label: "每日" },
                  { value: "interval", label: "按间隔" },
                ]}
              />
              {rule.schedule === "interval" && (
                <DataInput
                  label={`${frame} 间隔分钟`}
                  type="number"
                  min={15}
                  max={10080}
                  value={rule.interval_minutes}
                  onChange={(e) =>
                    update({ interval_minutes: Number(e.target.value) })
                  }
                />
              )}
              <DataInput
                label={`${frame} 重叠复查根数`}
                type="number"
                min={0}
                max={10000}
                value={rule.overlap_bars}
                onChange={(e) =>
                  update({ overlap_bars: Number(e.target.value) })
                }
              />
              <DataInput
                label={`${frame} 独立起点（选填）`}
                type="date"
                value={
                  rule.target_start == null
                    ? ""
                    : new Date(rule.target_start).toISOString().slice(0, 10)
                }
                onChange={(e) =>
                  update({
                    target_start: e.target.value
                      ? Date.parse(`${e.target.value}T00:00:00Z`)
                      : undefined,
                  })
                }
              />
            </FieldGroup>
          </FieldSet>
        );
      })}
    </>
  );
}

export default function DataMaintenanceSheet({
  dataset,
  profile,
  online,
  active,
  open,
  view,
  close,
  changed,
  openChart,
  onClosed,
}: {
  dataset: Dataset;
  profile: Profile;
  online: boolean;
  active: boolean;
  open: boolean;
  view: MaintenanceView;
  close(): void;
  changed(): void;
  openChart(ticker: string): void;
  onClosed(): void;
}) {
  const command = useDataCommand(profile, online);
  const [dirty, setDirty] = useState(false),
    [confirm, setConfirm] = useState<{ title: string; action(): void }>();
  const plan = dataset.maintenance,
    mode = dataset.identity.mode || "base_m1",
    native = mode !== "base_m1";
  const [day, setDay] = useState(
    plan.configured
      ? tradingDate(plan.target_start, dataset.aggregation_calendar)
      : "",
  );
  const [periods, setPeriods] = useState(plan.timeframes || ["M1", "H4", "D1"]),
    [frequency, setFrequency] = useState(plan.frequency || "daily");
  const [timezone, setTimezone] = useState(plan.timezone || "UTC"),
    [clock, setClock] = useState(
      `${String(Math.floor((plan.daily_minute ?? 15) / 60)).padStart(2, "0")}:${String((plan.daily_minute ?? 15) % 60).padStart(2, "0")}`,
    );
  const [overlap, setOverlap] = useState(plan.overlap_minutes ?? 2880),
    [framePlan, setFramePlan] = useState<Record<string, FrameRule>>(
      plan.frame_plan || {},
    );
  const revision = useRef(plan.configuration_revision),
    [conflict, setConflict] = useState<Plan>();
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [kind, setKind] = useState("backfill");
  const submission = useRef<{ key: string; id: string } | undefined>(undefined);
  const [page, setPage] = useState(1);
  const path =
    view === "tasks"
      ? `/market-data/center/tasks?dataset_id=${dataset.id}&page_size=10&page=${page}`
      : view === "versions"
        ? `/market-data/versions?dataset_id=${dataset.id}`
        : "";
  const result = useDataRead<{ items: Task[]; total: number } | any[]>(
    profile,
    path,
    active,
    online,
    view === "tasks" ? 3000 : 0,
  );
  const allowed = !native
    ? frames
    : mode === "base_d1"
      ? ["D1", "W1", "MN"]
      : dataset.selectable_timeframes || dataset.input_timeframes || periods;
  const title = {
    settings: "维护设置",
    tasks: "维护任务",
    range: "区间维护",
    versions: "固定历史版本",
  }[view];
  const edit = () => setDirty(true);
  async function save() {
    await command.run(async (request) => {
      const boundary = await request<{ start: number }>(
        profile,
        `/market-data/date-boundary?${new URLSearchParams({ date: day, calendar: dataset.aggregation_calendar })}`,
      );
      const [hour, minute] = clock.split(":").map(Number);
      const body = {
        expected_configuration_revision: revision.current,
        target_start: boundary.start,
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
      };
      const target = `/market-data/datasets/${dataset.id}/maintenance`;
      try {
        const saved = await request<Plan>(profile, target, body);
        revision.current = saved.configuration_revision;
        setConflict(undefined);
        setDirty(false);
        changed();
        command.setNotice(
          "维护设置已保存，后续任务按新设置执行；当前任务范围保持固定。",
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setConflict(await request<Plan>(profile, target));
          throw error;
        }
        if (!(error instanceof ApiError) || error.status >= 500) {
          const saved = await request<Plan>(profile, target);
          const keys = [
            "target_start",
            "timeframes",
            "frequency",
            "timezone",
            "daily_minute",
            "overlap_minutes",
          ] as const;
          if (
            keys.every(
              (key) => JSON.stringify(saved[key]) === JSON.stringify(body[key]),
            ) &&
            (!native ||
              JSON.stringify(
                editableFramePlan(
                  saved.frame_plan || {},
                  mode === "base_d1" ? ["D1"] : periods,
                ),
              ) === JSON.stringify(body.frame_plan))
          ) {
            revision.current = saved.configuration_revision;
            setDirty(false);
            changed();
            command.setNotice("已核实维护设置保存成功");
            return;
          }
        }
        throw error;
      }
    });
  }
  async function taskControl(task: Task, action: string) {
    await command.run(async (request) => {
      try {
        await request(profile, `/market-data/tasks/${task.id}/control`, {
          action,
        });
      } catch (error) {
        result.refresh();
        throw error;
      }
      changed();
      result.refresh();
      command.setNotice("操作已提交，等待任务状态更新");
    });
  }
  async function range() {
    await command.run(async (request) => {
      const dates = await Promise.all(
        [from, to].map((date) =>
          request<{ start: number }>(
            profile,
            `/market-data/date-boundary?${new URLSearchParams({ date, calendar: dataset.aggregation_calendar })}`,
          ),
        ),
      );
      if (dates[0].start >= dates[1].start) throw Error("结束日必须晚于起始日");
      const key = JSON.stringify([
        dataset.id,
        kind,
        dates[0].start,
        dates[1].start,
      ]);
      if (submission.current?.key !== key)
        submission.current = { key, id: crypto.randomUUID() };
      await request(profile, `/market-data/datasets/${dataset.id}/tasks`, {
        request_id: submission.current.id,
        kind,
        start: dates[0].start,
        end: dates[1].start,
      });
      setDirty(false);
      changed();
      command.setNotice("区间维护已提交，后台继续处理");
    });
  }
  function loadLatest() {
    if (!conflict) return;
    setDay(tradingDate(conflict.target_start, dataset.aggregation_calendar));
    setPeriods(conflict.timeframes);
    setFrequency(conflict.frequency);
    setTimezone(conflict.timezone);
    setClock(
      `${String(Math.floor(conflict.daily_minute / 60)).padStart(2, "0")}:${String(conflict.daily_minute % 60).padStart(2, "0")}`,
    );
    setOverlap(conflict.overlap_minutes);
    setFramePlan(conflict.frame_plan || {});
    revision.current = conflict.configuration_revision;
    setConflict(undefined);
    setDirty(false);
    command.setError("");
  }
  const tasks =
    result.data && !Array.isArray(result.data) ? result.data : undefined;
  const mutationLocked =
    !online ||
    command.busy ||
    (view === "tasks" && (!!result.readAt || !!result.error));
  return (
    <MobileSheet
      title={title}
      open={open}
      onClosed={onClosed}
      fullHeight={view === "settings" || view === "range"}
      dirty={dirty}
      dismissible={!command.busy}
      close={close}
    >
      <div className="data-workflow-form">
        <div className="data-selection">
          <strong>{managedCode(dataset)}</strong>
          <span>{sourceLabel(dataset.source_display) || dataset.identity.source}</span>
        </div>
        {view === "settings" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FieldSet disabled={command.busy || !online}>
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
                    { value: "once", label: "一次性维护" },
                  ]}
                />
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
                <DataMore>
                  <FieldGroup>
                    {native ? (
                      <FrameSettings
                        frames={mode === "base_d1" ? ["D1"] : periods}
                        value={framePlan}
                        change={(v) => {
                          setFramePlan(v);
                          edit();
                        }}
                      />
                    ) : (
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
                  </FieldGroup>
                </DataMore>
              </FieldGroup>
            </FieldSet>
            {conflict && (
              <>
                <DataFeedback
                  error={`其他窗口已修改维护设置：${conflict.timeframes.join(" / ")}，${conflict.frequency === "daily" ? "每日" : "一次性"}，${dataTime(conflict.target_start)} 起。你的输入已保留。`}
                />
                <Button variant="outline" onClick={loadLatest}>
                  载入最新维护设置
                </Button>
              </>
            )}
            <Button
              type="submit"
              className="data-primary"
              disabled={
                !online ||
                command.busy ||
                !dirty ||
                !periods.length ||
                !!conflict
              }
            >
              {command.busy ? "正在保存…" : command.notice ? "已保存" : "保存维护设置"}
            </Button>
            <p className="data-caption">
              保存设置不另行提交更新，当前任务保持原范围。
            </p>
          </form>
        )}
        {view === "range" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void range();
            }}
          >
            <FieldSet disabled={mutationLocked}>
              <FieldGroup>
                <DataSelect
                  label="任务类型"
                  value={kind}
                  onChange={(v) => {
                    setKind(v);
                    edit();
                  }}
                  items={[
                    { value: "backfill", label: "补齐指定区间" },
                    { value: "recheck", label: "复查已有区间" },
                  ]}
                />
                <DataInput
                  label="起始交易日期"
                  type="date"
                  required
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    edit();
                  }}
                />
                <DataInput
                  label="结束交易日期（不包含）"
                  type="date"
                  required
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    edit();
                  }}
                />
              </FieldGroup>
            </FieldSet>
            <Button
              className="data-primary"
              type="submit"
              disabled={mutationLocked}
            >
              {command.busy ? "正在提交…" : command.notice ? "已提交" : `提交${kind === "backfill" ? "补数" : "复查"}`}
            </Button>
          </form>
        )}
        {result.loading && !result.data && <DataLoading label="正在读取…" />}
        {view === "tasks" && tasks && (
          <>
            {!tasks.items.length && (
              <DataEmpty title="暂无维护任务">
                开始准备历史后，进度和记录会显示在这里。
              </DataEmpty>
            )}
            {tasks.items.map((task) => (
              <section className="data-task-card" key={task.id}>
                <div>
                  <strong>{taskName(task.status)}</strong>
                  <Badge variant="secondary">
                    {task.task_kind === "backfill"
                      ? "补数"
                      : task.task_kind === "recheck"
                        ? "复查"
                        : "更新"}
                  </Badge>
                </div>
                <p>
                  {dataTime(task.start)} — {dataTime(task.end)}
                </p>
                <p>已处理至 {dataTime(task.cursor)}</p>
                {task.derivation && (
                  <p>
                    {task.derivation.stage} ·{" "}
                    {task.derivation.published_periods}/
                    {task.derivation.total_periods} 个周期
                  </p>
                )}
                <DataFeedback error={task.error} />
                {task.controllable && (
                  <div className="data-action-row">
                    {["pending", "running", "retrying", "deriving"].includes(
                      task.status,
                    ) && (
                      <Button
                        variant="outline"
                        disabled={mutationLocked}
                        onClick={() => void taskControl(task, "pause")}
                      >
                        暂停任务
                      </Button>
                    )}
                    {task.status === "paused" && (
                      <Button
                        variant="outline"
                        disabled={mutationLocked}
                        onClick={() => void taskControl(task, "resume")}
                      >
                        继续任务
                      </Button>
                    )}
                    {[
                      "failed",
                      "partial",
                      "configuration_error",
                      "retrying",
                    ].includes(task.status) && (
                      <Button
                        variant="outline"
                        disabled={mutationLocked}
                        onClick={() => void taskControl(task, "retry")}
                      >
                        重试任务
                      </Button>
                    )}
                    {!["published", "cancelled"].includes(task.status) && (
                      <Button
                        variant="ghost"
                        disabled={mutationLocked}
                        onClick={() =>
                          setConfirm({
                            title: "取消当前任务？",
                            action: () => void taskControl(task, "cancel"),
                          })
                        }
                      >
                        取消任务
                      </Button>
                    )}
                  </div>
                )}
              </section>
            ))}
            <div className="data-pager">
              <Button
                variant="ghost"
                disabled={page === 1}
                onClick={() => setPage((n) => n - 1)}
              >
                上一页
              </Button>
              <span>第 {page} 页</span>
              <Button
                variant="ghost"
                disabled={page * 10 >= tasks.total}
                onClick={() => setPage((n) => n + 1)}
              >
                下一页
              </Button>
            </div>
          </>
        )}
        {view === "versions" && Array.isArray(result.data) && (
          <>
            {!result.data.length && (
              <DataEmpty title="暂无历史版本">
                历史发布后可查看固定版本。
              </DataEmpty>
            )}
            {result.data.map((version: any) => (
              <div className="data-task-card" key={version.id}>
                <strong>
                  {dataTime(version.published_at || version.created_at)}
                </strong>
                <p>
                  {dataTime(version.start)} — {dataTime(version.end)}
                </p>
                <Button
                  variant="outline"
                  disabled={
                    !online ||
                    version.status !== "published" ||
                    version.payload_available === false
                  }
                  onClick={() => openChart(`MWH:${version.id}`)}
                >
                  打开固定历史
                </Button>
              </div>
            ))}
          </>
        )}
        <DataFeedback
          error={command.error || result.error}
          notice={
            (!online ? "当前为离线快照，联网后可操作" : undefined)
          }
        />
        {result.error && (
          <Button variant="outline" onClick={result.refresh}>
            重新读取
          </Button>
        )}
      </div>
      {confirm && (
        <MobileConfirm
          title={confirm.title}
          description="已发布历史会保留；当前任务在安全停止后结束。"
          actionLabel="取消任务"
          destructive
          onAccept={() => {
            confirm.action();
            setConfirm(undefined);
          }}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </MobileSheet>
  );
}
