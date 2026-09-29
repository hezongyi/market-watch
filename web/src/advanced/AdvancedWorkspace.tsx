import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import "./advanced.css";

type Workspace = {
  id: string;
  name: string;
  revision: number;
  document: Record<string, unknown>;
};
const channel = "mw-chart-v1";
const frames = new Set([
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  "W1",
  "MN",
]);
const symbols = new Set(["EURUSD", "XAUUSD", "BTCUSDT"]);
export default function AdvancedWorkspace() {
  const [rows, setRows] = useState<Workspace[]>([]),
    [active, setActive] = useState<Workspace | null>(null);
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef<Workspace | null>(null);
  const flushWaiters = useRef<
    { resolve: () => void; reject: (e: Error) => void }[]
  >([]);
  const mobile = matchMedia("(max-width:700px)").matches;
  const queue = useRef<Promise<void>>(Promise.resolve()),
    blocked = useRef(false),
    inflight = useRef(0);
  const host =
    (import.meta as any).env.VITE_ADVANCED_CHART_ORIGIN ||
    `${location.protocol}//${location.hostname}:5187`;
  const origin = new URL(host).origin;
  if (origin === location.origin) throw new Error("图表库必须使用独立来源");
  const post = (value: object) =>
    frame.current?.contentWindow?.postMessage({ channel, ...value }, origin);
  const flush = () =>
    new Promise<void>((resolve, reject) => {
      if (!current.current || mobile) {
        resolve();
        return;
      }
      const waiter = { resolve, reject };
      flushWaiters.current.push(waiter);
      post({ type: "save" });
      setTimeout(() => {
        if (flushWaiters.current.includes(waiter)) {
          flushWaiters.current = flushWaiters.current.filter(
            (w) => w !== waiter,
          );
          reject(Error("保存未完成，请等待图表加载后再试"));
        }
      }, 15000);
    });
  const select = (row: Workspace) => {
    current.current = row;
    blocked.current = !!localStorage.getItem("mw-tv-draft:" + row.id);
    setActive(row);
    setError(
      blocked.current
        ? "存在未保存草稿，请点击复制恢复为独立工作区；原工作区自动保存已暂停"
        : "",
    );
    setStatus("正在加载图表");
  };
  async function refresh() {
    const list = await api<Workspace[]>("/advanced-charts/workspaces");
    setRows(list);
    return list;
  }
  useEffect(() => {
    let cancelled = false;
    refresh()
      .then((list) => {
        if (!cancelled) {
          if (list[0]) select(list[0]);
          else setStatus("新建工作区开始使用");
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const listener = async (e: MessageEvent) => {
      if (
        e.source !== frame.current?.contentWindow ||
        e.origin !== origin ||
        e.data?.channel !== channel
      )
        return;
      const m = e.data,
        source = e.source as Window;
      const reply = (value: object) =>
        source.postMessage({ channel, ...value }, origin);
      if (m.type === "loaded") {
        try {
          reply({
            type: "init",
            document: current.current?.document || {},
            readonly: mobile,
            catalog: await api("/advanced-charts/catalog"),
          });
        } catch (e) {
          setError(String(e));
        }
      } else if (m.type === "ready") setStatus("已加载 · 行情每15秒检查");
      else if (m.type === "error") setError(String(m.error).slice(0, 500));
      else if (m.type === "data") {
        const q = m.query;
        if (
          !q ||
          (q.indicators !== undefined &&
            (!Array.isArray(q.indicators) ||
              q.indicators.length > 1 ||
              JSON.stringify(q.indicators).length > 2000)) ||
          !symbols.has(q.instrument) ||
          !frames.has(q.timeframe) ||
          !Number.isInteger(q.limit) ||
          q.limit < 1 ||
          q.limit > 2000 ||
          (q.before !== undefined &&
            (!Number.isSafeInteger(q.before) || q.before <= 0)) ||
          inflight.current >= 8
        ) {
          reply({ type: "result", id: m.id, error: "请求不在允许范围内" });
          return;
        }
        inflight.current++;
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api("/charts/data", {
              instrument: q.instrument,
              timeframe: q.timeframe,
              limit: q.limit,
              indicators: q.indicators || [],
              ...(q.before ? { before: q.before } : {}),
            }),
          });
        } catch (e) {
          reply({ type: "result", id: m.id, error: String(e) });
        } finally {
          inflight.current--;
        }
      } else if (m.type === "snapshot") {
        const id = current.current?.id,
          document = m.document;
        if (
          mobile ||
          !id ||
          document?.engine !== "tv31" ||
          document?.schemaVersion !== 1 ||
          JSON.stringify(document).length > 4_000_000
        )
          return;
        const waiters = flushWaiters.current.splice(0);
        if (blocked.current) {
          waiters.forEach((w) => w.reject(Error("存在未保存草稿，请复制恢复")));
          return;
        }
        if (
          JSON.stringify(document) === JSON.stringify(current.current?.document)
        ) {
          waiters.forEach((w) => w.resolve());
          setStatus("已保存");
          return;
        }
        try {
          localStorage.setItem("mw-tv-draft:" + id, JSON.stringify(document));
        } catch (e) {
          setError("本地草稿空间不足，将继续尝试服务器保存");
        }
        setStatus("正在保存");
        queue.current = queue.current.then(async () => {
          if (blocked.current || current.current?.id !== id) {
            waiters.forEach((w) =>
              w.reject(Error("保存已暂停，请保留此页面并处理冲突")),
            );
            return;
          }
          try {
            const row = await api<Workspace>(
              `/advanced-charts/workspaces/${id}/save`,
              {
                name: current.current.name,
                revision: current.current.revision,
                document,
              },
            );
            if (current.current?.id === id) {
              current.current = row;
              setRows((prev) => prev.map((x) => (x.id === id ? row : x)));
              setStatus("已自动保存");
              setError("");
              if (
                localStorage.getItem("mw-tv-draft:" + id) ===
                JSON.stringify(document)
              )
                localStorage.removeItem("mw-tv-draft:" + id);
            }
            waiters.forEach((w) => w.resolve());
          } catch (e) {
            waiters.forEach((w) => w.reject(new Error(String(e))));
            blocked.current = true;
            setStatus("保存已暂停");
            setError(String(e));
          }
        });
      }
    };
    addEventListener("message", listener);
    return () => removeEventListener("message", listener);
  }, [origin]);
  async function create() {
    const name = prompt("工作区名称", "我的图表");
    if (!name?.trim()) return;
    try {
      await flush();
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: name.trim(),
      });
      setRows((p) => [row, ...p]);
      select(row);
    } catch (e) {
      setError(String(e));
    }
  }
  async function rename() {
    const row = current.current;
    if (!row) return;
    const name = prompt("工作区名称", row.name);
    if (!name?.trim()) return;
    try {
      await flush();
      const updated = await api<Workspace>(
        `/advanced-charts/workspaces/${row.id}/save`,
        { ...current.current, name: name.trim() },
      );
      current.current = updated;
      setRows((p) => p.map((x) => (x.id === row.id ? updated : x)));
      setActive(updated);
    } catch (e) {
      setError(String(e));
    }
  }
  async function copy() {
    try {
      if (!blocked.current) await flush();
      const old = current.current;
      if (!old) return;
      const draft = localStorage.getItem("mw-tv-draft:" + old.id);
      const document = draft ? JSON.parse(draft) : old.document;
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: old.name + " 副本",
      });
      const saved = await api<Workspace>(
        `/advanced-charts/workspaces/${row.id}/save`,
        { name: row.name, revision: row.revision, document },
      );
      localStorage.removeItem("mw-tv-draft:" + old.id);
      setRows((p) => [saved, ...p]);
      select(saved);
    } catch (e) {
      setError(String(e));
    }
  }
  async function remove() {
    const row = current.current;
    if (!row || !confirm("删除工作区 " + row.name + "？")) return;
    try {
      await flush();
      await api(`/advanced-charts/workspaces/${row.id}/delete`, {
        revision: current.current!.revision,
      });
      const list = await refresh();
      if (list[0]) select(list[0]);
      else {
        current.current = null;
        setActive(null);
        setStatus("新建工作区开始使用");
      }
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <main className="advanced-workspace">
      <header>
        <a href="/">守望</a>
        <a href="/chart-workspaces">原图表夹</a>
        <select
          aria-label="工作区"
          value={active?.id || ""}
          onChange={async (e) => {
            const id = e.target.value;
            try {
              await flush();
              const list = await refresh();
              const row = list.find((r) => r.id === id);
              if (row) select(row);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <option value="" disabled>
            选择工作区
          </option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button disabled={mobile} onClick={create}>
          新建
        </button>
        <button disabled={!active || mobile} onClick={rename}>
          重命名
        </button>
        <button disabled={!active || mobile} onClick={copy}>
          复制
        </button>
        <button disabled={!active || mobile} onClick={remove}>
          删除
        </button>
        <button
          disabled={!active || mobile}
          onClick={() => post({ type: "save" })}
        >
          立即保存
        </button>
        <button
          onClick={() =>
            post({
              type: "theme",
              theme:
                current.current?.document.theme === "Light" ? "Dark" : "Light",
            })
          }
        >
          深色 / 浅色
        </button>
        <span role="status">{status}</span>
      </header>
      {error && (
        <div role="alert" className="advanced-error">
          {error}
          <button onClick={() => location.reload()}>重新加载</button>
        </div>
      )}
      {active ? (
        <iframe
          key={active.id}
          ref={frame}
          title="专业图表工作区"
          src={`${origin}/?parent=${encodeURIComponent(location.origin)}`}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
        />
      ) : (
        <section>
          <h1>专业图表夹</h1>
          <p>独立工作区，沿用守望行情。</p>
          <button disabled={mobile} onClick={create}>
            新建工作区
          </button>
        </section>
      )}
    </main>
  );
}
