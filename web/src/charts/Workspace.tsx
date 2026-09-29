import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Plus,
  Copy,
  Trash2,
  Save,
  Undo2,
  Redo2,
  MousePointer2,
  Minus,
  TrendingUp,
  ArrowUpRight,
  Square,
  Type,
  GitBranch,
  SlidersHorizontal,
  Maximize2,
  Minimize2,
  Link2,
  Unlink,
  Lock,
  Eye,
  Settings2,
  Layers,
  Check,
  ChevronDown,
  Grid2X2,
  X,
} from "lucide-react";
import { api } from "../api";
import ChartPane, { type Handle } from "./ChartPane";
import {
  clone,
  frames,
  layouts,
  drawingTools,
  type Catalog,
  type Document,
  type Drawing,
  type IndicatorSpec,
  type Layout,
  type Panel,
  type Workspace,
} from "./types";
import "./workspace.css";
const uid = () => crypto.randomUUID();
const icons = [
  Minus,
  TrendingUp,
  ArrowUpRight,
  Square,
  GitBranch,
  Type,
  Layers,
  TrendingUp,
];
const symbols = {
  EURUSD: "欧元 / 美元",
  XAUUSD: "黄金 / 美元",
  BTCUSDT: "比特币 / USDT",
};
const templateKey = (id: string) => `market-watch-chart-draft:${id}`;
const inputTarget = (e: KeyboardEvent) =>
  e.target instanceof HTMLElement &&
  !!e.target.closest("input,textarea,select,[contenteditable]");
