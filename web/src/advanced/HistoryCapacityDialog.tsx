import { useEffect, useRef, useState } from "react";
import { api as defaultRequest } from "../api";
import type { HistoryCapabilities } from "./nativeHistoryLoads";

type PrefetchValues = Record<string, {initial_bars: number; reserve_bars: number}>;
type PrefetchConfig = {version: number; sources: PrefetchValues; defaults: PrefetchValues; max_bars: number};
const sourceNames: Record<string, string> = {
  oanda: "OANDA", binance: "Binance", dukascopy: "Dukascopy",
  yahoo: "Yahoo", akshare: "AKShare", fxcm: "FXCM",
};

export function HistoryCapacityDialog({
  request: api = defaultRequest,
  capabilities,
  usage,
  theme,
  onSaved,
  onClose,
}: {
  request?: typeof defaultRequest;
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
  const [prefetch, setPrefetch] = useState<PrefetchConfig | null>(null);
  const [sourceValues, setSourceValues] = useState<Record<string, {initial_bars: string; reserve_bars: string}>>({});
  const fillSources = (values: PrefetchValues) => setSourceValues(Object.fromEntries(
    Object.entries(values).map(([source, item]) => [source, {
      initial_bars: String(item.initial_bars), reserve_bars: String(item.reserve_bars),
    }]),
  ));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    const controller = new AbortController();
    abort.current = controller;
    void api<PrefetchConfig>("/charts/provider-prefetch", undefined, controller.signal).then(config => {
      if (controller.signal.aborted) return;
      setPrefetch(config);
      fillSources(config.sources);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
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
    if (!prefetch) return;
    const sources = Object.fromEntries(Object.entries(sourceValues).map(([source, item]) =>
      [source, {initial_bars: Number(item.initial_bars), reserve_bars: Number(item.reserve_bars)}],
    ));
    for (const item of Object.values(sources)) {
      if (Object.values(item).some(n => !Number.isSafeInteger(n) || n < 0 || n > prefetch.max_bars) ||
          (item.reserve_bars !== 0 && item.reserve_bars < item.initial_bars)) {
        setError(`预取须为 0 至 ${prefetch.max_bars.toLocaleString()} 的整数；后台储备须不少于首屏目标，或设为 0 关闭`);
        return;
      }
    }
    let prefetchSaved = false;
    setBusy(true);
    setError("");
    try {
      const controller = new AbortController();
      abort.current = controller;
      await api<PrefetchConfig>("/charts/provider-prefetch", {version: 1, sources}, controller.signal);
      prefetchSaved = true;
      const saved = await api<HistoryCapabilities>(
        "/charts/history-capacity",
        { max_bars: count },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      onSaved(saved);
      onClose();
    } catch (e) {
      if (mounted.current) setError((prefetchSaved ? "预取设置已保存，容量保存失败：" : "预取设置保存失败：") + String(e));
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
        <h2 id="history-capacity-title">历史数据与预取</h2>
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
        <fieldset disabled={busy || !prefetch}>
          <legend>按来源预取</legend>
          <p id="provider-prefetch-help">首屏尽量在一次请求中多取；后台补足储备，不等待全部补齐才出图。两项都是总根数，分别设为 0 可关闭；仅补实际访问的品种和周期。</p>
          {prefetch ? <table className="provider-prefetch-table" aria-describedby="provider-prefetch-help">
            <thead><tr><th scope="col">来源</th><th scope="col">首屏采集（根）</th><th scope="col">后台储备（根）</th></tr></thead>
            <tbody>{Object.entries(sourceNames).map(([source, label]) => <tr key={source}>
              <th scope="row">{label}</th>
              {(["initial_bars", "reserve_bars"] as const).map(key => <td key={key}>
                <input type="number" required min={0} max={prefetch.max_bars} step={1}
                  aria-label={`${label} ${key === "initial_bars" ? "首屏采集" : "后台储备"}`}
                  value={sourceValues[source]?.[key] ?? ""}
                  onChange={e => setSourceValues(previous => ({...previous,
                    [source]: {...previous[source], [key]: e.target.value},
                  }))} />
              </td>)}
            </tr>)}</tbody>
          </table> : <p>正在读取预取设置…</p>}
          <p>AKShare 的新浪与腾讯共用此处设置。保存后用于后续采集，无需重启；降低目标保留已有行情。</p>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setValue(String(capabilities.default_bars));
              if (prefetch) fillSources(prefetch.defaults);
            }}
          >
            恢复默认值
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button type="submit" disabled={busy || !prefetch}>
            {busy ? "正在保存…" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
