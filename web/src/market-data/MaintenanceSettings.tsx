import { NativeInput, NativeSelect } from "./NativeControls";
import { useRef, useState } from "react";
import { useDirtyForm, useActionLock } from "./router";
import { api, ApiError } from "./api";
import { frames, time, type Dataset, type Plan } from "./types";

function tradingDate(start: number, calendar: string) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar === "ny17" ? "America/New_York" : "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(start));
  const values = Object.fromEntries(date.map(part => [part.type, part.value]));
  const day = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  if (calendar === "ny17") day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

export function MaintenanceSettings({
  dataset,
  onSaved,
}: {
  dataset: Dataset;
  onSaved: () => void;
}) {
  const plan = dataset.maintenance;
  const [day, setDay] = useState(
    plan.configured
      ? tradingDate(plan.target_start, dataset.aggregation_calendar)
      : "",
  );
  const [periods, setPeriods] = useState(plan.timeframes || ["M1", "H4", "D1"]);
  const [frequency, setFrequency] = useState(plan.frequency || "daily");
  const [timezone, setTimezone] = useState(plan.timezone || "UTC");
  const [clock, setClock] = useState(
    `${String(Math.floor((plan.daily_minute ?? 15) / 60)).padStart(2, "0")}:${String((plan.daily_minute ?? 15) % 60).padStart(2, "0")}`,
  );
  const [overlap, setOverlap] = useState(plan.overlap_minutes ?? 2880);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(0);
  useDirtyForm("maintenance-settings", [day, periods, frequency, timezone, clock, overlap], saved);
  const revision = useRef(plan.configuration_revision);
  const actionLock = useActionLock();
  const [conflict, setConflict] = useState<Plan | null>(null);
  function loadLatest() {
    if (!conflict) return;
    setDay(conflict.configured ? tradingDate(conflict.target_start, dataset.aggregation_calendar) : "");
    setPeriods(conflict.timeframes || ["M1", "H4", "D1"]);
    setFrequency(conflict.frequency || "daily");
    setTimezone(conflict.timezone || "UTC");
    setClock(`${String(Math.floor((conflict.daily_minute ?? 15) / 60)).padStart(2, "0")}:${String((conflict.daily_minute ?? 15) % 60).padStart(2, "0")}`);
    setOverlap(conflict.overlap_minutes ?? 2880);
    revision.current = conflict.configuration_revision;
    setConflict(null); setError("");
    setNotice("已载入最新维护设置，请核对后保存。");
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!actionLock.acquire()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const boundary = await api<{ start: number }>(
        `/market-data/date-boundary?date=${day}&calendar=${dataset.aggregation_calendar}`,
      );
      const [hour, minute] = clock.split(":").map(Number);
      const saved = await api<Plan>(`/market-data/datasets/${dataset.id}/maintenance`, {
        expected_configuration_revision: revision.current,
        target_start: boundary.start,
        timeframes: periods,
        frequency,
        timezone,
        daily_minute: hour * 60 + minute,
        overlap_minutes: overlap,
      });
      revision.current = saved.configuration_revision;
      setConflict(null);
      setNotice(
        "维护配置已保存；新增周期将在后台派生。已有运行任务保留原固定范围。",
      );
      setSaved(value => value + 1);
      onSaved();
    } catch (e) {
      setError(String(e));
      if (e instanceof ApiError && e.code === "MAINTENANCE_CHANGED") {
        try {
          setConflict(await api<Plan>(`/market-data/datasets/${dataset.id}/maintenance`));
        } catch {
          setError("维护配置已改变，暂时无法读取最新设置。你的输入已保留；请稍后再次保存以核对。");
        }
      }
    } finally {
      actionLock.release();
      setBusy(false);
    }
  }
  return (
    <form className="dc-fields" onSubmit={save} inert={busy}>
      <label>
        目标起始交易日期
        <NativeInput
          type="date"
          required
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>维护周期</legend>
        <div className="dc-checks">
          {frames.map((frame) => (
            <label key={frame}>
              <NativeInput
                type="checkbox"
                disabled={frame === "M1"}
                checked={periods.includes(frame)}
                onChange={(e) =>
                  setPeriods(
                    e.target.checked
                      ? [...periods, frame]
                      : periods.filter((f) => f !== frame),
                  )
                }
              />
              {frame}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        更新频率
        <NativeSelect aria-label="更新频率"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
        >
          <option value="daily">每日</option>
          <option value="once">一次性</option>
        </NativeSelect>
      </label>
      {frequency === "daily" && (
        <div className="dc-filters">
          <label>
            维护时间
            <NativeInput
              type="time"
              required
              value={clock}
              onChange={(e) => setClock(e.target.value)}
            />
          </label>
          <label>
            维护时区
            <NativeInput
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="例如 UTC"
            />
          </label>
        </div>
      )}
      <section className="dc-advanced-fields"><h3>高级维护设置</h3>
        <label>
          重叠复查窗口（分钟）
          <NativeInput
            type="number"
            min={0}
            max={44640}
            value={overlap}
            onChange={(e) => setOverlap(Number(e.target.value))}
          />
        </label>
        <p>有限窗口用于检查近期修订；更早区间可单独提交补数或复查。</p>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {conflict && <section className="dc-review" aria-label="维护配置冲突">
        <h2>其他窗口已修改维护设置</h2>
        <p>当前输入保留；载入最新设置会替换表单内容，请先核对差异。</p>
        <dl className="dc-facts">
          <div><dt>最新目标起点</dt><dd>{time(conflict.target_start)}</dd></div>
          <div><dt>最新周期</dt><dd>{conflict.timeframes?.join(" · ")}</dd></div>
          <div><dt>最新维护频率</dt><dd>{conflict.frequency === "daily" ? "每日" : "一次性"}</dd></div>
          <div><dt>最新维护时间</dt><dd>{`${String(Math.floor(conflict.daily_minute / 60)).padStart(2, "0")}:${String(conflict.daily_minute % 60).padStart(2, "0")}`} {conflict.timezone}</dd></div>
          <div><dt>最新复查窗口</dt><dd>{conflict.overlap_minutes} 分钟</dd></div>
          <div><dt>最新维护状态</dt><dd>{conflict.archived ? "已归档" : conflict.paused ? "已暂停" : "未暂停"}</dd></div>
        </dl>
        <button type="button" onClick={loadLatest}>载入最新维护设置</button>
      </section>}
      <button disabled={busy} type="submit">
        {busy ? "正在保存…" : "保存维护设置"}
      </button>
    </form>
  );
}
