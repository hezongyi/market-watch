import { useState } from "react";
import { api } from "../api";
import { frames, type Dataset } from "./types";

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
      ? new Date(
          plan.target_start +
            (dataset.aggregation_calendar === "ny17" ? 7 * 3600000 : 0),
        )
          .toISOString()
          .slice(0, 10)
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
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const boundary = await api<{ start: number }>(
        `/market-data/date-boundary?date=${day}&calendar=${dataset.aggregation_calendar}`,
      );
      const [hour, minute] = clock.split(":").map(Number);
      await api(`/market-data/datasets/${dataset.id}/maintenance`, {
        target_start: boundary.start,
        timeframes: periods,
        frequency,
        timezone,
        daily_minute: hour * 60 + minute,
        overlap_minutes: overlap,
      });
      setNotice(
        "维护配置已保存；新增周期将在后台派生。已有运行任务保留原固定范围。",
      );
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="dc-fields" onSubmit={save}>
      <label>
        目标起始交易日期
        <input
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
              <input
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
        <select
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
        >
          <option value="daily">每日</option>
          <option value="once">一次性</option>
        </select>
      </label>
      {frequency === "daily" && (
        <div className="dc-filters">
          <label>
            维护时间
            <input
              type="time"
              required
              value={clock}
              onChange={(e) => setClock(e.target.value)}
            />
          </label>
          <label>
            维护时区
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="例如 UTC"
            />
          </label>
        </div>
      )}
      <details>
        <summary>高级维护设置</summary>
        <label>
          重叠复查窗口（分钟）
          <input
            type="number"
            min={0}
            max={44640}
            value={overlap}
            onChange={(e) => setOverlap(Number(e.target.value))}
          />
        </label>
        <p>有限窗口用于检查近期修订；更早区间可单独提交补数或复查。</p>
      </details>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button disabled={busy} type="submit">
        {busy ? "正在保存…" : "保存维护设置"}
      </button>
    </form>
  );
}
