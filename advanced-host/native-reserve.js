/* Native history reserve owns no duplicate bar cache. Licensed adapter hooks
 * register its existing threads/models; the host supplies PG-only reads. */
const MWNativeReserve = (() => {
  const models = new Map(), threads = new Map(), flights = new Map();
  const retries = new WeakMap(), caches = new WeakMap();
  const key = (symbol, resolution) => `${symbol}|${resolution}`;
  let transport, calculationPrefix = () => 0;
  const enabled = globalThis.MW_NATIVE_RESERVE_ENABLED !== false &&
    new URLSearchParams(location.search).get('native_reserve') !== 'off';
  const now = () => performance.now();
  const threadKey = t => globalThis.MWNativeNavigation?.threadKey(t._symbolInfo, t._resolution) || key(t._symbolInfo?.ticker || t._symbolInfo?.name, t._resolution);
  const identity = m => globalThis.MWNativeNavigation?.modelKey(m) || key(m.mainSeries().symbol(), m.interval());
  const provider = symbol => typeof symbol === 'string' && symbol.startsWith('MWP:');
  function retryState(thread) {
    // Native reset/purge reuses the thread but replaces its cache object.
    // Keep retries and terminal state scoped to that cache generation.
    if (caches.get(thread) !== thread._cache) {
      caches.set(thread, thread._cache);
      retries.set(thread, {failures:0, misses:0, retryAt:0, boundary:false});
    }
    return retries.get(thread);
  }
  function geometry(m) {
    const ts = m.timeScale(), range = ts.visibleBarsStrictRange();
    const points = ts.points().range().value();
    if (!range || !points || !(ts.width() > 0) || !(ts.barSpacing() > 0)) return;
    const screen = Math.min(2000, Math.ceil(ts.width() / ts.barSpacing()));
    return {ts, range, points, screen, reserve: range.firstBar() - points.firstIndex};
  }
  function schedule(m, delay = 0) {
    const state = models.get(m);
    if (state?.timer && state.identity !== identity(m)) {
      clearTimeout(state.timer); state.timer = 0;
    }
    if (!state || state.disposed || state.timer || state.raf) return;
    if (delay) state.timer = setTimeout(() => {state.timer = 0; schedule(m);}, delay);
    else state.raf = requestAnimationFrame(() => {state.raf = 0; check(m);});
  }
  function tier(state, g) {
    const t = now();
    if (state.previous && t - state.previous.at < 400) {
      const moved = state.previous.offset - g.ts.rightOffset();
      if (moved > 0 && moved / g.screen / Math.max(.016, (t - state.previous.at) / 1000) > 1.5)
        state.enhancedUntil = t + 10000;
    }
    state.previous = {at: t, offset: g.ts.rightOffset()};
    return t < state.enhancedUntil ? {threshold: 3, batch: 2} : {threshold: 2, batch: 1};
  }
  function cachedExtra(thread, g) {
    const first = g.ts.points().valueAt(g.points.firstIndex);
    if (!Number.isFinite(first)) return 0;
    // Native time scale seconds vs adapter milliseconds (DWM already aligned).
    return thread._cache.bars.filter(b => b.time < first * 1000).length;
  }
  async function check(m) {
    const state = models.get(m), g = geometry(m);
    if (!enabled || !transport || !state || !g) return;
    const symbol = m.mainSeries().symbol(), resolution = m.interval();
    if (!provider(symbol)) return;
    const k = identity(m), thread = threads.get(k);
    if (!thread || thread._destroyed) return;
    if (globalThis.MWNativeNavigation?.filling(thread)) return;
    if (state.identity !== k) {
      state.identity = k; state.previous = undefined; state.enhancedUntil = 0;
      state.lastAttemptOffset = g.ts.rightOffset();
    }
    const retry = retryState(thread);
    const mode = tier(state, g), deficit = Math.ceil(mode.threshold * g.screen - g.reserve);
    state.screen = g.screen; state.batch = mode.batch;
    if (g.ts._requestingMoreData) return;
    if ((retry.failures + retry.misses >= 4) &&
        Number.isFinite(state.lastAttemptOffset) &&
        Math.abs(g.ts.rightOffset() - state.lastAttemptOffset) >= g.screen / 4) {
      retry.failures = 0; retry.misses = 0; retry.retryAt = 0;
    }
    if (deficit <= 0 || retry.failures + retry.misses >= 4) return;
    if (now() < retry.retryAt) {schedule(m, retry.retryAt - now()); return;}
    const available = cachedExtra(thread, g);
    // Native engine requests two alignment bars even without an indicator.
    // Keep indicator warmup in the adapter cache when promoting hidden history.
    const warmup = calculationPrefix(symbol, resolution);
    const prefix = thread._endOfData ? 0 : warmup + 2 + (m.mainSeries()._colorOnPrevBar() ? 2 : 0);
    if (available > prefix && !thread._requesting) {
      // Request only already cached points. Mandatory native paging stays native.
      g.ts.requestMoreHistoryPoints(Math.min(deficit, available - prefix));
      schedule(m); return;
    }
    if (retry.boundary || thread._endOfData || g.ts._endOfData) return;
    if (thread._requesting) return;
    if (flights.has(k)) {await flights.get(k); schedule(m); return;}
    const before = thread._cache.bars[0]?.time;
    if (!before) return;
    const requestBefore = thread._dealignTime(before);
    const started = now();
    // Each pane compares subsequent movement with its own geometry. A peer
    // with a different viewport must not restart the shared retry allowance.
    for (const [model, entry] of models) if (identity(model) === k)
      entry.lastAttemptOffset = model.timeScale().rightOffset();
    const cache = thread._cache;
    const current = () => !thread._destroyed && threads.get(k) === thread &&
      !globalThis.MWNativeNavigation?.filling(thread) &&
      thread._cache === cache && thread._cache.bars[0]?.time === before && !thread._requesting;
    const flight = (async () => {
      try {
        const result = await transport({symbol, resolution, before:requestBefore,
          screen_bars: g.screen, batch_screens: mode.batch, warmup_bars: warmup});
        if (!current()) return;
        if (now() - started >= 800)
          for (const [model, entry] of models) if (identity(model) === k)
            entry.enhancedUntil = now() + 10000;
        const rows = result.bars.filter(b => b.time < requestBefore);
        if (rows.length) {
          globalThis.MWNativeNavigation?.admitCached(thread, rows);
          thread._processBars(rows, {noData: result.history_boundary === true});
          retry.failures = 0; retry.misses = 0; retry.retryAt = 0;
        } else if (!rows.length) {
          if (result.history_boundary) {thread._setEndOfData(); retry.boundary = true;}
          else {retry.misses++; retry.retryAt = now() + 1500;}
        }
      } catch (_) {
        if (!current()) return;
        retry.failures++;
        const delay = Math.min(30000, 1000 * 2 ** (retry.failures - 1));
        retry.retryAt = now() + delay;
      }
    })();
    flights.set(k, flight);
    await flight;
    if (flights.get(k) === flight) flights.delete(k);
    // Every completion checks finite viewport demand again; no blind extension.
    for (const [model, entry] of models) if (entry.identity === k) schedule(model);
  }
  return {
    configure(read, prefix = () => 0) {transport = read; calculationPrefix = prefix;
      for (const m of models.keys()) schedule(m);},
    bindThread(thread, info, resolution) {
      if (enabled) {
        threads.set(globalThis.MWNativeNavigation?.threadKey(info, resolution) || key(info.ticker || info.name, resolution), thread);
        retryState(thread);
      }
    },
    unbindThread(thread) {if (threads.get(threadKey(thread)) === thread) threads.delete(threadKey(thread));},
    bindModel(m) {
      if (!enabled || models.has(m)) return;
      const state = {identity: '', enhancedUntil: 0};
      models.set(m, state);
      requestAnimationFrame(() => {
        if (!models.has(m)) return;
        m.timeScale().visibleBarsStrictRangeChanged().subscribe(state, () => schedule(m));
        m.timeScale().barSpacingChanged().subscribe(state, () => schedule(m));
        schedule(m);
      });
    },
    unbindModel(m) {
      const state = models.get(m); if (!state) return;
      state.disposed = true; clearTimeout(state.timer); cancelAnimationFrame(state.raf);
      m.timeScale().visibleBarsStrictRangeChanged().unsubscribeAll(state);
      m.timeScale().barSpacingChanged().unsubscribeAll(state); models.delete(m);
    },
    extra(info, resolution) {
      if (!enabled || !provider(info.ticker || info.name)) return 0;
      let extra = 0;
      for (const [m, state] of models) {
        if (m.mainSeries().symbol() !== (info.ticker || info.name) || m.interval() !== resolution ||
            (globalThis.MWNativeNavigation && identity(m) !== MWNativeNavigation.threadKey(info, resolution))) continue;
        const g = geometry(m);
        if (g) extra = Math.max(extra, Math.ceil(g.screen * (state.batch || 1)));
      }
      return Math.min(4000, extra);
    },
    extraFromCache(thread, request, end) {
      const info = thread._symbolInfo, res = thread._resolution;
      if (!enabled || !provider(info.ticker || info.name)) return 0;
      return Math.min(this.extra(info, res), Math.max(0, end - request.countBack -
        (thread._endOfData ? 0 : calculationPrefix(info.ticker || info.name, res))));
    },
    delivered(info, resolution, duration) {
      for (const [m, state] of models) if (m.mainSeries().symbol() === (info.ticker || info.name) && m.interval() === resolution &&
        (!globalThis.MWNativeNavigation || identity(m) === MWNativeNavigation.threadKey(info, resolution))) {
        if (duration >= 800) state.enhancedUntil = now() + 10000;
        schedule(m);
      }
    },
    enabled: () => enabled,
    diagnostics: () => ({models: [...models].map(([m, state]) => ({symbol: m.mainSeries().symbol(),
      resolution: m.interval(), state: {...state, ...retries.get(threads.get(identity(m)))}, geometry: (() => {const g = geometry(m);
        return g && {screen:g.screen, reserve:g.reserve,
          firstTime:g.ts.points().valueAt(g.points.firstIndex), requesting:g.ts._requestingMoreData};})()})),
      threads: [...threads].map(([k,t]) => ({key:k, cache:t._cache.bars.length,
        requesting:t._requesting, endOfData:t._endOfData})), flights:flights.size}),
  };
})();
globalThis.MWNativeReserve = MWNativeReserve;
