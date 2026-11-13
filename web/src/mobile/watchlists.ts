/** The native desktop format stays authoritative; selection belongs to this phone. */
export type WatchList = {
  id: string;
  title: string;
  symbols: string[];
  [key: string]: unknown;
};
export type WatchContent = {
  lists: WatchList[];
  active?: string;
  [key: string]: unknown;
};
export type WatchPreference = {
  kind: string;
  name: string;
  tool: string;
  revision: number;
  content: { value: WatchContent; [key: string]: unknown };
  [key: string]: unknown;
};
export const WATCHLIST_NAME = "mw.watchlists.v1";
type Request = <T = any>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
export const allSymbols = (content: WatchContent) => [
  ...new Set(content.lists.flatMap((list) => list.symbols)),
];
export const watchPreference = (rows: WatchPreference[]) =>
  rows.find(
    (row) => row.kind === "setting" && row.name === WATCHLIST_NAME && !row.tool,
  );
export const watchContent = (row?: WatchPreference): WatchContent =>
  row?.content.value || { lists: [] };

function sameLists(a: WatchContent, b: WatchContent) {
  return JSON.stringify(a.lists) === JSON.stringify(b.lists);
}
export async function saveWatchlists(
  request: Request,
  baseline: WatchPreference | undefined,
  lists: WatchList[],
) {
  const latest = watchPreference(
    await request<WatchPreference[]>("/advanced-charts/preferences"),
  );
  if (!sameLists(watchContent(baseline), watchContent(latest)))
    throw Object.assign(
      Error("自选已在其他窗口修改；本次尚未保存，请查看最新后再编辑"),
      { status: 409 },
    );
  // Preserve the latest desktop active and unknown envelope/content fields.
  // A concurrent update after this read is rejected by the server revision.
  return request<WatchPreference>("/advanced-charts/preferences/save", {
    kind: "setting",
    name: WATCHLIST_NAME,
    tool: "",
    revision: latest?.revision || 0,
    content: { ...latest?.content, value: { ...watchContent(latest), lists } },
  });
}
export function addSymbol(
  content: WatchContent,
  ticker: string,
  group: string,
): WatchList[] {
  const lists = structuredClone(content.lists);
  let target = lists.find((list) => list.id === group) || lists[0];
  if (!target) {
    target = { id: crypto.randomUUID(), title: "自选列表", symbols: [] };
    lists.push(target);
  }
  if (!target.symbols.includes(ticker)) target.symbols.push(ticker);
  return lists;
}
export function removeSymbol(
  content: WatchContent,
  ticker: string,
  group: string,
) {
  return content.lists.map((list) => ({
    ...list,
    symbols:
      !group || list.id === group
        ? list.symbols.filter((symbol) => symbol !== ticker)
        : list.symbols,
  }));
}
export function removeGroup(content: WatchContent, id: string) {
  const lists = content.lists
    .filter((list) => list.id !== id)
    .map((list) => structuredClone(list));
  const retained = new Set(lists.flatMap((list) => list.symbols));
  const orphaned = allSymbols(content).filter(
    (ticker) => !retained.has(ticker),
  );
  if (orphaned.length) {
    let ungrouped = lists.find((list) => list.title === "未分组");
    if (!ungrouped) {
      ungrouped = { id: crypto.randomUUID(), title: "未分组", symbols: [] };
      lists.push(ungrouped);
    }
    ungrouped.symbols.push(...orphaned);
  }
  return lists;
}
