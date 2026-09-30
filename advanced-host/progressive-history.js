/* Bounded observations, separate from durable acquisition plans. */
function progressiveHistory(read, needed, changed, onError, maxEntries = 64) {
  const pages = new Map();
  const inflight = new Map();
  let disposed = false, polling = false;
  const keyOf = args => JSON.stringify([args.instrument,args.timeframe,args.before,args.limit]);
  const fingerprint = page => JSON.stringify(page.bars);
  async function fetchPage(args) {
    const key = keyOf(args);
    if (inflight.has(key)) return inflight.get(key);
    const promise = read(args).finally(()=>inflight.delete(key));
    inflight.set(key,promise);
    return promise;
  }
  return {
    async get(args) {
      const key = keyOf(args);
      const old = pages.get(key);
      if (old && Date.now()-old.at < 2000) return old.page;
      const page = await fetchPage(args);
      if (!disposed && needed(args)) {
        pages.delete(key);
        pages.set(key,{args,page,signature:fingerprint(page),at:Date.now()});
        while(pages.size>maxEntries) pages.delete(pages.keys().next().value);
      }
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
