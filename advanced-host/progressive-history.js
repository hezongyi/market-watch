/* Bounded observations, separate from durable acquisition plans. */
function progressiveHistory(read, needed, changed, onError, maxEntries = 64) {
  const pages = new Map();
  const inflight = new Map();
  let disposed = false, polling = false;
  const keyOf = args => JSON.stringify([args.instrument,args.timeframe,args.before,args.limit]);
  // Forming OHLC/revision updates already arrive via subscribeBars. Resetting
  // the whole series for each tick races native layout/range restoration.
  // Retain its identity so an empty chart can still acquire its first bar.
  const fingerprint = page => JSON.stringify(page.bars.map(bar => bar.complete === false
    ? {start:bar.start,end:bar.end,complete:false} : bar));
  async function fetchPage(args, warm = false) {
    const key = keyOf(args);
    if (inflight.has(key)) return inflight.get(key);
    const promise = read(args, warm).finally(()=>inflight.delete(key));
    inflight.set(key,promise);
    return promise;
  }
  function remember(args,page) {
    const key=keyOf(args);
    pages.delete(key);
    pages.set(key,{args,page,signature:fingerprint(page),at:Date.now()});
    while(pages.size>maxEntries) pages.delete(pages.keys().next().value);
  }
  return {
    async warm(args) {
      if (disposed) return;
      const old=pages.get(keyOf(args));
      if (old && Date.now()-old.at<15000) return;
      const page=await fetchPage(args,true);
      if (!disposed) remember(args,page);
    },
    async get(args) {
      const key = keyOf(args);
      const old = pages.get(key);
      // Latest snapshots are stale-while-revalidate: the active poll and live
      // subscription refresh them without blocking a period switch.
      if (old && (args.before == null || Date.now()-old.at < 15000)) return old.page;
      // Native countBack and end timestamps vary slightly between requests.
      // Reuse only pages that actually contain enough bars before that boundary.
      for (const entry of [...pages.values()].reverse()) {
        const latest = args.before == null && entry.args.before == null;
        if ((!latest && Date.now()-entry.at>=15000) || entry.args.instrument!==args.instrument ||
            entry.args.timeframe!==args.timeframe ||
            (!latest && (args.before == null || entry.args.before == null || entry.args.before<args.before))) continue;
        const bars=entry.page.bars.filter(bar=>latest || bar.start<args.before).slice(-args.limit);
        if (bars.length===args.limit) {
          const page={...entry.page,bars};
          remember(args,page);
          return page;
        }
      }
      const page = await fetchPage(args);
      if (!disposed && needed(args)) remember(args,page);
      return page;
    },
    async poll() {
      if (disposed || polling) return;
      polling = true;
      try {
        for (const [key,entry] of [...pages]) {
          if (!needed(entry.args)) continue;
          try {
            const page = await fetchPage(entry.args);
            if (disposed || !needed(entry.args) || pages.get(key)!==entry) continue;
            const signature = fingerprint(page);
            const differs = signature !== entry.signature;
            Object.assign(entry,{page,at:Date.now()});
            if (!differs || await changed(entry.args) !== false) entry.signature = signature;
          } catch(error) { if (!disposed && needed(entry.args)) onError(error); }
        }
      } finally { polling=false; }
    },
    dispose() {disposed=true;pages.clear();},
  };
}

// Synthetic studies share the raw observation boundary. Indicator calculation
// may see more persisted rows; never expose those outside the usable page.
async function progressiveIndicatorPage(page, calculate) {
  if (!page.bars.length) return {...page, indicators: []};
  const result = await calculate();
  const starts = new Set(page.bars.map(bar => bar.start));
  return {...result, bars: result.bars.filter(bar => starts.has(bar.start))};
}
