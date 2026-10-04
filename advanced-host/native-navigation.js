/* Continuous native history: navigation intent, source lifetime and semantic
 * cursor lifetime are independent. No window anchor or synthetic identity. */
const MWNativeNavigation = (() => {
  const models = new Map(),
    threads = new Map(),
    reservations = new Map();
  let limits = {
    max_bars: 20000,
    workspace_bars: 80000,
    response_bytes: 33554432,
  };
  let invokingRange;
  const cancelled = () =>
    Object.assign(Error("已取消旧图表的历史加载"), {
      code: "HISTORY_CANCELLED",
    });
  const key = (symbol, resolution) => `${symbol}|${resolution}|`;
  const screen = (m) =>
    Math.ceil(m.timeScale().width() / m.timeScale().barSpacing());
  function modelKey(m) {
    return key(m.mainSeries().symbol(), m.interval());
  }
  function peers(thread) {
    return [...models].filter(([m]) => modelKey(m) === thread.mw_key);
  }
  function weight(thread) {
    const viewers = peers(thread);
    // Native time points/studies are per pane even with a shared provider cache.
    return Math.max(
      1,
      viewers.reduce(
        (sum, [m, s]) => sum + 1 + 0.5 *
          ((m.allStudies?.(false).length || 0) + (s.pendingStudies?.size || 0)),
        0,
      ),
    );
  }
  function admit(thread, amount) {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw Error("无效历史预算");
    const own = (thread._cache?.bars.length || 0) + amount;
    const total = [...threads.values()].reduce(
      (sum, t) =>
        sum +
        ((t._cache?.bars.length || 0) +
          (t === thread ? amount : reservations.get(t) || 0)) *
          weight(t),
      0,
    );
    if (own > limits.max_bars || total > limits.workspace_bars)
      throw Object.assign(
        Error("历史数据超过当前工作区预算，请提高周期或减小跨度"),
        { code: "NATIVE_HISTORY_CAPACITY_EXCEEDED" },
      );
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
    state.generation++;
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
    },
    configure() {},
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
      thread._datafeed = Object.create(original);
      thread._datafeed.getBars = (
        info,
        resolution,
        request,
        success,
        failure,
      ) => {
        const cache = thread._cache,
          sourceGeneration = thread.mw_sourceGeneration;
        let settled = false;
        const valid = () =>
          !settled &&
          !thread._destroyed &&
          thread._cache === cache &&
          thread.mw_sourceGeneration === sourceGeneration;
        const complete = (callback, ...args) => {
          if (!valid()) return;
          settled = true;
          reservations.delete(thread);
          thread.mw_read = null;
          callback(...args);
        };
        const fail = (error) => {
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
            if (!valid()) return;
            try {
              // Exact union check immediately before synchronous native handling.
              const resident = new Set(
                cache.bars.map((bar) => thread._dealignTime(bar.time)),
              );
              const extra = bars.reduce(
                (n, bar) => n + !resident.has(bar.time),
                0,
              );
              admit(thread, extra);
              complete(success, bars, meta);
            } catch (error) {
              fail(error);
            }
          },
          fail,
        );
      };
      const purge = thread._purgeCache;
      thread._purgeCache = function () {
        this.mw_read?.cancel();
        this.mw_sourceGeneration++;
        this._requesting = false;
        return purge.call(this);
      };
    },
    unbindThread(thread) {
      thread.mw_read?.cancel();
      reservations.delete(thread);
      if (threads.get(thread.mw_key) === thread) threads.delete(thread.mw_key);
    },
    admitCached(thread, bars) {
      const resident = new Set(
        thread._cache.bars.map((bar) => thread._dealignTime(bar.time)),
      );
      admit(
        thread,
        bars.reduce((n, b) => n + !resident.has(b.time), 0),
      );
    },
    crosshairEnabled(value) {
      if (!value)
        for (const state of models.values()) {
          state.cursor = null;
          state.cursorVersion++;
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
        state.external = m.setExternalPosition;
        m.setExternalPosition = function (point, environment) {
          state.cursorVersion++;
          state.cursor = point ? { point: { ...point }, environment } : null;
          return state.external.call(this, point, environment);
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
          state.publicRange?.reject(cancelled());
          state.publicRange = null;
          state.generation++;
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
            if (
              (method === "gotoTime" && args[0] === undefined) ||
              (method === "gotoTimeRange" && args[2])
            )
              return original.apply(this, args);
            if (state.depth) return original.apply(this, args);
            begin(this, state);
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
      state.publicRange?.reject(cancelled());
      clearNativeWait(m, cancelled());
      models.delete(m);
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
      globalThis.dispatchEvent(
        new CustomEvent("mw-navigation-error", { detail: error }),
      );
      return true;
    },
    cancelAll() {
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
