import { readSnapshot, writeSnapshot, profileActive, type Profile } from "./cache";

type Page = { bars: any[]; as_of?: number; [key: string]: any };
type Entry = { key: string; query: any; page: Page; at: number };
const keyOf = (q: any) => JSON.stringify([q.series_kind || "managed", q.instrument, q.timeframe]);
const startOf = (bar: any) => bar.chart_time ?? bar.start;
const MAX_BARS = 6000;

/** Phone-only display bootstrap. Cached pages never establish live acceptance. */
export function mobileChartHistory(profile: Profile, changed: (query: any, error?: unknown) => void) {
  let entries: Entry[] = [], writes = Promise.resolve(), disposed = false;
  const used = new Set<string>(), bootstrapping = new Set<string>(), fresh = new Map<string, Entry>();
  const active = () => !disposed && profileActive(profile);
  const ordinary = (q: any) => (q.mobile_history === true || q.mobile_first_screen === true) &&
    !q.indicators?.length && !q.native_reserve;
  const unbound = (q: any) => q.revision_after === undefined && q.input_revision === undefined &&
    q.revision_before === undefined && !q.composite_revision_id &&
    !q.display_snapshot_id && !q.provider_snapshot_id;
  const slice = (entry: Entry | undefined, q: any) => {
    if (!entry || !Array.isArray(entry.page.bars)) return undefined;
    const bars = entry.page.bars.filter(bar => startOf(bar) < (q.before || Infinity));
    const needed = q.countBack || q.limit || 1;
    if (needed > MAX_BARS) return undefined;
    if (bars.length < needed && entry.page.has_more !== false) return undefined;
    if (q.from && startOf(bars[0] || {}) > q.from && entry.page.has_more !== false) return undefined;
    if (!bars.length) return undefined;
    return { ...entry.page, bars };
  };
  const save = (q: any, page: Page) => {
    if (!active() || !Array.isArray(page?.bars) || !page.bars.length || page.pending?.length || page.mobile_cached) return;
    const key = keyOf(q), old = entries.find(row => row.key === key);
    if (old && (old.page.as_of || 0) > (page.as_of || 0)) return;
    const entry = { key, query: { ...q }, page, at: Date.now() };
    // Native studies can request older warm-up bars after the first page. Keep
    // these real pages too, so the next cold start can draw studies from cache.
    const revision = (value: Page) => JSON.stringify([value.revision_id,value.cache_revision,
      value.provider_snapshot_id,value.display_snapshot_id,value.input_revision]);
    const sameRevision=old && revision(old.page) === revision(page);
    if(old && !unbound(q) && !sameRevision)return;
    let stored=entry;
    if(old && sameRevision) {
      const bars=[...new Map([...old.page.bars,...page.bars].map(bar=>[startOf(bar),bar])).values()]
        .sort((a,b)=>startOf(a)-startOf(b));
      const earliest=startOf(page.bars[0]) <= startOf(old.page.bars[0]) ? page : old.page;
      stored={...entry,page:{...page,bars,has_more:earliest.has_more}};
    }
    entries = [stored, ...entries.filter(row => row.key !== key)].slice(0, 6).map(row => row.page.bars.length > MAX_BARS ? {
      ...row, page:{...row.page,bars:row.page.bars.slice(-MAX_BARS),has_more:true},
    } : row);
    const snapshot=entries;
    writes = writes.catch(() => {}).then(() => active() ? writeSnapshot(profile, "chart-history", snapshot) : undefined);
    void writes.catch(() => {});
    return entry;
  };
  return {
    async load() {
      const saved = await readSnapshot<Entry[]>(profile, "chart-history").catch(() => undefined);
      if (active()) entries = Array.isArray(saved?.value) ? saved.value.filter(row =>
        typeof row?.key === "string" && Array.isArray(row.page?.bars) && row.page.bars.length <= MAX_BARS).slice(0, 6) : [];
    },
    async read(q: any, fetchPage: () => Promise<any>) {
      if (!ordinary(q)) return fetchPage();
      const key=keyOf(q);
      if(!unbound(q)) {const page=await fetchPage();save(q,page);return page;}
      if(!q.mobile_first_screen) {
        const cached=bootstrapping.has(key) ? slice(entries.find(row=>row.key===key),q) : undefined;
        if(cached)return {...cached,mobile_cached:true};
        const page=await fetchPage();save(q,page);return page;
      }
      const current = fresh.get(key), seed = slice(current, q);
      if (seed) { fresh.delete(key);bootstrapping.delete(key);return {...seed,mobile_revalidated:true}; }
      const cached = !used.has(key) ? slice(entries.find(row => row.key === key), q) : undefined;
      used.add(key);
      if (!cached) {
        const result = await fetchPage(); save(q, result);
        if(!result.pending?.length)bootstrapping.delete(key);
        return {...result,mobile_revalidated:!result.pending?.length};
      }
      bootstrapping.add(key);
      void fetchPage().then(page => {
        if (!active()) return;
        const entry = save(q, page);
        if (entry) { fresh.set(key, entry); changed(q); }
        else changed(q, Error("行情仍在准备，请稍后重试"));
      }, error => { if (active()) changed(q, error); });
      return { ...cached, mobile_cached: true };
    },
    dispose() { disposed = true; fresh.clear();bootstrapping.clear(); },
  };
}
