import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";
import { seriesIdentity } from "./market";
import {
  addSymbol,
  allSymbols,
  saveWatchlists,
  watchContent,
  watchPreference,
  type WatchPreference,
  type WatchList,
} from "./watchlists";
import MobileSheet from "./MobileSheet";

type Row = {
  ticker: string;
  id?: string;
  symbol?: string;
  display_symbol?: string;
  description?: string;
  series_kind?: string;
  source?: string;
  dataset_id?: string;
  [key: string]: any;
};
type Page = {
  items: Row[];
  next_offset?: number | null;
  next_cursor?: string | null;
  has_more?: boolean;
};
const sources = [
  ["", "全部来源"],
  ["oanda", "OANDA"],
  ["dukascopy", "Dukascopy"],
  ["fxcm", "FXCM"],
  ["binance", "Binance"],
  ["yahoo", "Yahoo"],
  ["akshare", "AKShare"],
];

export default function DataPage({
  profile,
  online,
  visible,
  open,
  report,
}: {
  profile: Profile;
  online: boolean;
  visible: boolean;
  open(ticker: string): void;
  report(message: string): void;
}) {
  const [kind, setKind] = useState("composite"),
    [query, setQuery] = useState(""),
    [source, setSource] = useState("");
  const [pages, setPages] = useState<{ offset: number; cursor?: string }[]>([
    { offset: 0 },
  ]);
  const [page, setPage] = useState<Page>(),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false);
  const [readAt, setReadAt] = useState<number>(),
    [retry, setRetry] = useState(0),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<Row>(),
    [detail, setDetail] = useState<any>(),
    [detailError, setDetailError] = useState("");
  const [groups, setGroups] = useState<WatchList[]>([]),
    [targetGroup, setTargetGroup] = useState("");
  const [versions, setVersions] = useState<any[]>();
  const [favorites, setFavorites] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [added, setAdded] = useState(false);
  const [support, setSupport] = useState<{
    title: string;
    rows: any[];
    page: number;
    total?: number;
  }>();
  const generation = useRef(0);
  const position = pages.at(-1)!;
  const cacheName =
    "data-page:" + JSON.stringify([kind, query, source, position]);
  useEffect(() => {
    if (!visible) return;
    const token = ++generation.current,
      controller = new AbortController();
    setLoading(true);
    setError("");
    setLoaded(false);
    setPage(undefined);
    const timer = setTimeout(async () => {
      try {
        const cached = await readSnapshot<Page>(profile, cacheName);
        if (token !== generation.current || controller.signal.aborted) return;
        if (cached) {
          setPage(cached.value);
          setReadAt(cached.readAt);
          setLoaded(true);
        }
        if (!online) return;
        const params = new URLSearchParams({
          kind,
          query,
          source,
          include_total: "false",
          page_size: "25",
          offset: String(position.offset),
        });
        if (position.cursor) params.set("cursor", position.cursor);
        const value = await api<Page>(
          "/market-data/series/page?" + params,
          undefined,
          controller.signal,
        );
        if (token !== generation.current || controller.signal.aborted) return;
        setPage(value);
        setLoaded(true);
        setReadAt(undefined);
        await writeSnapshot(profile, cacheName, value).catch(() =>
          report("目录快照未能写入本机"),
        );
      } catch (error) {
        if (!controller.signal.aborted && token === generation.current) {
          setError(String(error));
          report(String(error));
        }
      } finally {
        if (token === generation.current) setLoading(false);
      }
    }, 250);
    return () => {
      ++generation.current;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    online,
    visible,
    cacheName,
    retry,
    profile.origin,
    profile.subject,
    report,
  ]);
  useEffect(() => {
    if (!visible || !online) return;
    const controller = new AbortController();
    void api<WatchPreference[]>(
      "/advanced-charts/preferences",
      undefined,
      controller.signal,
    )
      .then((rows) => {
        if (!controller.signal.aborted) {
          const content = watchContent(watchPreference(rows));
          setFavorites(allSymbols(content));
          setGroups(content.lists);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) report(String(error));
      });
    return () => controller.abort();
  }, [visible, online, report]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDetail(undefined);
    setDetailError("");
    setAdded(favorites.includes(selected.ticker));
    const name = "data-detail:" + selected.ticker;
    void (async () => {
      try {
        const cached = await readSnapshot<any>(profile, name);
        if (controller.signal.aborted) return;
        if (cached) setDetail({ ...cached.value, cachedAt: cached.readAt });
        if (!online) return;
        const identity = seriesIdentity(selected.ticker);
        const meta = await api<any>(
          "/market-data/resolve",
          { ...identity, timeframe: "M1" },
          controller.signal,
        );
        let extra: any = {};
        if (identity.series_kind === "composite" && meta.created !== false)
          extra = await api(
            "/market-data/composites/" +
              encodeURIComponent(identity.instrument),
            undefined,
            controller.signal,
          );
        else if (identity.series_kind === "history")
          extra = await api(
            "/market-data/versions/" + encodeURIComponent(identity.instrument),
            undefined,
            controller.signal,
          );
        const value = {
          ...selected,
          ...extra,
          ...meta,
          ...(extra.active_revision_id
            ? { active_revision_id: extra.active_revision_id }
            : {}),
          revision: extra.revision,
          periods: extra.periods,
          preparation: extra.preparation,
          mapping: extra.mapping,
        };
        if (controller.signal.aborted) return;
        setDetail(value);
        await writeSnapshot(profile, name, value).catch(() => {});
      } catch (error) {
        if (!controller.signal.aborted) {
          setDetailError(String(error));
          report(String(error));
        }
      }
    })();
    return () => controller.abort();
  }, [selected?.ticker, online, profile.origin, profile.subject, report]);
  async function add(row: Row) {
    if (!online || busy) return;
    setBusy(true);
    try {
      const baseline = watchPreference(
        await api<WatchPreference[]>("/advanced-charts/preferences"),
      );
      const content = watchContent(baseline);
      if (
        (targetGroup
          ? content.lists.find((list) => list.id === targetGroup)?.symbols || []
          : allSymbols(content)
        ).includes(row.ticker)
      ) {
        setAdded(true);
        return;
      }
      const saved = await saveWatchlists(
        api,
        baseline,
        addSymbol(content, row.ticker, targetGroup),
      );
      if (!profileActive(profile)) return;
      setFavorites(allSymbols(watchContent(saved)));
      setGroups(watchContent(saved).lists);
      setAdded(true);
      await writeSnapshot(profile, "watchlists", saved).catch(() =>
        report("自选已保存，本机快照未更新"),
      );
      dispatchEvent(new Event("mw-mobile-watchlists-changed"));
      report("已加入自选");
    } catch (error) {
      report(String(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (selected)
      setAdded(
        (targetGroup
          ? groups.find((list) => list.id === targetGroup)?.symbols || []
          : favorites
        ).includes(selected.ticker),
      );
  }, [selected?.ticker, targetGroup, groups, favorites]);
  async function statuses(title: string, pageNumber = 1) {
    if (!online) {
      report("连接核验后可读取最新任务与来源状态");
      return;
    }
    try {
      const params = new URLSearchParams({
        page: String(pageNumber),
        page_size: "20",
        query,
        source,
      });
      if (title === "来源状态") {
        const [capabilities, directory, live] = await Promise.all([
          api<any[]>("/market-data/sources"),
          api<any[]>("/market-data/catalog/directory-status"),
          api<any>("/market-data/live/status"),
        ]);
        setSupport({
          title,
          rows: [
            ...capabilities.map((row) => ({
              ...row,
              id: row.source,
              category: "来源能力",
            })),
            ...(Array.isArray(directory) ? directory : []).map((row) => ({
              ...row,
              category: "目录同步",
            })),
            { ...live.provider, id: "实时来源", category: "实时连接" },
          ],
          page: 1,
        });
      } else {
        const value = await api<any>(
          title === "任务记录"
            ? "/market-data/center/tasks?" + params
            : "/market-data/center/datasets?" + params,
        );
        setSupport({
          title,
          rows: value.items || [],
          page: pageNumber,
          total: value.total,
        });
      }
    } catch (error) {
      report(String(error));
    }
  }
  return (
    <section hidden={!visible} className="mobile-content mobile-data">
      <div className="mobile-tabs" role="group" aria-label="行情类型">
        {[
          ["provider", "平台"],
          ["history", "自建"],
          ["composite", "组合"],
        ].map(([value, title]) => (
          <button
            key={value}
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setPages([{ offset: 0 }]);
            }}
          >
            {title}
          </button>
        ))}
      </div>
      <label>
        搜索代码或中文
        <input
          type="search"
          value={query}
          maxLength={100}
          onChange={(event) => {
            setQuery(event.target.value);
            setPages([{ offset: 0 }]);
          }}
        />
      </label>
      <div className="mobile-inline-actions">
        <label>
          来源
          <select
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPages([{ offset: 0 }]);
            }}
          >
            {sources.map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void statuses("任务记录")}>任务记录</button>
        <button onClick={() => void statuses("来源状态")}>来源状态</button>
        {kind !== "provider" && (
          <button onClick={() => void statuses("自建维护")}>维护状态</button>
        )}
      </div>
      {readAt && <p>上次读取 {new Date(readAt).toLocaleString()}</p>}
      {loading && <p role="status">正在更新目录…</p>}
      {!loading && !loaded && (
        <p>{online ? "读取失败，暂无本页缓存" : "暂无本页缓存"}</p>
      )}
      {error && (
        <button onClick={() => setRetry((value) => value + 1)}>重试读取</button>
      )}
      {loaded && !page?.items.length && <p>没有符合条件的行情。</p>}
      {page?.items.map((row) => (
        <button
          className="mobile-series"
          key={row.ticker}
          onClick={() => setSelected(row)}
        >
          <strong>{row.display_symbol || row.symbol || row.ticker}</strong>
          <span>{row.description || row.ticker}</span>
          {favorites.includes(row.ticker) && <small>已添加</small>}
        </button>
      ))}
      <nav className="mobile-inline-actions" aria-label="行情分页">
        <button
          disabled={loading || pages.length < 2}
          onClick={() => setPages((value) => value.slice(0, -1))}
        >
          上一页
        </button>
        <span>第 {pages.length} 页</span>
        <button
          disabled={
            loading || !page || (!page.next_cursor && page.next_offset == null)
          }
          onClick={() =>
            setPages((value) => [
              ...value,
              {
                offset: page?.next_offset || position.offset + 25,
                ...(page?.next_cursor ? { cursor: page.next_cursor } : {}),
              },
            ])
          }
        >
          下一页
        </button>
      </nav>
      {selected && (
        <MobileSheet
          title={selected.display_symbol || selected.symbol || "行情详情"}
          close={() => setSelected(undefined)}
        >
          <p>{selected.description || selected.ticker}</p>
          <p className="mobile-identity">{selected.ticker}</p>
          {detail?.cachedAt && (
            <p>上次读取 {new Date(detail.cachedAt).toLocaleString()}</p>
          )}
          {!detail && (
            <p>{detailError || (!online ? "没有详情缓存" : "正在读取详情…")}</p>
          )}
          {detail && (
            <dl className="mobile-facts">
              {[
                [
                  "来源",
                  detail.source_display ||
                    detail.historical_source ||
                    detail.source ||
                    selected.source,
                ],
                ["价格口径", detail.price_basis_display || detail.basis],
                [
                  "支持周期",
                  (Array.isArray(detail.frames)
                    ? detail.frames.filter(
                        (frame: any) => typeof frame === "string",
                      )
                    : detail.timeframes || []
                  ).join(" · "),
                ],
                ["当前修订", detail.active_revision_id || detail.revision_id],
                [
                  "固定历史版本",
                  detail.history_version_id ||
                    detail.revision?.history_version_id ||
                    (selected.ticker.startsWith("MWH:")
                      ? detail.id
                      : undefined),
                ],
                [
                  "历史区间",
                  (detail.start ?? detail.revision?.history_start) != null
                    ? `${new Date(detail.start ?? detail.revision.history_start).toLocaleString()} — ${new Date(detail.end ?? detail.revision.history_end).toLocaleString()}`
                    : undefined,
                ],
                ["状态", detail.status || detail.preparation_status],
                [
                  "实时接续",
                  detail.realtime_source_display ||
                    detail.mapping?.source_display ||
                    detail.live_source,
                ],
                [
                  "拼接点",
                  detail.revision?.seam
                    ? new Date(detail.revision.seam).toLocaleString()
                    : undefined,
                ],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          <button
            className="primary"
            onClick={() => {
              setSelected(undefined);
              open(selected.ticker);
            }}
          >
            打开图表
          </button>
          <label>
            添加到分组
            <select
              value={targetGroup}
              onChange={(event) => setTargetGroup(event.target.value)}
            >
              <option value="">默认自选列表</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.title}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!online || busy || added}
            onClick={() => void add(selected)}
          >
            {added ? "已添加" : busy ? "正在添加…" : "加入自选"}
          </button>
          {detail?.periods?.map((period: any) => (
            <p key={period.timeframe}>
              {period.timeframe} · {period.status || "待确认"} ·{" "}
              {period.rows ?? period.available_rows ?? "未知"} 根
            </p>
          ))}
          {detail?.dataset_id && (
            <button
              disabled={!online}
              onClick={async () => {
                try {
                  setVersions(
                    await api<any[]>(
                      "/market-data/versions?dataset_id=" +
                        encodeURIComponent(detail.dataset_id),
                    ),
                  );
                } catch (error) {
                  report(String(error));
                }
              }}
            >
              固定历史版本
            </button>
          )}
          {selected.dataset_id && (
            <button onClick={() => void statuses("自建维护")}>
              查看维护状态
            </button>
          )}
          <p>来源配置、历史维护与组合重构请在桌面完成。</p>
        </MobileSheet>
      )}
      {versions && (
        <MobileSheet title="固定历史版本" close={() => setVersions(undefined)}>
          {!versions.length && <p>暂无版本。</p>}
          {versions.map((version) => (
            <article key={version.id} className="mobile-status-card">
              <p>{version.id}</p>
              <p>
                {version.status} · {new Date(version.start).toLocaleString()} —{" "}
                {new Date(version.end).toLocaleString()}
              </p>
              <button
                disabled={
                  version.status !== "published" ||
                  version.payload_available === false
                }
                onClick={() => {
                  setVersions(undefined);
                  setSelected(undefined);
                  open("MWH:" + version.id);
                }}
              >
                打开此固定版本
              </button>
            </article>
          ))}
        </MobileSheet>
      )}
      {support && (
        <MobileSheet title={support.title} close={() => setSupport(undefined)}>
          {!support.rows.length && <p>本页暂无记录。</p>}
          {support.rows.map((row, index) => (
            <article key={row.id || index} className="mobile-status-card">
              <strong>
                {row.display_symbol ||
                  row.logical_symbol ||
                  row.instrument_id ||
                  row.dataset_id ||
                  row.id}
              </strong>
              <p>
                {row.category} ·{" "}
                {row.source_display || row.identity?.source || row.source} ·{" "}
                {row.status ||
                  row.native_status ||
                  row.task_status ||
                  row.availability ||
                  "状态待确认"}
              </p>
              {(row.timeframes || row.native_periods) && (
                <p>
                  支持周期{" "}
                  {Array.isArray(row.timeframes || row.native_periods)
                    ? (row.timeframes || row.native_periods).join(" · ")
                    : "按来源能力"}
                </p>
              )}
              {row.maintenance && (
                <p>
                  维护
                  {row.maintenance.paused
                    ? "已暂停"
                    : row.maintenance.configured
                      ? "已配置"
                      : "未配置"}
                  {row.maintenance.last_success &&
                    ` · 最近成功 ${new Date(row.maintenance.last_success).toLocaleString()}`}
                </p>
              )}
              {(row.reason || row.error) && <p>{row.reason || row.error}</p>}
            </article>
          ))}
          <div className="mobile-inline-actions">
            <button
              disabled={support.page === 1}
              onClick={() => void statuses(support.title, support.page - 1)}
            >
              上一页
            </button>
            <span>第 {support.page} 页</span>
            <button
              disabled={
                support.rows.length < 20 ||
                (support.total != null && support.page * 20 >= support.total)
              }
              onClick={() => void statuses(support.title, support.page + 1)}
            >
              下一页
            </button>
          </div>
        </MobileSheet>
      )}
    </section>
  );
}
