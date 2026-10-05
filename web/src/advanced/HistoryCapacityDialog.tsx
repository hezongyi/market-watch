import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { HistoryCapabilities } from "./nativeHistoryLoads";

export function HistoryCapacityDialog({
  capabilities,
  usage,
  theme,
  onSaved,
  onClose,
}: {
  capabilities: HistoryCapabilities;
  usage: number;
  theme: string;
  onSaved: (value: HistoryCapabilities) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [value, setValue] = useState(String(capabilities.max_bars));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  async function save() {
    const count = Number(value);
    if (
      !Number.isSafeInteger(count) ||
      count < capabilities.min_bars ||
      count > capabilities.hard_max_bars
    ) {
      setError(
        `请输入 ${capabilities.min_bars.toLocaleString()} 至 ${capabilities.hard_max_bars.toLocaleString()} 之间的整数`,
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const controller = new AbortController();
      abort.current = controller;
      const saved = await api<HistoryCapabilities>(
        "/charts/history-capacity",
        { max_bars: count },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      onSaved(saved);
      onClose();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="chart-export-dialog history-capacity-dialog"
      data-theme={theme}
      aria-labelledby="history-capacity-title"
      onCancel={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 id="history-capacity-title">历史数据容量</h2>
        <p>
          每个品种、周期累计加载的 K 线上限。默认{" "}
          {capabilities.default_bars.toLocaleString()} 根，同源图表共享数据。
        </p>
        <label htmlFor="history-capacity-value">单源容量（根）</label>
        <input
          id="history-capacity-value"
          type="number"
          required
          step="1"
          min={capabilities.min_bars}
          max={capabilities.hard_max_bars}
          value={value}
          disabled={busy}
          aria-describedby="history-capacity-help"
          onChange={(e) => setValue(e.target.value)}
        />
        <p id="history-capacity-help">
          容量越大，内存和指标计算开销越高，首次加载及拖动可能变慢。工作区另有总容量保护，图表数量与指标都会计入。
        </p>
        <p>
          当前工作区已加载约 {usage.toLocaleString()} 根；当前工作区加权上限为{" "}
          {capabilities.workspace_bars.toLocaleString()}
          。调整单源容量时，总容量同步调整，最高受服务端保护上限约束。
        </p>
        <p>
          保存后当前图表立即生效，并用于以后打开的工作区。其他已打开页面请刷新。降低容量保留已有数据，已加载范围仍可查看；释放数据需要重新打开工作区。
        </p>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            type="button"
            disabled={busy}
            onClick={() => setValue(String(capabilities.default_bars))}
          >
            恢复默认值
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "正在保存…" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
