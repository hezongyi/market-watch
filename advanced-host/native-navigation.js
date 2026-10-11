/* Continuous native history: navigation intent, source lifetime and semantic
 * cursor lifetime are independent. No window anchor or synthetic identity. */
const MWNativeNavigation = (() => {
  const models = new Map(),
    threads = new Map(),
    reservations = new Map(),
    boundaries = new Map();
  let limits = {
    max_bars: 20000,
    workspace_bars: 80000,
    response_bytes: 33554432,
  };
  let invokingRange, cursorSource;
  let boundarySequence = 0;
  let calculationPrefix = () => 0;
  const cancelled = () =>
    Object.assign(Error("已取消旧图表的历史加载"), {
      code: "HISTORY_CANCELLED",
    });
  const canonicalSymbol = symbol => {
    if (typeof MWSeries === "undefined") return symbol;
    const identity = MWSeries.decode(symbol);
    return identity.spec ? symbol : MWSeries.encode(identity.symbol, identity.series_kind);
  };
  const key = (symbol, resolution) => `${canonicalSymbol(symbol)}|${resolution}|`;
  const screen = (m) =>
    Math.ceil(m.timeScale().width() / m.timeScale().barSpacing());
  function modelKey(m) {
    return key(m.mainSeries().symbol(), m.interval());
  }
  function peers(thread) {
    return [...models].filter(([m]) => modelKey(m) === thread.mw_key);
  }
  function weight(thread, projection) {
    const viewers = peers(thread);
    // Native time points/studies are per pane even with a shared provider cache.
    return Math.max(
      1,
      viewers.reduce(
        (sum, [m, s]) => sum + 1 + 0.5 *
          ((projection?.has(m) ? projection.get(m) : m.allStudies?.(false).length || 0) + (s.pendingStudies?.size || 0)),
        0,
      ),
    );
  }
  function admit(thread, amount, projection, retained = false) {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw Error("无效历史预算");
    // Lowering capacity preserves already loaded data and cached navigation.
    if (amount === 0 && retained) return;
    const own = (thread._cache?.bars.length || 0) + amount;
    const total = [...threads.values()].reduce(
      (sum, t) =>
        sum +
        ((t._cache?.bars.length || 0) +
          (t === thread ? amount : reservations.get(t) || 0)) *
          weight(t, projection),
      0,
    );
    if (projection && amount === 0 && [...projection].every(([m, count]) =>
      count <= (m.allStudies?.(false).length || 0))) return;
    const sourceExceeded = own > limits.max_bars;
    if (sourceExceeded || total > limits.workspace_bars) {
      const resolution = thread._resolution || thread.mw_key.split("|")[1];
      const period = ({"1":"M1","5":"M5","15":"M15","30":"M30","60":"H1","240":"H4","1D":"D1","1W":"W1","1M":"MN"})[resolution] || resolution;
      const projected = sourceExceeded ? own : total;
      const limit = sourceExceeded ? limits.max_bars : limits.workspace_bars;
      throw Object.assign(
        Error(`${sourceExceeded ? period + " 历史数据" : "工作区图表及指标合计（加权）"}超过容量：预计 ${projected.toLocaleString("en-US")} 根，上限 ${limit.toLocaleString("en-US")} 根。当前图表已保留，可在汉堡菜单 → 历史数据容量中调整，或提高周期、选择更近日期`),
        { code: "NATIVE_HISTORY_CAPACITY_EXCEEDED", budget_scope: sourceExceeded ? "source" : "workspace", projected_bars: projected, max_bars: limit },
      );
    }
  }
  function replay(m, state) {
    const generation = state.generation,
      cursorVersion = state.cursorVersion;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (
          models.get(m) !== state ||
          state.generation !== generation ||
          state.cursorVersion !== cursorVersion ||
          !state.cursor ||
          state.phase === "loading" ||
          m.crosshairSource().isOnHoveredChartWidget()
        )
          return;
        state.external.call(m, state.cursor.point, state.cursor.environment);
        state.lastReplay = {
          time: state.cursor.point.timeStamp,
          appliedTime: m.timeScale().points().valueAt(m.crosshairSource().appliedIndex()),
          at: performance.now(),
        };
      }),
    );
  }
  function clearSourceCursors(source) {
    for (const [m, state] of models) {
      if (state.cursor?.source !== source) continue;
      const environment = state.cursor.environment;
      state.cursor = null;
      state.cursorVersion++;
      if (state.external && !m.crosshairSource().isOnHoveredChartWidget())
        state.external.call(m, null, environment);
    }
  }
  function clearNativeWait(m, error) {
    const scrolling = m._scrollingState;
    m._scrollingState = null;
    scrolling?.deferred.reject(error);
    const range = m._lastGotoTimeRange;
    m._lastGotoTimeRange = null;
    range?.deferred.reject(error);
    if (m._lastAppliedGotoTimeRange) m._lastAppliedGotoTimeRange.actual = false;
    m._lastAppliedGotoTimeRange = null;
    m.timeScale()._requestingMoreData = false;
  }
  function begin(m, state) {
    state.boundaryAt = undefined;
    state.generation++;
    // A boundary is source-shared, but each captured pane owns its own intent.
    // The new generation detaches this pane; keep filling for any live peer.
    releaseBoundaryConsumer(m);
    const sourceThread = threads.get(modelKey(m));
    if (sourceThread && !boundaries.has(sourceThread)) capacityState(sourceThread,{phase:"clear"});
    state.publicRange?.reject(cancelled());
    state.publicRange = null;
    clearNativeWait(m, cancelled());
    const thread = threads.get(modelKey(m));
    // A peer still loading owns the same native read. Changing one pane's
    // intent must not cancel the shared provider consumer needed by that pane.
    if (
      thread?.mw_read &&
      !peers(thread).some(([other, s]) => other !== m && s.phase === "loading")
    )
      thread.mw_read.cancel();
    state.phase = "loading";
  }
  function remaining(thread) {
    const resident = thread._cache?.bars.length || 0;
    const used = [...threads.values()].reduce((sum, t) => sum +
      ((t._cache?.bars.length || 0) + (reservations.get(t) || 0)) * weight(t), 0);
    return Math.max(0, Math.min(limits.max_bars - resident,
      Math.floor((limits.workspace_bars - used) / weight(thread))));
  }
  function capacityState(thread, value) {
    globalThis.dispatchEvent(new CustomEvent("mw-capacity-state", {detail: {
      key: thread.mw_key, symbol:thread._symbolInfo.ticker,
      resolution:thread._resolution, ...value,
    }}));
  }
  function cancelBoundary(thread) {
    const boundary = boundaries.get(thread);
    if (!boundary) return;
    boundaries.delete(thread);
    reservations.delete(thread);
    thread._requesting = false;
    boundary.reject?.(cancelled());
    for (const finish of boundary.waiters.values()) finish(cancelled());
    for (const {m,state,generation} of boundary.captured)
      if (models.get(m) === state && state.generation === generation) state.phase = "idle";
    capacityState(thread, {id:boundary.id, phase:"clear"});
  }
  function releaseBoundaryConsumer(m) {
    for (const [thread, boundary] of boundaries) {
      if (!boundary.captured.some(item => item.m === m)) continue;
      // A superseded pane cannot leave a promotion waiter blocking its peer.
      boundary.waiters.get(m)?.();
      if (!boundary.captured.some(({m:peer,state,generation}) =>
        models.get(peer) === state && state.generation === generation && modelKey(peer) === thread.mw_key))
        cancelBoundary(thread);
    }
  }
  async function fillBoundary(thread, error, captured, continuation) {
    if (boundaries.has(thread)) return;
    const cache = thread._cache, sourceGeneration = thread.mw_sourceGeneration, id = ++boundarySequence;
    const boundary = {id,captured,waiters:new Map(),deadline:Date.now() + (limits.task_seconds || 600) * 1000};
    boundaries.set(thread, boundary);
    const current = () => !thread._destroyed && threads.get(thread.mw_key) === thread &&
      thread._cache === cache && thread.mw_sourceGeneration === sourceGeneration && boundaries.get(thread) === boundary &&
      captured.some(({m,state,generation}) => models.get(m) === state &&
        state.generation === generation && modelKey(m) === thread.mw_key);
    const requested = captured.find(item => Number.isFinite(item.requested))?.requested;
    const started = continuation?.started ?? Date.now(), totalBars = continuation?.totalBars ?? remaining(thread);
    const pageBars = thread._symbolInfo.mw_historyPageBars === 1000 ? 1000 : 4000;
    let loadedBars = continuation?.loadedBars || 0, pages = continuation?.pages || 0,
      batch = continuation?.batch || 0, completedBatch = batch;
    const report = () => {
      boundary.progress = {started,totalBars,loadedBars,pages,batch};
      capacityState(thread, {id,phase:"filling",requested,
      started,totalBars,loadedBars,pages,batch,completedBatch,
      estimatedPages:Math.max(Math.ceil(totalBars / pageBars),pages + (remaining(thread) > 0 ? 1 : 0)),
      scope:error.budget_scope,limit:error.max_bars || limits.max_bars,
      resident:cache.bars.length,message:"已超过容量，正在加载可到达的最早位置"});
    };
    report();
    let failed;
    try {
      thread._requesting = true;
      for (const {m,state,generation} of captured)
        if (models.get(m) === state && state.generation === generation) {
          state.phase = "loading";
          if (state.cursor) state.external.call(m,null,state.cursor.environment);
          state.cursor = null; state.cursorVersion++;
        }
      // Separate bounded fill: never a partial success of the rejected read.
      // Only extend the existing native cache; do not reset the model.
      while (current() && !thread._endOfData) {
        if (Date.now() >= boundary.deadline) throw Error("边界历史加载超过时间预算，请重试");
        const room = remaining(thread);
        if (!room) break;
        const before = thread._dealignTime(cache.bars[0]?.time);
        if (!Number.isFinite(before)) break;
        const amount = Math.min(room,20000,Math.max(1,Math.floor(limits.response_bytes / 1024) || 20000));
        batch++;
        report();
        reservations.set(thread, amount);
        const result = await new Promise((resolve, reject) => {
          boundary.reject = reject;
          thread.mw_originalFeed.getBars({...thread._symbolInfo,mw_current:current},thread._resolution,
            {from:before / 1000 - 1,to:before / 1000,countBack:amount,firstDataRequest:false,
              mw_boundaryId:id,mw_boundaryBatch:batch},
            (bars,meta) => resolve({bars,meta}),reject);
        });
        boundary.reject = undefined;
        if (!current()) throw cancelled();
        reservations.delete(thread);
        const rows = result.bars.filter(bar => bar.time < before).slice(-amount);
        pages += Number.isSafeInteger(result.meta?.mw_historyPages) ? result.meta.mw_historyPages : 0;
        if (!rows.length) {
          if (result.meta?.noData === true) { thread._setEndOfData?.(); break; }
          throw Error("平台未返回更早数据，剩余容量尚未补齐，请重试");
        }
        admit(thread, rows.length);
        thread._processBars(rows,{...result.meta,noData:result.meta?.noData === true && rows.length === result.bars.length});
        loadedBars += rows.length;
        completedBatch = batch;
        // Completed pages now belong to the operation, not the live batch.
        report();
        if (cache.bars[0]?.time >= before) throw Error("边界历史加载没有推进，请重试");
      }
    } catch (failure) { failed = failure; }
    finally {
      if (boundaries.get(thread) === boundary) {
        reservations.delete(thread);
        thread._requesting = false;
      }
    }
    if (!current()) { if (boundaries.get(thread) === boundary) cancelBoundary(thread); return; }
    try {
      // Promote through native series delivery, preserving indicator warmup.
      boundary.promoting = true;
      while (current()) {
        if (Date.now() >= boundary.deadline) throw Error("图表边界定位超过时间预算，请重试");
        const waiting = [], before = new Map();
        for (const {m,state,generation} of captured) {
          if (models.get(m) !== state || state.generation !== generation) continue;
          const ts = m.timeScale(), points = ts.points().range().value();
          const first = points && ts.points().valueAt(points.firstIndex);
          const hidden = cache.bars.filter(bar => bar.time < first * 1000).length;
          const prefix = calculationPrefix(thread._symbolInfo.ticker,thread._resolution) + 4;
          if (hidden > prefix) {
            before.set(m, first);
            waiting.push(new Promise((resolve,reject) => {
              const owner = {}, event = m.mainSeries().dataEvents().completed();
              const finish = error => {clearTimeout(timer);event.unsubscribeAll(owner);error ? reject(error) : resolve();};
              const timer = setTimeout(() => finish(Error("图表边界定位超时")),30000);
              boundary.waiters.set(m, finish);
              event.subscribe(owner,() => finish());
              ts.requestMoreHistoryPoints(hidden - prefix);
            }));
          }
        }
        if (!current()) throw cancelled();
        // Cache insertion ran with _requesting set. Resume queued native
        // subscribers after every pane has installed its completion waiter.
        thread._processPendingSubscribers?.();
        if (!waiting.length) break;
        await Promise.all(waiting);
        if (!current()) throw cancelled();
        if (boundary.failed) break;
        // A queued older wave can finish before the requested promotion wave.
        // Continue until the real cache prefix is delivered, with no-progress
        // protection instead of claiming an intermediate point is the limit.
        const stalled = captured.some(({m,state,generation}) => {
          if (!before.has(m) || models.get(m) !== state || state.generation !== generation) return false;
          const ts = m.timeScale(), points = ts.points().range().value();
          return !points || ts.points().valueAt(points.firstIndex) >= before.get(m);
        });
        if (stalled) {
          boundary.failed = Error("原生图表历史交付没有推进，请重试");
          break;
        }
      }
      if (!current()) throw cancelled();
      failed ||= boundary.failed;
      for (const {m,state,generation,requested:target} of captured) {
        if (models.get(m) !== state || state.generation !== generation) continue;
        const ts = m.timeScale(), points = ts.points().range().value();
        if (!points) continue;
        const actual = ts.points().valueAt(points.firstIndex);
        // Left-align real first point; centering would request older data again.
        ts.setRightOffset(points.firstIndex + screen(m) - 1 - ts.baseIndex());
        state.boundaryAt = actual;
        state.boundaryLimited = remaining(thread) === 0;
        if (state.cursor) state.external.call(m,null,state.cursor.environment);
        state.cursor = null; state.cursorVersion++; state.phase = "idle";
        m.fullUpdate?.();
        const scope = cache.bars.length >= limits.max_bars ? "source" :
          remaining(thread) === 0 ? "workspace" : error.budget_scope;
        capacityState(thread,{id,phase:"limited",requested:target,actual,
          started,finished:Date.now(),totalBars,loadedBars,pages,batch,
          scope,limit:scope === "workspace" ? limits.workspace_bars : limits.max_bars,resident:cache.bars.length,
          message:failed ? `已定位到现有数据边界；补齐剩余容量未完成：${String(failed)}` : "已定位到当前容量可到达的最早位置"});
      }
    } catch (failure) {
      if (failure.code !== "HISTORY_CANCELLED") capacityState(thread,{id,phase:"failed",requested,
        started,finished:Date.now(),totalBars,loadedBars,pages,batch,
        message:`容量边界定位未完成：${String(failure)}`});
    } finally {
      for (const finish of boundary.waiters.values()) finish();
      for (const {m,state,generation} of captured)
        if (models.get(m) === state && state.generation === generation) state.phase = "idle";
      if (boundaries.get(thread) === boundary) boundaries.delete(thread);
    }
  }
  return {
    setCapabilities(value) {
      if (
        value?.protocol !== 1 ||
        value.mode !== "continuous" ||
        !Number.isSafeInteger(value.max_bars) ||
        !Number.isSafeInteger(value.workspace_bars)
      )
        throw Error("历史能力配置不匹配，请刷新工作区");
      limits = { ...value };
      for (const state of models.values()) state.boundaryAt = undefined;
    },
    configure(prefix = () => 0) { calculationPrefix = prefix; },
    filling: (thread) => boundaries.has(thread),
    enabled: () => true,
    modelKey,
    threadKey: (info, resolution) => key(info.ticker || info.name, resolution),
    // Compatibility with verified v31.1 adapter hooks; all use native identity.
    decorate: (_m, symbol) => symbol,
    windowInfo: (info) => info,
    prepareNavigation: () => false,
    prepareRange(m, _range, resume) {
      const state = models.get(m);
      if (!state || state.publicRangeDepth || !m.mainSeries().symbol().startsWith("MWP:"))
        return null;
      // The public API reaches the engine before gotoTimeRange. Cancel and
      // finish its old native consumer before the engine dereferences it.
      begin(m, state);
      state.requested = _range.from;
      const generation = state.generation;
      const token = {};
      const cancellation = new Promise((_, reject) => { token.reject = reject; });
      state.publicRange = token;
      state.publicRangeDepth = 1;
      state.depth++;
      let result;
      const previousRange = invokingRange;
      invokingRange = { m, state, generation };
      try { result = resume(); }
      catch (error) { result = Promise.reject(error); }
      finally { invokingRange = previousRange; state.publicRangeDepth = 0; state.depth--; }
      return Promise.race([Promise.resolve(result), cancellation]).finally(() => {
        if (state.publicRange === token) state.publicRange = null;
        if (models.get(m) === state && state.generation === generation) {
          state.phase = "idle";
          replay(m, state);
        }
      });
    },
    engineRangeCurrent() {
      const range = invokingRange;
      return !range ? () => true : () =>
        models.get(range.m) === range.state && range.state.generation === range.generation;
    },
    acceptedRange(chart) {
      const thread = threads.get(modelKey(chart._chartWidget.model().model()));
      return thread?._cache.bars.length ? {
        from: thread._dealignTime(thread._cache.bars[0].time),
        to: thread._dealignTime(thread._cache.bars.at(-1).time),
      } : undefined;
    },
    rangeBoundary(chart) {
      const m = chart._chartWidget.model().model(), state = models.get(m);
      const thread = threads.get(modelKey(m));
      return state?.phase === "idle" && state.boundaryLimited && thread && remaining(thread) === 0
        ? state.boundaryAt : undefined;
    },
    chartWindow: () => undefined,
    hasWindow: (id) => !id,
    historical: () => false,
    coverage: () => undefined,
    takeSeed: () => undefined,
    collectThreads() {},
    anchorThread(thread) {
      thread.mw_requestCursor = {
        left: thread._leftDate,
        next: thread._nextTime,
      };
    },
    timeScaleUpdated(m) {
      const state = models.get(m);
      if (!state) return;
      // Older append shifts indices immediately. Correct the semantic cursor
      // in that same turn; waiting for animation frames exposes stale indices.
      if (state.cursor && state.phase === "idle" &&
          !m.crosshairSource().isOnHoveredChartWidget())
        state.external.call(m, state.cursor.point, state.cursor.environment);
      replay(m, state);
    },
    bindThread(thread, resolution) {
      if (!thread._symbolInfo.ticker?.startsWith("MWP:")) return;
      thread.mw_key = this.threadKey(thread._symbolInfo, resolution);
      threads.set(thread.mw_key, thread);
      thread.mw_sourceGeneration = 0;
      const original = thread._datafeed;
      thread.mw_originalFeed = original;
      thread._datafeed = Object.create(original);
      thread._datafeed.getBars = (
        info,
        resolution,
        request,
        success,
        failure,
      ) => {
        // Native reads supersede HTTP fill, but promotion reads belong to the
        // existing boundary and must retain its per-pane completion waiters.
        const boundary = boundaries.get(thread);
        // Native promotion can ask for extra warmup after the bounded fill.
        // Its rejected read continues the same operation's accounting only;
        // actual new navigation still invalidates the model generation.
        const continuation = boundary?.promoting ? {...boundary.progress,
          captured:boundary.captured} : undefined;
        if (boundary && !boundary.promoting) cancelBoundary(thread);
        const cache = thread._cache,
          sourceGeneration = thread.mw_sourceGeneration;
        let settled = false;
        const valid = () =>
          !settled &&
          !thread._destroyed &&
          thread._cache === cache &&
          thread.mw_sourceGeneration === sourceGeneration;
        const complete = (callback, ...args) => {
          if (!valid()) return false;
          settled = true;
          reservations.delete(thread);
          thread.mw_read = null;
          callback(...args);
          return true;
        };
        const fail = (error) => {
          if (!valid()) return;
          thread.mw_boundaryContinuation = error?.code === "NATIVE_HISTORY_CAPACITY_EXCEEDED" ? continuation : undefined;
          if (boundary?.promoting && boundaries.get(thread) === boundary) {
            if (error?.code === "NATIVE_HISTORY_CAPACITY_EXCEEDED" || error?.code === "HISTORY_CANCELLED")
              cancelBoundary(thread);
            else boundary.failed = error;
          }
          if(error?.code === "NATIVE_HISTORY_CAPACITY_EXCEEDED") thread.mw_capacityRequest = request;
          thread.mw_failedCursor = thread.mw_requestCursor;
          complete(failure, error);
        };
        thread.mw_read = { cancel: () => fail(cancelled()), valid };
        try {
          admit(thread, request.countBack);
          reservations.set(thread, request.countBack);
        } catch (error) {
          queueMicrotask(() => fail(error));
          return;
        }
        return original.getBars(
          { ...info, mw_current: valid },
          resolution,
          request,
          (bars, meta) => {
            if (!valid()) return false;
            try {
              // Exact union check immediately before synchronous native handling.
              const resident = new Set(
                cache.bars.map((bar) => thread._dealignTime(bar.time)),
              );
              const extra = bars.reduce(
                (n, bar) => n + !resident.has(bar.time),
                0,
              );
              admit(thread, extra, undefined, true);
              return complete(success, bars, meta);
            } catch (error) {
              fail(error);
              return false;
            }
          },
          fail,
        );
      };
      const purge = thread._purgeCache;
      thread._purgeCache = function () {
        cancelBoundary(this);
        if (threads.get(this.mw_key) === this) capacityState(this, {phase:"clear"});
        this.mw_read?.cancel();
        this.mw_sourceGeneration++;
        this._requesting = false;
        const result = purge.call(this);
        globalThis.MWBarRangeMapping?.cachePurged();
        return result;
      };
    },
    unbindThread(thread) {
      cancelBoundary(thread);
      thread.mw_read?.cancel();
      reservations.delete(thread);
      if (threads.get(thread.mw_key) === thread) {
        capacityState(thread, {phase:"clear"});
        threads.delete(thread.mw_key);
      }
    },
    admitCached(thread, bars) {
      const resident = new Set(
        thread._cache.bars.map((bar) => thread._dealignTime(bar.time)),
      );
      admit(
        thread,
        bars.reduce((n, b) => n + !resident.has(b.time), 0),
        undefined, true,
      );
    },
    crosshairEnabled(value) {
      if (!value)
        for (const state of models.values()) {
          state.cursor = null;
          state.cursorVersion++;
        }
    },
    admitCheckpoint(stack, checkpoint) {
      const projection = new Map();
      for (const command of [...stack._commands].reverse()) {
        if (command === checkpoint.lastActualCommand) break;
        this.admitHistory(command, 'undo', projection);
      }
    },
    admitHistory(command, direction, projection = new Map()) {
      // Native undo removes commands before execution. Preflight every template
      // in a macro before any command changes panes or leaves the history stack.
      const children = command?.commands?.();
      if (children) {
        const ordered = direction === 'undo' ? [...children].reverse() : children;
        for (const child of ordered) this.admitHistory(child, direction, projection);
      } else if (command?._templateContent && command?._initialState && command?._model) {
        this.admitTemplate(command._model, direction === 'undo'
          ? command._initialState : command._templateContent, projection);
      }
    },
    admitTemplate(model, template, projection = new Map()) {
      const thread = threads.get(modelKey(model));
      if (!thread) return;
      // Templates restore pane sources directly, bypassing study insertion.
      // Check the whole replacement before native undo/history mutates panes.
      const restored = (template.panes || []).reduce((count, pane) => count +
        (pane.sources || []).filter(source => typeof source.type === 'string' &&
          source.type.toLowerCase().startsWith('study')).length, 0);
      const retained = (model.allStudies?.(false) || []).filter(study =>
        study.isRemovedByStudyTemplates?.() === false).length;
      projection.set(model, restored + retained);
      try { admit(thread, reservations.get(thread) || 0, projection); }
      catch (error) {
        globalThis.dispatchEvent(new CustomEvent('mw-navigation-error', {detail:error}));
        throw error;
      }
    },
    bindModel(m) {
      if (models.has(m)) return;
      const state = {
        generation: 0,
        cursorVersion: 0,
        phase: "idle",
        depth: 0,
        pendingStudies: new Set(),
      };
      models.set(m, state);
      requestAnimationFrame(() => {
        if (models.get(m) !== state) return;
        state.identity = modelKey(m);
        state.external = m.setExternalPosition;
        m.setExternalPosition = function (point, environment) {
          if (point && Number.isFinite(state.boundaryAt) && point.timeStamp < state.boundaryAt) {
            state.cursor = null; state.cursorVersion++;
            return state.external.call(this,null,environment);
          }
          state.cursorVersion++;
          state.cursor = point ? { point: { ...point }, environment, source: cursorSource } : null;
          return state.external.call(this, point, environment);
        };
        const broadcastCursor = m._syncCrosshair;
        if (broadcastCursor) m._syncCrosshair = function (...args) {
          const previous = cursorSource;
          cursorSource = this;
          try { return broadcastCursor.apply(this, args); }
          finally { cursorSource = previous; }
        };
        const insertStudy = m.insertStudyWithParams;
        m.insertStudyWithParams = function (...args) {
          const token = {};
          state.pendingStudies.add(token);
          const release = () => state.pendingStudies.delete(token);
          try {
            const thread = threads.get(modelKey(this));
            if (thread) admit(thread, reservations.get(thread) || 0);
            const result = insertStudy.apply(this, args);
            // v31.1 returns a handle before the asynchronous study is attached.
            result.study.then(release, release);
            const cancel = result.cancel;
            result.cancel = function (...values) {
              try { return cancel.apply(this, values); }
              finally { release(); }
            };
            return result;
          } catch (error) {
            release();
            globalThis.dispatchEvent(new CustomEvent("mw-navigation-error", { detail: error }));
            throw error;
          }
        };
        const projected = () => {
          if (state.phase === "idle") replay(m, state);
        };
        m.timeScale()
          .visibleBarsStrictRangeChanged()
          .subscribe(state, projected);
        m.mainSeries().dataEvents().completed().subscribe(state, projected);
        m.mainSeries().dataEvents().dataUpdated().subscribe(state, projected);
        const changed = () => {
          const previousThread = threads.get(state.identity);
          state.boundaryAt = undefined;
          state.requested = undefined;
          const identity = modelKey(m);
          if (identity !== state.identity) clearSourceCursors(m);
          state.identity = identity;
          if (previousThread && !peers(previousThread).length)
            capacityState(previousThread, {phase:"clear"});
          state.publicRange?.reject(cancelled());
          state.publicRange = null;
          state.generation++;
          releaseBoundaryConsumer(m);
          state.cursorVersion++;
          state.cursor = null;
          state.phase = "idle";
          clearNativeWait(m, cancelled());
          for (const thread of threads.values())
            if (thread.mw_read && !peers(thread).length)
              thread.mw_read.cancel();
        };
        m.mainSeries().onIntervalChanged().subscribe(state, changed);
        m.mainSeries().symbolResolved().subscribe(state, changed);
        for (const method of [
          "syncTimeWithModel",
          "gotoTime",
          "gotoTimeRange",
          "resetTimeScale",
        ]) {
          const original = m[method];
          m[method] = function (...args) {
            // Native range continuation belongs to its original deferred. Once
            // superseded it cannot restore the old target when data arrives.
            if (
              method === "gotoTimeRange" &&
              args[2] &&
              args[2] !== this._lastGotoTimeRange
            )
              return;
            if (method === "gotoTimeRange" && args[2]) {
              const marks = this.timeScale().tickMarks();
              const indices = marks._marksByIndex;
              // A completed callback can precede the replacement time scale.
              // The pinned engine removes duplicate-time labels before it
              // replaces their old index bounds. Do not read that mixed scale.
              if (indices?.size && (!indices.has(marks.minIndex) || !indices.has(marks.maxIndex) ||
                  indices.size !== marks.maxIndex - marks.minIndex + 1)) {
                const deferred = args[2];
                const retry = state.rangeRetry?.deferred === deferred ? state.rangeRetry :
                  (state.rangeRetry = {deferred, started: performance.now(), scheduled: false});
                if (performance.now() - retry.started >= 30000) {
                  state.rangeRetry = null;
                  const error = Error("图表时间刻度尚未完成更新，请重试范围定位");
                  clearNativeWait(this, error);
                  state.phase = "idle";
                  globalThis.dispatchEvent(new CustomEvent("mw-navigation-error", {detail:error}));
                  return;
                }
                if (!retry.scheduled) {
                  retry.scheduled = true;
                  requestAnimationFrame(() => {
                    if (state.rangeRetry !== retry) return;
                    retry.scheduled = false;
                    if (models.get(this) !== state || this._lastGotoTimeRange !== deferred) {
                      state.rangeRetry = null;
                      return;
                    }
                    this.gotoTimeRange(...args);
                  });
                }
                return;
              }
              state.rangeRetry = null;
            }
            if (
              (method === "gotoTime" && args[0] === undefined) ||
              (method === "gotoTimeRange" && args[2])
            )
              return original.apply(this, args);
            if (state.depth) return original.apply(this, args);
            begin(this, state);
            state.requested = method === "syncTimeWithModel" ? args[1] / 1000 :
              method === "gotoTime" || method === "gotoTimeRange" ? args[0] / 1000 : undefined;
            const generation = state.generation;
            state.depth++;
            let result;
            try {
              result = original.apply(this, args);
            } catch (error) {
              state.depth--;
              state.phase = "idle";
              throw error;
            }
            state.depth--;
            return Promise.resolve(result).finally(() => {
              if (
                models.get(this) === state &&
                state.generation === generation
              ) {
                state.phase = "idle";
                replay(this, state);
              }
            });
          };
        }
      });
    },
    unbindModel(m) {
      const state = models.get(m);
      if (!state) return;
      clearSourceCursors(m);
      state.publicRange?.reject(cancelled());
      clearNativeWait(m, cancelled());
      models.delete(m);
      const sourceThread = threads.get(state.identity);
      if (sourceThread && !peers(sourceThread).length)
        capacityState(sourceThread, {phase:"clear"});
      releaseBoundaryConsumer(m);
      m.timeScale().visibleBarsStrictRangeChanged().unsubscribeAll(state);
      m.mainSeries().onIntervalChanged().unsubscribeAll(state);
      m.mainSeries().symbolResolved().unsubscribeAll(state);
      m.mainSeries().dataEvents().completed().unsubscribeAll(state);
      m.mainSeries().dataEvents().dataUpdated().unsubscribeAll(state);
      for (const thread of threads.values())
        if (thread.mw_read && !peers(thread).length) thread.mw_read.cancel();
    },
    historyFailure(thread, error) {
      if (
        !thread._symbolInfo.ticker?.startsWith("MWP:") &&
        !thread._symbolInfo.mw_window
      )
        return false;
      if (error?.status === 404 || error?.code === "INVALID_SYMBOL")
        return false;
      const matches = [...models].filter(
        ([m]) =>
          this.modelKey(m) ===
          this.threadKey(thread._symbolInfo, thread._resolution),
      );
      const capacityFailure = error?.code === "NATIVE_HISTORY_CAPACITY_EXCEEDED";
      const previous = thread.mw_boundaryContinuation;
      const affected = matches.filter(([m,state]) => state.phase === "loading" ||
        (capacityFailure && previous?.captured.some(old =>
          old.m === m && old.state === state && old.generation === state.generation)) ||
        m._scrollingState || m._lastGotoTimeRange || m.timeScale()._requestingMoreData ||
        m.timeScale().visibleBarsStrictRange()?.firstBar() < m.timeScale().points().range().value()?.firstIndex);
      const captured = affected.map(([m,state]) => ({m,state,generation:state.generation,
        requested:state.requested ?? state.cursor?.point.timeStamp ?? thread.mw_capacityRequest?.from}));
      thread.mw_boundaryContinuation = undefined;
      const continuation = previous && captured.some(item => previous.captured.some(old =>
        old.m === item.m && old.state === item.state && old.generation === item.generation)) ? previous : undefined;
      for (const [m, state] of matches) {
        const ts = m.timeScale();
        ts._requestingMoreData = false;
        const scroll = m._scrollingState;
        m._scrollingState = null;
        scroll?.deferred.reject(error);
        clearNativeWait(m, error);
        state.phase = "idle";
        const points = ts.points().range().value(),
          visible = ts.visibleBarsStrictRange();
        if (points && visible && visible.firstBar() < points.firstIndex)
          ts.setRightOffset(points.firstIndex + screen(m) - ts.baseIndex());
      }
      // End this request without marking history exhausted or the symbol invalid.
      const subscribers = thread._pendingSubscribers;
      thread._pendingSubscribers = [];
      thread._errorMessage = null;
      const failedLeft = thread._leftDate;
      thread._leftDate =
        thread.mw_failedCursor?.left ??
        (thread._cache.bars.length
          ? thread._dealignTime(thread._cache.bars[0].time)
          : null);
      thread._nextTime = thread.mw_failedCursor?.next ?? null;
      for (const subscriber of subscribers) {
        const live = thread._moveSubscriberToRealtime(subscriber);
        // An empty recoverable load is a nonterminal barset, not an invalid
        // symbol. A later realtime update or user history read can refill it.
        const cursor = thread._leftDate;
        if (!thread._cache.bars.length) thread._leftDate = failedLeft;
        try {
          thread._returnHistoryDataToSubscriber(subscriber, live);
        } finally {
          thread._leftDate = cursor;
        }
      }
      thread._subscribeRealtimeIfNeeded();
      const boundary = boundaries.get(thread);
      if (boundary?.promoting && boundary.failed === error)
        for (const finish of boundary.waiters.values()) finish();
      if (capacityFailure && captured.length && thread._cache.bars.length && !boundaries.has(thread)) {
        const cache = thread._cache, sourceGeneration = thread.mw_sourceGeneration;
        setTimeout(() => {
          if (thread._cache === cache && thread.mw_sourceGeneration === sourceGeneration &&
            threads.get(thread.mw_key) === thread && !thread._destroyed &&
            captured.some(({m,state,generation}) => models.get(m) === state && state.generation === generation))
            fillBoundary(thread,error,captured,continuation);
        },0);
      } else if (!capacityFailure || !boundaries.has(thread))
        globalThis.dispatchEvent(new CustomEvent("mw-navigation-error", {detail:error}));
      return true;
    },
    cancelAll() {
      for (const thread of boundaries.keys()) cancelBoundary(thread);
      for (const [m, state] of models) {
        state.publicRange?.reject(cancelled());
        state.publicRange = null;
        state.generation++;
        clearNativeWait(m, cancelled());
        state.phase = "idle";
      }
      for (const thread of threads.values()) thread.mw_read?.cancel();
    },
    interacting(chart) {
      const m = chart._chartWidget.model().model();
      return m.timeScale().isBeingScrolled() || m._isTimeScrolling;
    },
    busy: () => [...models.values()].some((state) => state.phase !== "idle"),
    diagnostics: () => ({
      mode: "continuous",
      cursors: [...models].map(([m, s]) => ({
        res: m.interval(),
        phase: s.phase,
        boundaryAt:s.boundaryAt,
        time: s.cursor?.point.timeStamp,
        mapped:
          s.cursor && m.mainSeries().syncModel()
            ? m
                .createSyncPoint(
                  s.cursor.point.syncSourceTarget,
                  m.mainSeries().syncModel().syncSourceTarget(),
                )
                .sourceTimeToTargetTime(s.cursor.point.timeStamp)
            : null,
        lastReplay: s.lastReplay,
      })),
      windows: [],
      models: models.size,
      threads: threads.size,
      pending: reservations.size,
      resident: [...threads.values()].reduce(
        (n, t) => n + t._cache.bars.length,
        0,
      ),
      limits,
    }),
  };
})();
globalThis.MWNativeNavigation = MWNativeNavigation;
