import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import "./advanced.css";
import { ExportDialog, type ExportSelection } from "./ExportDialog";

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
  const [, setRows] = useState<Workspace[]>([]),
    [active, setActive] = useState<Workspace | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [exportSelection, setExportSelection] =
    useState<ExportSelection | null>(null);
  const [feedError, setFeedError] = useState("");
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef<Workspace | null>(null);
  const unsaved = useRef(false);
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
    unsaved.current = false;
    current.current = row;
    blocked.current =
      !mobile && !!localStorage.getItem("mw-tv-draft:" + row.id);
    setActive(row);
    setFrameKey((key) => key + 1);
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
    const protect = (event: BeforeUnloadEvent) => {
      if (mobile || !unsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", protect);
    return () => removeEventListener("beforeunload", protect);
  }, [mobile]);
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
      } else if (m.type === "export-selection") {
        const value = m.selection;
        if (
          value &&
          typeof value.instrument === "string" &&
          value.instrument.length <= 80 &&
          frames.has(value.timeframe) &&
          Array.isArray(value.indicators) &&
          value.indicators.length <= 12 &&
          JSON.stringify(value).length < 20000
        )
          setExportSelection(value);
      } else if (m.type === "workspace-action") {
        if (m.action === "home") location.assign("/");
        else if (!mobile && m.action === "create") await create();
      } else if (m.type === "ready") setStatus("已加载 · 行情每15秒检查");
      else if (m.type === "error") setFeedError(String(m.error).slice(0, 500));
      else if (m.type === "native-saving") {
        if (!mobile) unsaved.current = true;
        setStatus("正在保存");
      } else if (m.type === "native-saved") {
        unsaved.current = false;
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
                ...(current.current?.id === draftId
                  ? current.current?.document
                  : {}),
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
          if (
            q.op === "load" &&
            (!result.document?.state ||
              Object.keys(result.document.state).length === 0)
          ) {
            // A never-saved workspace has no vendor layout envelope. Initialize
            // a fresh widget instead of loading {} or copying the current chart.
            select({
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            });
            setFeedError("");
            return;
          }
          if (q.op === "save" || q.op === "load") {
            // A successful native Save As binds a new independent workspace.
            // Keep any older failed draft available under its original ID.
            if (q.op === "save" && !q.args?.id) {
              blocked.current = false;
              setError("");
              setFeedError("");
              setStatus("已另存为独立工作区");
            }
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
            // Native loads happen inside the existing widget. Reflect their
            // identity without recreating the iframe or discarding chart state.
            setActive(current.current);
            setRows((p) =>
              p.some((x) => x.id === result.id)
                ? p.map((x) => (x.id === result.id ? current.current! : x))
                : [current.current!, ...p],
            );
          }
          if (q.op === "delete")
            setRows((previous) =>
              previous.filter((row) => row.id !== q.args.id),
            );
          reply({ type: "result", id: m.id, result });
          if (q.op === "delete" && current.current?.id === q.args.id) {
            // Do not leave a widget bound to a record which no longer exists.
            // Deletion is already committed; a refresh failure must not revive it.
            current.current = null;
            unsaved.current = false;
            blocked.current = false;
            setActive(null);
            setError("");
            setStatus("工作区已删除");
            try {
              const remaining = await refresh();
              if (remaining[0]) select(remaining[0]);
            } catch (e) {
              setError("工作区已删除，列表加载失败：" + String(e));
            }
          }
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
      } else if (m.type === "style-template-name") {
        const name = mobile
          ? null
          : prompt("图表样式模板名称（同名将覆盖）", "我的样式");
        const value = name?.trim() || "";
        reply(
          value.length > 128
            ? { type: "result", id: m.id, error: "模板名称不能超过128字" }
            : { type: "result", id: m.id, result: value },
        );
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
          (q.revision_after !== undefined &&
            (!Number.isSafeInteger(q.revision_after) ||
              q.revision_after < 0)) ||
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
              ...(q.revision_after !== undefined
                ? { revision_after: q.revision_after }
                : {}),
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
  return (
    <main className="advanced-workspace">
      {exportSelection && (
        <ExportDialog
          selection={exportSelection}
          onClose={() => setExportSelection(null)}
        />
      )}
      <div
        className="advanced-status"
        role="status"
        aria-live="polite"
        data-idle={/^(行情已加载|已加载|已保存|已另存)/.test(status)}
      >
        {status}
      </div>
      {(error || feedError) && (
        <div role="alert" className="advanced-error">
          {error || feedError}
          {!mobile && blocked.current && (
            <button onClick={copy}>复制恢复草稿</button>
          )}
          <button onClick={() => location.reload()}>重新加载</button>
        </div>
      )}
      {active ? (
        <iframe
          key={frameKey}
          ref={frame}
          title="专业图表工作区"
          data-workspace-id={active.id}
          src={`${origin}/?parent=${encodeURIComponent(location.origin)}`}
          sandbox="allow-scripts allow-same-origin allow-downloads"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      ) : (
        <section>
          <a href="/">返回守望</a>
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