function ParameterInput({
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const n = Number(text);
        if (text && e.currentTarget.validity.valid && Number.isFinite(n))
          onCommit(n);
        else setText(String(value));
      }}
    />
  );
}
export default function WorkspacePage() {
  const nav = useNavigate(),
    params = useParams();
  const [list, setList] = useState<Workspace[]>([]),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null);
  const [active, setActive] = useState(0),
    [max, setMax] = useState<number | null>(null),
    [mobile, setMobile] = useState(matchMedia("(max-width:760px)").matches),
    [dirty, setDirty] = useState(false),
    [saveState, setSaveState] = useState("已保存"),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [selected, setSelected] = useState<Drawing | null>(null),
    [panelDialog, setPanelDialog] = useState(false),
    [objectsOpen, setObjectsOpen] = useState(false),
    [tool, setTool] = useState(""),
    [templates, setTemplates] = useState<any[]>([]),
    [draft, setDraft] = useState<Workspace | null>(null);
  const [historyTick, setHistoryTick] = useState(0),
    [indicatorName, setIndicatorName] = useState("SMA");
  const now = useRef<Workspace | null>(null);
  now.current = workspace;
  const handles = useRef(new Map<string, Handle>()),
    saving = useRef(false),
    generation = useRef(0),
    savedGeneration = useRef(0),
    syncing = useRef(false),
    history = useRef<Document[]>([]),
    future = useRef<Document[]>([]),
    dirtyRef = useRef(false),
    blocked = useRef(false);
  dirtyRef.current = dirty;
  blocked.current = conflict;
  const setCurrent = (w: Workspace) => {
    now.current = w;
    setWorkspace(w);
  };
  useEffect(() => {
    const m = matchMedia("(max-width:760px)");
    const change = () => setMobile(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  const loadList = useCallback(async () => {
    const [rows, c, t] = await Promise.all([
      api<Workspace[]>("/charts/workspaces"),
      api<Catalog>("/charts/catalog"),
      api<any[]>("/charts/templates"),
    ]);
    setList(rows);
    setCatalog(c);
    setTemplates(t);
    return rows;
  }, []);
  const open = useCallback((w: Workspace) => {
    handles.current.forEach((h) => h.cancel());
    setCurrent(clone(w));
    setActive(0);
    setMax(null);
    setSelected(null);
    setDirty(false);
    setConflict(false);
    setSaveState("已保存");
    history.current = [];
    future.current = [];
    generation.current = 0;
    savedGeneration.current = 0;
    setHistoryTick((n) => n + 1);
    try {
      const raw = localStorage.getItem(templateKey(w.id));
      setDraft(raw ? JSON.parse(raw) : null);
    } catch {
      setDraft(null);
    }
  }, []);
  useEffect(() => {
    let alive = true;
    now.current = null;
    setWorkspace(null);
    setDirty(false);
    loadList()
      .then((rows) => {
        if (!alive) return;
        const chosen = rows.find((w) => w.id === params.id) || rows[0];
        if (chosen) open(chosen);
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive = false;
    };
  }, [params.id, loadList, open]);
  const change = useCallback(
    (update: (d: Document) => void, checkpoint = true) => {
      if (mobile || !now.current) return;
      const old = now.current;
      const d = clone(old.document);
      update(d);
      if (JSON.stringify(d) === JSON.stringify(old.document)) return;
      if (checkpoint) {
        history.current.push(clone(old.document));
        if (history.current.length > 60) history.current.shift();
        future.current = [];
        setHistoryTick((n) => n + 1);
      }
      const next = { ...old, document: d };
      setCurrent(next);
      generation.current++;
      setDirty(true);
      setSaveState("待保存");
      try {
        localStorage.setItem(templateKey(next.id), JSON.stringify(next));
      } catch {
        setError("浏览器草稿空间不足，请立即保存到服务器");
      }
    },
    [mobile],
  );
  async function save() {
    const w = now.current;
    if (!w || saving.current || blocked.current || mobile) return;
    const at = generation.current;
    const id = w.id;
    saving.current = true;
    setSaveState("保存中…");
    try {
      const result = await api<Workspace>(`/charts/workspaces/${id}/save`, {
        name: w.name,
        document: w.document,
        revision: w.revision,
      });
      if (now.current?.id === id) {
        setCurrent({
          ...now.current,
          revision: result.revision,
          updated_at: result.updated_at,
        });
        savedGeneration.current = at;
        const clean = generation.current === at;
        setDirty(!clean);
        setSaveState(clean ? "已保存" : "待保存");
        if (clean) localStorage.removeItem(templateKey(id));
        else localStorage.setItem(templateKey(id), JSON.stringify(now.current));
        setList((v) => v.map((x) => (x.id === id ? result : x)));
        setError("");
      }
    } catch (e) {
      if (now.current?.id !== id) return;
      const message = String(e);
      setError(message);
      setSaveState("保存失败");
      if (message.includes("其他窗口")) setConflict(true);
    } finally {
      saving.current = false;
      if (now.current?.id !== id && dirtyRef.current)
        setWorkspace((w) => (w ? { ...w } : w));
    }
  }
  useEffect(() => {
    if (!dirty || mobile || conflict) return;
    const t = setTimeout(() => void save(), 900);
    return () => clearTimeout(t);
  }, [workspace, dirty, mobile, conflict]);
  useEffect(() => {
    const online = () => {
      if (dirtyRef.current) void save();
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", unload);
    };
  }, [mobile]);
  const undo = useCallback(
    (redo = false) => {
      if (mobile || !now.current) return;
      const from = redo ? future.current : history.current,
        to = redo ? history.current : future.current;
      const d = from.pop();
      if (!d) return;
      handles.current.forEach((h) => h.cancel());
      to.push(clone(now.current.document));
      setCurrent({ ...now.current, document: d });
      generation.current++;
      setDirty(true);
      setSaveState("待保存");
      setSelected(null);
      setTool("");
      setHistoryTick((n) => n + 1);
      localStorage.setItem(
        templateKey(now.current.id),
        JSON.stringify(now.current),
      );
    },
    [mobile],
  );
  function cancel() {
    handles.current.forEach((h) => h.cancel());
    setTool("");
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancel();
        setPanelDialog(false);
        setObjectsOpen(false);
        setSelected(null);
        return;
      }
      if (inputTarget(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo(e.shiftKey);
      }
      if (e.key === "Delete" && selected && !mobile) {
        e.preventDefault();
        removeDrawing(selected.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undo, selected, mobile]);
  useEffect(() => {
    if (!panelDialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".cw-modal");
    const focusable = () => [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ) || []),
    ];
    focusable()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", trap);
    return () => {
      dialog?.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [panelDialog]);
  const doc = workspace?.document,
    panel = doc?.panels[active] || doc?.panels[0];
  function editPanel(values: Partial<Panel>) {
    cancel();
    change((d) => Object.assign(d.panels[active], values));
    setSelected(null);
  }
  async function create() {
    const name = prompt("工作区名称", "我的分析");
    if (!name?.trim()) return;
    try {
      const w = await api<Workspace>("/charts/workspaces", {
        name: name.trim(),
      });
      setList((x) => [w, ...x]);
      nav(`/chart-workspaces/${w.id}`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function copyWorkspace() {
    if (!now.current) return;
    const name = prompt("副本名称", `${now.current.name} 副本`);
    if (!name?.trim()) return;
    try {
      const w = await api<Workspace>(
        `/charts/workspaces/${now.current.id}/copy`,
        { ...now.current, name: name.trim() },
      );
      setList((x) => [w, ...x]);
      nav(`/chart-workspaces/${w.id}`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function switchWorkspace(id: string) {
    if (dirtyRef.current) {
      await save();
      if (
        dirtyRef.current &&
        !confirm("当前更改尚未保存，草稿已保留。仍然切换？")
      )
        return;
    }
    cancel();
    nav(`/chart-workspaces/${id}`);
  }
  function rename() {
    if (!workspace) return;
    const name = prompt("重命名工作区", workspace.name);
    if (name?.trim()) {
      setCurrent({ ...workspace, name: name.trim() });
      generation.current++;
      setDirty(true);
      setSaveState("待保存");
      localStorage.setItem(
        templateKey(workspace.id),
        JSON.stringify(now.current),
      );
    }
  }
  async function removeWorkspace() {
    if (!workspace || !confirm(`删除工作区“${workspace.name}”及其画线？`))
      return;
    try {
      await api(`/charts/workspaces/${workspace.id}/delete`, {
        revision: workspace.revision,
      });
      localStorage.removeItem(templateKey(workspace.id));
      const rows = list.filter((x) => x.id !== workspace.id);
      setList(rows);
      setWorkspace(null);
      now.current = null;
      setDirty(false);
      nav(
        rows.length ? `/chart-workspaces/${rows[0].id}` : "/chart-workspaces",
      );
    } catch (e) {
      setError(String(e));
    }
  }
  function layout(value: Layout) {
    cancel();
    change((d) => {
      const n = layouts[value].count;
      while (d.panels.length < n)
        d.panels.push({
          ...clone(d.panels[0]),
          id: uid(),
          timeframe: ["H4", "H1", "M15", "M5"][d.panels.length],
        });
      d.layout = value;
    });
    setActive(0);
    setMax(null);
  }
  function begin(type: string) {
    if (!panel) return;
    cancel();
    setSelected(null);
    setTool(type);
    handles.current
      .get(panel.id)
      ?.draw(type, type === "Text" ? { text: { value: "文字标注" } } : {});
  }
  function drawingsChanged(symbol: string, objects: Drawing[]) {
    change((d) => {
      d.drawings[symbol] = objects;
    });
    setTool("");
  }
  function replaceDrawing(drawing: Drawing) {
    if (!panel) return;
    change((d) => {
      d.drawings[panel.instrument] = (d.drawings[panel.instrument] || []).map(
        (x) => (x.id === drawing.id ? drawing : x),
      );
    });
    setSelected(drawing);
  }
  function removeDrawing(id: string) {
    if (!panel || !confirm("删除选中的画线？可使用撤销恢复。")) return;
    change((d) => {
      d.drawings[panel.instrument] = (
        d.drawings[panel.instrument] || []
      ).filter((x) => x.id !== id);
    });
    setSelected(null);
  }
  function onRange(index: number, r: { from: number; to: number }) {
    if (syncing.current || mobile) return;
    const w = now.current;
    if (!w) return;
    syncing.current = true;
    try {
      if (w.document.sync) {
        w.document.panels
          .slice(0, layouts[w.document.layout].count)
          .forEach((p, i) => {
            if (i !== index) handles.current.get(p.id)?.range(r);
          });
      }
      change((d) => {
        d.panels[index].range = r;
        d.panels[index].follow = false;
        if (d.sync)
          d.panels.slice(0, layouts[d.layout].count).forEach((p) => {
            p.range = r;
            p.follow = false;
          });
      }, false);
    } finally {
      syncing.current = false;
    }
  }
  function cross(index: number, time: number | null, price?: number) {
    if (syncing.current || !now.current?.document.sync) return;
    syncing.current = true;
    try {
      const panels = now.current.document.panels;
      panels.forEach((p, i) => {
        if (i !== index)
          handles.current
            .get(p.id)
            ?.cross(
              time,
              p.instrument === panels[index].instrument ? price : undefined,
            );
      });
    } finally {
      syncing.current = false;
    }
  }
  function split(axis: "X" | "Y", e: React.PointerEvent<HTMLDivElement>) {
    if (mobile) return;
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = e.currentTarget;
    const move = (event: PointerEvent) => {
      const value =
        axis === "X"
          ? (event.clientX - box.left) / box.width
          : (event.clientY - box.top) / box.height;
      change((d) => {
        d[axis === "X" ? "splitX" : "splitY"] = Math.max(
          0.2,
          Math.min(0.8, value),
        );
      }, false);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  }
  function addIndicator() {
    if (!panel || !catalog) return;
    const meta = catalog.indicators[indicatorName];
    editPanel({
      indicators: [
        ...panel.indicators,
        {
          id: uid(),
          name: indicatorName,
          version: "1",
          params: clone(meta.params),
          color: "#2962ff",
        },
      ],
    });
  }
  function setIndicator(id: string, values: Partial<IndicatorSpec>) {
    if (values.params) {
      const p = values.params;
      if (
        Object.entries(p).some(([k, v]) =>
          k === "deviation"
            ? !Number.isFinite(v) || v < 0.1 || v > 10
            : !Number.isInteger(v) || v < 2 || v > 500,
        )
      )
        return;
      if (p.fast !== undefined && p.fast >= p.slow) {
        setError("MACD快线周期必须小于慢线");
        return;
      }
    }
    if (panel)
      editPanel({
        indicators: panel.indicators.map((i) =>
          i.id === id ? { ...i, ...values } : i,
        ),
      });
  }
  async function saveTemplate() {
    if (!panel) return;
    const name = prompt("指标模板名称");
    if (name?.trim())
      try {
        await api("/charts/templates", {
          name: name.trim(),
          indicators: panel.indicators,
        });
        setTemplates(await api("/charts/templates"));
      } catch (e) {
        setError(String(e));
      }
  }
  const count = doc ? layouts[doc.layout].count : 1;
  return (
    <div className="cw-app">
      <header className="cw-header">
        <a href="/" className="cw-back" title="返回工作台">
          <ArrowLeft size={17} />
          <span>工作台</span>
        </a>
        <span className="cw-brand">
          Market Watch <small>CHARTS</small>
        </span>
        <div className="cw-workspace-select">
          <select
            aria-label="工作区"
            value={workspace?.id || ""}
            onChange={(e) => void switchWorkspace(e.target.value)}
          >
            <option value="" disabled>
              选择工作区
            </option>
            {list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id === workspace?.id ? workspace.name : w.name}
              </option>
            ))}
          </select>
        </div>
        {!mobile && (
          <>
            <button
              title="新建工作区"
              aria-label="新建工作区"
              onClick={() => void create()}
            >
              <Plus size={17} />
            </button>
            <button
              title="复制工作区"
              aria-label="复制工作区"
              onClick={() => void copyWorkspace()}
              disabled={!workspace}
            >
              <Copy size={16} />
            </button>
            <button title="重命名工作区" onClick={rename} disabled={!workspace}>
              重命名
            </button>
            <button
              title="删除工作区"
              aria-label="删除工作区"
              onClick={() => void removeWorkspace()}
              disabled={!workspace}
            >
              <Trash2 size={16} />
            </button>
          </>
        )}
        <div className="cw-header-spacer" />
        <span className={`cw-save-state ${dirty ? "pending" : ""}`}>
          {mobile ? (
            "只读查看"
          ) : saveState === "已保存" ? (
            <>
              <Check size={13} /> 已保存
            </>
          ) : (
            saveState
          )}
        </span>
        {!mobile && (
          <button
            className="cw-save"
            onClick={() => void save()}
            disabled={!workspace || conflict}
          >
            <Save size={15} />
            保存
          </button>
        )}
      </header>
      {error && (
        <div className="cw-banner" role="alert">
          {error}
          {conflict && (
            <>
              <button
                onClick={() =>
                  loadList().then((rows) => {
                    const w = rows.find((x) => x.id === workspace?.id);
                    if (w) open(w);
                  })
                }
              >
                加载服务器版本
              </button>
              <button onClick={() => void copyWorkspace()}>
                将草稿另存副本
              </button>
            </>
          )}
          <button aria-label="关闭提示" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {draft && !mobile && (
        <div className="cw-banner">
          发现此工作区未保存的本地草稿。
          <button
            onClick={() => {
              setCurrent({ ...draft, revision: workspace!.revision });
              generation.current++;
              setDirty(true);
              setDraft(null);
              if (draft.revision !== workspace?.revision) {
                setConflict(true);
                setError("草稿与服务器版本不同，请另存副本或加载服务器版本");
              }
            }}
          >
            恢复草稿
          </button>
          <button
            onClick={() => {
              localStorage.removeItem(templateKey(draft.id));
              setDraft(null);
            }}
          >
            丢弃草稿
          </button>
        </div>
      )}
      {!workspace ? (
        <div className="cw-welcome">
          <Grid2X2 size={40} />
          <h1>你的图表工作区</h1>
          <p>保存布局、指标与画线，在多个周期之间保持思路。</p>
          {!mobile && (
            <button className="cw-primary" onClick={() => void create()}>
              创建第一个工作区
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="cw-commandbar">
            <select
              aria-label="当前图表品种"
              value={panel!.instrument}
              disabled={mobile}
              onChange={(e) =>
                editPanel({
                  instrument: e.target.value,
                  range: undefined,
                  follow: true,
                })
              }
            >
              {Object.entries(symbols).map(([id, label]) => (
                <option key={id} value={id}>
                  {id} · {label}
                </option>
              ))}
            </select>
            <div className="cw-periods">
              {frames.map((f) => (
                <button
                  key={f}
                  aria-pressed={panel!.timeframe === f}
                  className={panel!.timeframe === f ? "selected" : ""}
                  disabled={mobile}
                  onClick={() =>
                    editPanel({ timeframe: f, range: undefined, follow: true })
                  }
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="cw-divider" />
            <button onClick={() => setPanelDialog(true)}>
              <SlidersHorizontal size={16} />
              指标
            </button>
            {!mobile && (
              <>
                <select
                  aria-label="图表布局"
                  value={doc!.layout}
                  onChange={(e) => layout(e.target.value as Layout)}
                >
                  {Object.entries(layouts).map(([id, l]) => (
                    <option key={id} value={id}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <button
                  className={doc!.sync ? "selected" : ""}
                  title="同步十字线时间与视区"
                  onClick={() =>
                    change((d) => {
                      d.sync = !d.sync;
                    })
                  }
                >
                  {doc!.sync ? <Link2 size={16} /> : <Unlink size={16} />}同步
                </button>
                <button
                  aria-label="撤销"
                  disabled={!history.current.length}
                  onClick={() => undo()}
                >
                  <Undo2 size={17} />
                </button>
                <button
                  aria-label="重做"
                  disabled={!future.current.length}
                  onClick={() => undo(true)}
                >
                  <Redo2 size={17} />
                </button>
              </>
            )}
            <button
              title="显示设置"
              aria-label="显示设置"
              onClick={() => setPanelDialog(true)}
            >
              <Settings2 size={17} />
            </button>
          </div>
          <div className="cw-body">
            {!mobile && (
              <aside className="cw-tools" aria-label="绘图工具栏">
                <button
                  title="选择 / Esc取消"
                  aria-label="选择工具"
                  className={!tool ? "selected" : ""}
                  onClick={cancel}
                >
                  <MousePointer2 size={20} />
                </button>
                {drawingTools.map(([id, label], i) => {
                  const Icon = icons[i];
                  return (
                    <button
                      key={id}
                      title={label}
                      aria-label={label}
                      className={tool === id ? "selected" : ""}
                      onClick={() => begin(id)}
                    >
                      <Icon size={20} />
                    </button>
                  );
                })}
                <span className="cw-tool-separator" />
                <button
                  title="画线对象列表"
                  aria-label="画线对象列表"
                  className={objectsOpen ? "selected" : ""}
                  onClick={() => setObjectsOpen((x) => !x)}
                >
                  <Layers size={20} />
                </button>
              </aside>
            )}
            <div
              className="cw-grid"
              data-layout={mobile || max !== null ? "1" : doc!.layout}
              style={
                {
                  "--split-x": `${(doc!.splitX || 0.5) * 100}%`,
                  "--split-y": `${(doc!.splitY || 0.5) * 100}%`,
                } as React.CSSProperties
              }
            >
              {doc!.panels.slice(0, count).map((p, i) => {
                const hidden = mobile
                  ? i !== active
                  : max !== null && i !== max;
                return (
                  <section
                    key={`${workspace!.id}:${p.id}`}
                    className={`cw-pane ${i === active ? "active" : ""} ${hidden ? "cw-hidden" : ""}`}
                    onPointerDown={() => {
                      if (i !== active) {
                        cancel();
                        setActive(i);
                        setSelected(null);
                      }
                    }}
                  >
                    <div className="cw-pane-title">
                      <button onClick={() => setActive(i)}>
                        <strong>{p.instrument}</strong>
                        <span>{p.timeframe}</span>
                        <small>
                          {symbols[p.instrument as keyof typeof symbols]}
                        </small>
                      </button>
                      <div className="cw-pane-actions">
                        {!mobile && (
                          <button
                            title="跟随最新行情"
                            className={p.follow ? "selected" : ""}
                            onClick={() => {
                              change((d) => {
                                d.panels[i].follow = true;
                                d.panels[i].range = undefined;
                              }, false);
                              handles.current.get(p.id)?.refresh();
                            }}
                          >
                            最新
                          </button>
                        )}
                        <button
                          aria-label={`图表${i + 1}最大化`}
                          onClick={() => setMax(max === i ? null : i)}
                        >
                          {max === i ? (
                            <Minimize2 size={14} />
                          ) : (
                            <Maximize2 size={14} />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="cw-indicator-legend">
                      {p.indicators.map((ind) => (
                        <button
                          key={ind.id}
                          style={{ color: ind.color }}
                          onClick={() => {
                            setActive(i);
                            setPanelDialog(true);
                          }}
                        >
                          {ind.name} ({Object.values(ind.params).join(", ")})
                        </button>
                      ))}
                    </div>
                    <ChartPane
                      panel={p}
                      drawings={doc!.drawings[p.instrument] || []}
                      readonly={mobile}
                      active={active === i}
                      onActivate={() => {
                        setActive(i);
                      }}
                      onReady={(h) => {
                        if (h) handles.current.set(p.id, h);
                        else handles.current.delete(p.id);
                      }}
                      onLoaded={() => {
                        const current = now.current?.document;
                        if (!current?.sync || mobile || syncing.current) return;
                        const source = handles.current
                          .get(current.panels[0].id)
                          ?.viewRange();
                        if (!source) return;
                        syncing.current = true;
                        try {
                          current.panels
                            .slice(1, layouts[current.layout].count)
                            .forEach((target) =>
                              handles.current.get(target.id)?.range(source),
                            );
                        } finally {
                          syncing.current = false;
                        }
                      }}
                      onDrawings={(d) => drawingsChanged(p.instrument, d)}
                      onSelect={(d) => {
                        setActive(i);
                        setSelected(d);
                      }}
                      onRange={(r) => onRange(i, r)}
                      onCross={(t, price) => cross(i, t, price)}
                    />
                  </section>
                );
              })}
              {!mobile &&
                max === null &&
                ["2h", "3top", "3bottom", "4"].includes(doc!.layout) && (
                  <div
                    className="cw-split cw-split-x"
                    role="separator"
                    aria-label="左右分隔线"
                    aria-orientation="vertical"
                    tabIndex={0}
                    onPointerDown={(e) => split("X", e)}
                    onKeyDown={(e) => {
                      if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                        e.preventDefault();
                        change((d) => {
                          d.splitX = Math.max(
                            0.2,
                            Math.min(
                              0.8,
                              (d.splitX || 0.5) +
                                (e.key === "ArrowLeft" ? -0.03 : 0.03),
                            ),
                          );
                        });
                      }
                    }}
                  />
                )}
              {!mobile &&
                max === null &&
                ["2v", "3top", "3bottom", "4"].includes(doc!.layout) && (
                  <div
                    className="cw-split cw-split-y"
                    role="separator"
                    aria-label="上下分隔线"
                    aria-orientation="horizontal"
                    tabIndex={0}
                    onPointerDown={(e) => split("Y", e)}
                    onKeyDown={(e) => {
                      if (["ArrowUp", "ArrowDown"].includes(e.key)) {
                        e.preventDefault();
                        change((d) => {
                          d.splitY = Math.max(
                            0.2,
                            Math.min(
                              0.8,
                              (d.splitY || 0.5) +
                                (e.key === "ArrowUp" ? -0.03 : 0.03),
                            ),
                          );
                        });
                      }
                    }}
                  />
                )}
            </div>
            {objectsOpen && !mobile && (
              <aside className="cw-object-list">
                <header>
                  <strong>画线对象 · {panel!.instrument}</strong>
                  <button
                    aria-label="关闭对象列表"
                    onClick={() => setObjectsOpen(false)}
                  >
                    <X size={15} />
                  </button>
                </header>
                {(doc!.drawings[panel!.instrument] || []).map((d) => (
                  <div key={d.id}>
                    <button onClick={() => setSelected(d)}>
                      {drawingTools.find((t) => t[0] === d.toolType)?.[1] ||
                        d.toolType}
                    </button>
                    <button
                      aria-label="切换画线可见性"
                      onClick={() =>
                        replaceDrawing({
                          ...d,
                          options: {
                            ...d.options,
                            visible: d.options.visible === false,
                          },
                        })
                      }
                    >
                      <Eye size={14} />
                    </button>
                    <button
                      aria-label="切换画线锁定"
                      onClick={() =>
                        replaceDrawing({
                          ...d,
                          options: {
                            ...d.options,
                            editable: d.options.editable === false,
                          },
                        })
                      }
                    >
                      <Lock size={14} />
                    </button>
                    <button
                      aria-label="删除画线"
                      onClick={() => removeDrawing(d.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {!(doc!.drawings[panel!.instrument] || []).length && (
                  <p>此品种尚无画线</p>
                )}
              </aside>
            )}
          </div>
          {mobile && (
            <div className="cw-mobile-tabs">
              {doc!.panels.slice(0, count).map((p, i) => (
                <button
                  key={p.id}
                  className={i === active ? "selected" : ""}
                  onClick={() => setActive(i)}
                >
                  {i + 1} · {p.instrument} {p.timeframe}
                </button>
              ))}
            </div>
          )}
          <footer className="cw-footer">
            <span>
              {tool
                ? `正在绘制 ${drawingTools.find((t) => t[0] === tool)?.[1]} · Esc取消`
                : "时间与价格锚点自动保存"}
            </span>
            <span>行情按 M1 更新 · 不提供逐笔报价</span>
            <a
              href="https://www.tradingview.com/lightweight-charts/"
              target="_blank"
              rel="noreferrer"
            >
              Charts by TradingView
            </a>
            <a href="/README.md" target="_blank" rel="noreferrer">
              开源许可与源码
            </a>
          </footer>
        </>
      )}
      {panelDialog && panel && catalog && (
        <div
          className="cw-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPanelDialog(false);
          }}
        >
          <section
            className="cw-modal"
            role="dialog"
            aria-modal="true"
            aria-label="指标与显示设置"
          >
            <header>
              <h2>指标与显示</h2>
              <button
                aria-label="关闭设置"
                onClick={() => setPanelDialog(false)}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              {panel.instrument} · {panel.timeframe} · Python 计算，已完成K线
            </p>
            <label>
              显示时区
              <select
                value={panel.timezone}
                disabled={mobile}
                onChange={(e) => editPanel({ timezone: e.target.value })}
              >
                <option value="native">按品种分桶时区</option>
                <option value="America/New_York">纽约（自动夏令时）</option>
                <option value="UTC">UTC</option>
                <option value="Asia/Shanghai">北京时间</option>
              </select>
            </label>
            <div className="cw-indicator-add">
              <select
                aria-label="新增指标类型"
                value={indicatorName}
                onChange={(e) => setIndicatorName(e.target.value)}
              >
                {Object.entries(catalog.indicators).map(([id, c]) => (
                  <option key={id} value={id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                className="cw-primary"
                disabled={mobile || panel.indicators.length >= 12}
                onClick={addIndicator}
              >
                添加指标
              </button>
            </div>
            {panel.indicators.map((ind) => (
              <fieldset key={ind.id}>
                <legend>
                  {catalog.indicators[ind.name]?.label || ind.name} · v
                  {ind.version}
                </legend>
                <div className="cw-params">
                  {Object.entries(ind.params).map(([key, value]) => (
                    <label key={key}>
                      {(
                        {
                          period: "周期",
                          deviation: "标准差",
                          fast: "快线",
                          slow: "慢线",
                          signal: "信号",
                          k: "K周期",
                          smooth: "K平滑",
                          d: "D平滑",
                        } as Record<string, string>
                      )[key] || key}
                      <ParameterInput
                        min={key === "deviation" ? 0.1 : 2}
                        max={key === "deviation" ? 10 : 500}
                        step={key === "deviation" ? 0.1 : 1}
                        value={value}
                        disabled={mobile}
                        onCommit={(value) =>
                          setIndicator(ind.id, {
                            params: {
                              ...ind.params,
                              [key]: value,
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    颜色
                    <input
                      type="color"
                      value={ind.color || "#2962ff"}
                      disabled={mobile}
                      onChange={(e) =>
                        setIndicator(ind.id, { color: e.target.value })
                      }
                    />
                  </label>
                  <button
                    aria-label={`移除${ind.name}`}
                    disabled={mobile}
                    onClick={() =>
                      editPanel({
                        indicators: panel.indicators.filter(
                          (x) => x.id !== ind.id,
                        ),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </fieldset>
            ))}
            {!panel.indicators.length && (
              <p className="cw-muted">
                添加均线到主图，或 RSI / MACD 等到副图。
              </p>
            )}
            <h3>指标模板</h3>
            <div className="cw-template-row">
              <select
                aria-label="应用指标模板"
                defaultValue=""
                disabled={mobile}
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t)
                    editPanel({
                      indicators: t.indicators.map((i: IndicatorSpec) => ({
                        ...i,
                        id: uid(),
                      })),
                    });
                  e.target.value = "";
                }}
              >
                <option value="">选择模板…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button disabled={mobile} onClick={() => void saveTemplate()}>
                保存当前组合
              </button>
            </div>
            {!mobile &&
              templates.map((t) => (
                <button
                  key={t.id}
                  aria-label={`删除模板${t.name}`}
                  onClick={async () => {
                    if (!confirm(`删除指标模板“${t.name}”？已有图表不会改变。`))
                      return;
                    try {
                      await api(`/charts/templates/${t.id}/delete`, {});
                      setTemplates((v) => v.filter((x) => x.id !== t.id));
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  删除模板：{t.name}
                </button>
              ))}
            <small>不足预热周期的指标留空；显示指标不会自动创建预警。</small>
          </section>
        </div>
      )}
      {selected && !mobile && (
        <DrawingEditor
          key={selected.id}
          drawing={selected}
          onChange={replaceDrawing}
          onClose={() => setSelected(null)}
          onDelete={() => removeDrawing(selected.id)}
        />
      )}
    </div>
  );
}
function DrawingEditor({
  drawing,
  onChange,
  onClose,
  onDelete,
}: {
  drawing: Drawing;
  onChange: (d: Drawing) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(clone(drawing)),
    [err, setErr] = useState("");
  useEffect(() => setValue(clone(drawing)), [drawing]);
  const options = value.options,
    points = value.points;
  const color =
    options.line?.color ||
    options.rectangle?.border?.color ||
    options.channelLine?.color ||
    options.entryPtRectangle?.border?.color ||
    options.border?.color ||
    options.text?.font?.color ||
    "#2962ff";
  function style(c: string) {
    const opts = clone(options);
    opts.line = { ...opts.line, color: c };
    opts.border = { ...opts.border, color: c };
    opts.text = { ...opts.text, font: { ...opts.text?.font, color: c } };
    if (opts.background) opts.background.color = c + "22";
    if (opts.rectangle) {
      opts.rectangle.border.color = c;
      opts.rectangle.background.color = c + "22";
    }
    if (opts.channelLine) {
      opts.channelLine.color = c;
      opts.middleLine.color = c;
    }
    if (opts.entryPtRectangle) {
      opts.entryPtRectangle.border.color = c;
      opts.entryPtRectangle.background.color = c + "22";
    }
    if (opts.levels)
      opts.levels = opts.levels.map((level: any) => ({ ...level, color: c }));
    setValue({ ...value, options: opts });
  }
  function apply() {
    if (points.some((p) => !Number.isFinite(p.price) || p.price <= 0)) {
      setErr("价格必须大于0");
      return;
    }
    if (value.toolType === "LongShortPosition" && points.length === 3) {
      const [a, s, t] = points.map((p) => p.price);
      if (a === s || (t - a) * (s - a) >= 0) {
        setErr("止损与止盈必须分居入场价两侧");
        return;
      }
    }
    const updated = clone(value);
    const line = updated.options.line;
    if (line) {
      const applyLine = (target: any) => {
        if (target) {
          if (line.width !== undefined) target.width = line.width;
          if (line.style !== undefined) target.style = line.style;
        }
      };
      applyLine(updated.options.rectangle?.border);
      applyLine(updated.options.channelLine);
      applyLine(updated.options.middleLine);
      applyLine(updated.options.entryStopLossRectangle?.border);
      applyLine(updated.options.entryPtRectangle?.border);
    }
    onChange(updated);
    setErr("");
  }
  const rr =
    value.toolType === "LongShortPosition" && points.length === 3
      ? {
          entry: points[0].price,
          stop: points[1].price,
          target: points[2].price,
        }
      : null;
  return (
    <section className="cw-drawing-editor" role="dialog" aria-label="画线属性">
      <header>
        <strong>
          {drawingTools.find((t) => t[0] === value.toolType)?.[1]}设置
        </strong>
        <button aria-label="关闭画线属性" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="cw-params">
        <label>
          颜色
          <input
            type="color"
            value={color.slice(0, 7)}
            onChange={(e) => style(e.target.value)}
          />
        </label>
        <label>
          线宽
          <select
            aria-label="线宽"
            value={
              options.line?.width ||
              options.rectangle?.border?.width ||
              options.channelLine?.width ||
              options.entryPtRectangle?.border?.width ||
              options.border?.width ||
              1
            }
            onChange={(e) =>
              setValue({
                ...value,
                options: {
                  ...options,
                  line: { ...options.line, width: +e.target.value },
                  border: { ...options.border, width: +e.target.value },
                },
              })
            }
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          线型
          <select
            aria-label="线型"
            value={options.line?.style || 0}
            onChange={(e) =>
              setValue({
                ...value,
                options: {
                  ...options,
                  line: { ...options.line, style: +e.target.value },
                  border: { ...options.border, style: +e.target.value },
                },
              })
            }
          >
            <option value="0">实线</option>
            <option value="1">点线</option>
            <option value="2">虚线</option>
          </select>
        </label>
      </div>
      {value.toolType === "Text" && (
        <label>
          文字
          <input
            aria-label="标注文字"
            value={options.text?.value || ""}
            maxLength={200}
            onChange={(e) =>
              setValue({
                ...value,
                options: {
                  ...options,
                  text: { ...options.text, value: e.target.value },
                },
              })
            }
          />
        </label>
      )}
      {points.map((p, i) => (
        <label key={i}>
          {rr ? ["入场价格", "止损价格", "止盈价格"][i] : `锚点${i + 1}价格`}
          <input
            type="number"
            step="any"
            value={p.price}
            onChange={(e) =>
              setValue({
                ...value,
                points: points.map((x, j) =>
                  i === j ? { ...x, price: +e.target.value } : x,
                ),
              })
            }
          />
        </label>
      ))}
      {value.toolType === "FibRetracement" && (
        <label>
          回撤级别（逗号分隔）
          <input
            defaultValue={(options.levels || [])
              .map((l: any) => l.coeff)
              .join(",")}
            onBlur={(e) => {
              const levels = e.target.value.split(",").map(Number);
              if (
                levels.length > 20 ||
                levels.some((n) => !Number.isFinite(n) || Math.abs(n) > 100)
              ) {
                setErr("级别需为有效数字，最多20项");
                return;
              }
              setValue({
                ...value,
                options: {
                  ...options,
                  levels: levels.map((coeff) => ({
                    coeff,
                    color,
                    opacity: 0,
                    distanceFromCoeffEnabled: false,
                    distanceFromCoeff: 0,
                  })),
                },
              });
            }}
          />
        </label>
      )}
      {rr && (
        <div className="cw-rr">
          <strong>
            {rr.target > rr.entry ? "做多" : "做空"} · R/R{" "}
            {Math.abs(rr.entry - rr.stop)
              ? (
                  Math.abs(rr.target - rr.entry) / Math.abs(rr.entry - rr.stop)
                ).toFixed(2)
              : "—"}
          </strong>
          <span>
            止损距离 {Math.abs(rr.entry - rr.stop).toFixed(5)} /{" "}
            {((Math.abs(rr.entry - rr.stop) / rr.entry) * 100).toFixed(2)}%
          </span>
          <span>
            止盈距离 {Math.abs(rr.target - rr.entry).toFixed(5)} /{" "}
            {((Math.abs(rr.target - rr.entry) / rr.entry) * 100).toFixed(2)}%
          </span>
        </div>
      )}
      <div className="cw-checks">
        <label>
          <input
            type="checkbox"
            checked={options.editable === false}
            onChange={(e) =>
              setValue({
                ...value,
                options: { ...options, editable: !e.target.checked },
              })
            }
          />
          锁定
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.visible !== false}
            onChange={(e) =>
              setValue({
                ...value,
                options: { ...options, visible: e.target.checked },
              })
            }
          />
          显示
        </label>
      </div>
      {err && <p role="alert">{err}</p>}
      <footer>
        <button className="cw-danger" onClick={onDelete}>
          删除
        </button>
        <button className="cw-primary" onClick={apply}>
          应用
        </button>
      </footer>
    </section>
  );
}
