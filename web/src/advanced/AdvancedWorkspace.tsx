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

export default function AdvancedWorkspace() {
  const [rows, setRows] = useState<Workspace[]>([]),
    [active, setActive] = useState<Workspace | null>(null);
  const [feedError, setFeedError] = useState("");
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef<Workspace | null>(null);
  const flushWaiters = useRef<
    { resolve: () => void; reject: (e: Error) => void }[]
  >([]);
  const mobile = matchMedia("(max-width:700px), (pointer:coarse)").matches;
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
          if (!mobile) await api("/advanced-charts/preferences/migrate", {});
          reply({
            type: "init",
            document: current.current?.document || {},
            workspace: current.current,
            readonly: mobile,
            catalog: await api("/advanced-charts/catalog"),
            preferences: await api("/advanced-charts/preferences"),
          });
        } catch (e) {
          setError(String(e));
        }
      } else if (m.type === "ready") setStatus("已加载 · 行情每15秒检查");
      else if (m.type === "error") setFeedError(String(m.error).slice(0, 500));
      else if (m.type === "native-saved") {
        setStatus("已保存");
        flushWaiters.current.splice(0).forEach((w) => w.resolve());
      } else if (m.type === "workspace") {
        const q = m.query;
        if (
          !q ||
          !["list", "load", "save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 4_100_000 ||
          (mobile && ["save", "delete"].includes(q.op))
        ) {
          reply({ type: "result", id: m.id, error: "工作区操作不允许" });
          return;
        }
        if (
          ["load", "delete"].includes(q.op) &&
          !/^[a-zA-Z0-9-]{1,40}$/.test(q.args?.id || "")
        ) {
          reply({ type: "result", id: m.id, error: "无效工作区标识" });
          return;
        }
        try {
          await queue.current;
          if (
            blocked.current &&
            (q.op === "load" || (q.op === "save" && q.args?.id))
          )
            throw Error("存在未保存草稿，请先复制恢复为独立工作区");
          const draftId = q.op === "save" ? q.args?.id : null;
          const draft = draftId
            ? JSON.stringify({
                engine: "tv31",
                schemaVersion: 1,
                state: JSON.parse(q.args.content),
                symbol: q.args.symbol,
                interval: q.args.resolution,
              })
            : null;
          if (draftId && draft) {
            try {
              localStorage.setItem("mw-tv-draft:" + draftId, draft);
            } catch {
              setError("本地草稿空间不足，请勿关闭页面，等待服务器保存完成");
            }
          }
          let result;
          if (q.op === "list")
            result = await api("/advanced-charts/native-charts");
          else if (q.op === "load")
            result = await api("/advanced-charts/native-charts/" + q.args.id);
          else if (q.op === "save")
            result = await api("/advanced-charts/native-charts/save", q.args);
          else
            result = await api(
              "/advanced-charts/workspaces/" + q.args.id + "/delete",
              { revision: q.args.revision },
            );
          if (q.op === "save" || q.op === "load") {
            if (
              draftId &&
              localStorage.getItem("mw-tv-draft:" + draftId) === draft
            )
              localStorage.removeItem("mw-tv-draft:" + draftId);
            current.current = {
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            };
            setRows((p) =>
              p.some((x) => x.id === result.id)
                ? p.map((x) => (x.id === result.id ? current.current! : x))
                : [current.current!, ...p],
            );
          }
          reply({ type: "result", id: m.id, result });
        } catch (e) {
          if (
            q.op === "save" &&
            q.args?.id &&
            localStorage.getItem("mw-tv-draft:" + q.args.id)
          ) {
            blocked.current = true;
            setStatus("保存已暂停 · 草稿已保留，请复制恢复");
          }
          setError(String(e));
          reply({ type: "result", id: m.id, error: String(e) });
        }
      } else if (m.type === "preferences") {
        const q = m.query;
        if (
          mobile ||
          !q ||
          !["save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 1_100_000
        ) {
          reply({ type: "result", id: m.id, error: "设置请求不允许" });
          return;
        }
        if (q.op === "delete" && !/^[a-f0-9]{64}$/.test(q.args?.id || "")) {
          reply({ type: "result", id: m.id, error: "无效设置标识" });
          return;
        }
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api(
              q.op === "save"
                ? "/advanced-charts/preferences/save"
                : "/advanced-charts/preferences/" + q.args.id + "/delete",
              q.args,
            ),
          });
        } catch (e) {
          reply({ type: "result", id: m.id, error: String(e) });
        }
      } else if (m.type === "market") {
        const q = m.query;
        const endpoints: Record<string, string> = {
          search: "/market-data/catalog",
          resolve: "/market-data/resolve",
          history: "/market-data/history",
          activity: "/market-data/activity",
          retry: "/market-data/retry",
          quotes: "/market-data/quotes",
        };
        if (
          !q ||
          !Object.hasOwn(endpoints, q.op) ||
          JSON.stringify(q).length > 4000 ||
          (q.op === "retry" &&
            !/^[a-zA-Z0-9-]{1,40}$/.test(String(q.args?.id || ""))) ||
          inflight.current >= 8
        ) {
          reply({ type: "result", id: m.id, error: "无效行情请求" });
          return;
        }
        inflight.current++;
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api(
              endpoints[q.op] +
                (q.op === "search"
                  ? "?query=" + encodeURIComponent(String(q.args?.query || ""))
                  : q.op === "retry"
                    ? "/" + encodeURIComponent(q.args.id)
                    : ""),
              q.op === "search" ? undefined : q.args,
            ),
          });
        } catch (e) {
          reply({ type: "result", id: m.id, error: String(e) });
        } finally {
          inflight.current--;
        }
      } else if (m.type === "status") {
        setStatus(String(m.text).slice(0, 200));
        if (m.text === "行情已加载") setFeedError("");
      } else if (m.type === "data") {
        const q = m.query;
        if (
          !q ||
          (q.indicators !== undefined &&
            (!Array.isArray(q.indicators) ||
              q.indicators.length > 1 ||
              JSON.stringify(q.indicators).length > 2000)) ||
          typeof q.instrument !== "string" ||
          q.instrument.length > 80 ||
          !frames.has(q.timeframe) ||
          !Number.isInteger(q.limit) ||
          q.limit < 1 ||
          q.limit > 2000 ||
          (q.before !== undefined &&
            (!Number.isSafeInteger(q.before) || q.before <= 0)) ||
          (q.revision_before !== undefined &&
            (!Number.isSafeInteger(q.revision_before) ||
              q.revision_before <= 0)) ||
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
              track_history: q.track_history === true,
              ...(q.revision_before
                ? { revision_before: q.revision_before }
                : {}),
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
      {(error || feedError) && (
        <div role="alert" className="advanced-error">
          {error || feedError}
          <button onClick={() => location.reload()}>重新加载</button>
        </div>
      )}
      {active ? (
        <iframe
          key={active.id}
          ref={frame}
          title="专业图表工作区"
          src={`${origin}/?parent=${encodeURIComponent(location.origin)}`}
          sandbox="allow-scripts allow-same-origin allow-downloads"
          allowFullScreen
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
