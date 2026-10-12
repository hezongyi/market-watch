import { date } from "./api";

export default function ReplayJobs({
  jobs,
  summary,
  retry,
}: {
  jobs: any[];
  summary: any;
  retry: (id: string) => void;
}) {
  const weekly = summary?.weekly_requests || [];
  const active = jobs.filter((job) => job.status !== "complete");
  const activeWeekly = weekly.filter((job: any) => job.status !== "complete");
  const complete = jobs.filter((job) => job.status === "complete");
  const completeWeekly = weekly.filter((job: any) => job.status === "complete");
  function renderJob(job: any) {
    return (
      <div className="watch-row" key={job.id}>
        <strong>{job.instrument_id}</strong>
        <small>
          {job.priority === 0
            ? "断档修复"
            : job.priority === 50
              ? "初始历史"
              : job.priority === 100
                ? "图表历史"
                : job.priority === 200
                  ? "周线后台"
                  : "手动导入"}{" "}
          · {date(job.start)} — {date(job.end)}
        </small>
        <span className="status">
          {(
            {
              pending: "等待获取",
              running: "获取中",
              complete: "已完成",
              failed: "失败",
            } as Record<string, string>
          )[job.status] || job.status}
        </span>
        <span>
          {Math.round(((job.cursor - job.start) / (job.end - job.start)) * 100)}
          %
        </span>
        {job.status === "failed" && (
          <button className="secondary" onClick={() => retry(job.id)}>
            从断点重试
          </button>
        )}
        {job.error && (
          <small className="warning">
            {job.error.includes("429") ? "上游限流，等待重试" : job.error}
          </small>
        )}
      </div>
    );
  }
  function renderWeekly(job: any) {
    return (
      <div className="watch-row" key={job.id}>
        <strong>{job.instrument_id}</strong>
        <small>截止 {date(job.before)}</small>
        <span className="status">
          {(
            {
              pending: "排队或补数中",
              complete: "已完成",
              needs_review: "待核查",
              failed: "未完成",
            } as Record<string, string>
          )[job.status] || job.status}
        </span>
        <span>尚需 {job.remaining} 根周线</span>
        {job.status === "needs_review" && (
          <small className="warning">
            已查询区间没有可用周线，已停止自动向前补数；尚未确认历史起点，请检查品种与日期范围。
          </small>
        )}
      </div>
    );
  }
  return (
    <>
      {!!activeWeekly.length && (
        <section className="panel">
          <div className="panel-heading">
            <h2>周线后台需求</h2>
            <small>优先保障日线及以下周期，最多显示 30 项</small>
          </div>
          {activeWeekly.map(renderWeekly)}
        </section>
      )}
      {!!active.length && (
        <section className="panel">
          <div className="panel-heading">
            <h2>历史数据任务</h2>
            <small>后台分日获取，可在重启后继续</small>
          </div>
          {active.map(renderJob)}
        </section>
      )}
      {(complete.length > 0 || completeWeekly.length > 0) && (
        <details className="panel replay-completed-jobs">
          <summary>
            历史任务记录 · 已完成 {summary?.counts?.complete ?? complete.length}{" "}
            项
          </summary>
          <p>
            历史任务共 {summary?.total ?? jobs.length} 项；最多显示最近 30
            项，失败及运行任务保持可见。已完成记录默认收起，演练版本与后台任务不受影响。
          </p>
          {complete.map(renderJob)}
          {completeWeekly.map(renderWeekly)}
        </details>
      )}
    </>
  );
}
