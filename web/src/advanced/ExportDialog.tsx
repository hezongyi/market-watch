import { useEffect, useRef, useState } from "react";
import { apiResponse } from "../api";

export type ExportSelection = {
  theme?: string;
  instrument: string;
  series_kind?: "provider" | "managed";
  timeframe: string;
  indicators: Record<string, unknown>[];
};
const inputDate = (time: number) => new Date(time).toISOString().slice(0, 16);
export function ExportDialog({
  selection,
  onClose,
}: {
  selection: ExportSelection;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [start, setStart] = useState(inputDate(Date.now() - 86400000));
  const [end, setEnd] = useState(inputDate(Date.now()));
  const [include, setInclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [failedTasks, setFailedTasks] = useState<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
    return () => abort.current?.abort();
  }, []);
  async function download(retryFailed = false) {
    if (busy) return;
    const left = Date.parse(start + "Z"),
      right = Date.parse(end + "Z");
    if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right) {
      setError("结束时间必须晚于开始时间");
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setStatus("正在检查历史行情");
    const body = {
      ...selection,
      published: selection.series_kind !== 'provider',
      start: left,
      end: right,
      indicators: include ? selection.indicators : [],
    };
    try {
      if (retryFailed) {
        for (const id of failedTasks) {
          const response = await apiResponse(
            `/market-data/retry/${encodeURIComponent(id)}`,
            {},
            controller.signal,
          );
          if (!response.ok) throw Error("历史任务重试失败，请稍后重试");
        }
        setFailedTasks([]);
      }
      while (!controller.signal.aborted) {
        const response = await apiResponse(
          "/charts/export",
          body,
          controller.signal,
        );
        if (response.status === 202) {
          setStatus("正在补齐历史行情，完成后自动下载。关闭窗口可停止等待。");
          await new Promise<void>((resolve, reject) => {
            const cancel = () => {
              clearTimeout(timer);
              reject(new DOMException("Cancelled", "AbortError"));
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener("abort", cancel);
              resolve();
            }, 2000);
            controller.signal.addEventListener("abort", cancel, { once: true });
          });
          continue;
        }
        if (!response.ok) {
          const result = await response.json();
          setFailedTasks(
            Array.isArray(result.failed_task_ids)
              ? result.failed_task_ids.filter(
                  (id: unknown): id is string =>
                    typeof id === "string" &&
                    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
                      id,
                    ),
                )
              : [],
          );
          throw Error(
            result.message ||
              (typeof result.detail === "string"
                ? result.detail
                : "导出失败，请检查日期范围"),
          );
        }
        if (!response.headers.get("content-type")?.includes("text/csv"))
          throw Error("服务器未返回 CSV 文件，请稍后重试");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `market-watch-${selection.timeframe}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        setStatus("CSV 已生成并交给浏览器下载");
        break;
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setStatus("");
        setError(String(e));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="chart-export-dialog"
      data-theme={selection.theme || "dark"}
      aria-labelledby="export-title"
      onCancel={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void download();
        }}
      >
        <h2 id="export-title">导出行情 CSV</h2>
        <p>
          {selection.instrument} · {selection.timeframe}
        </p>
        <p>
          按 K 线开始时间选择，以下时间均为 UTC。最多 2000 根，日期跨度不超过
          366 天。
        </p>
        {selection.timeframe === "MN" && (
          <p>月线仅导出本地已有日线生成的数据，不补齐缺失历史。</p>
        )}
        <label>
          开始时间（含）
          <input
            type="datetime-local"
            required
            value={start}
            disabled={busy}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束时间（不含）
          <input
            type="datetime-local"
            required
            value={end}
            disabled={busy}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        {!!selection.indicators.length && (
          <label>
            <input
              type="checkbox"
              checked={include}
              disabled={busy}
              onChange={(e) => setInclude(e.target.checked)}
            />
            附带当前图表的 Python 指标
          </label>
        )}
        <p>
          包含价格口径和 K 线完整性。未收盘数据可能变化；不包含原生内置指标。
        </p>
        <div role="status">{status}</div>
        {error && <p role="alert">{error}</p>}
        <footer>
          {!!failedTasks.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void download(true)}
            >
              重试历史补数
            </button>
          )}
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "正在准备…" : "下载 CSV"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
