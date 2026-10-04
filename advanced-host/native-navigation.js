/* Semantic cursor state belongs to the chart, never to a cached bar index. */
const MWNativeNavigation = (() => {
  const models = new Map();
  const windows = new Map();
  const threads = new Map();
  let nextWindow = 0,
    readWindow,
    calculationPrefix = () => 4;
  const enabled =
    globalThis.MW_NATIVE_RESERVE_ENABLED !== false &&
    new URLSearchParams(location.search).get("native_reserve") !== "off";
  function replay(m, state) {
    const generation = state.generation;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (
          models.get(m) !== state ||
          state.generation !== generation ||
          !state.cursor ||
          m.crosshairSource().isOnHoveredChartWidget()
        )
          return;
        state.external.call(m, state.cursor.point, state.cursor.environment);
      }),
    );
  }
  function cancelPending(state) {
    if (!state.pending) return;
    state.finish?.(
      Object.assign(Error("已取消旧图表的历史加载"), {
        code: "HISTORY_CANCELLED",
      }),
    );
    state.pending = null;
    if (state.window?.replacing) {
      state.window.replacing = false;
      state.window.dragPixels = 0;
    }
  }
  function windowFor(m) {
    const window = models.get(m)?.window;
    return window?.symbol === m.mainSeries().symbol() &&
      window.resolution === m.interval()
      ? window
      : undefined;
  }
  function screen(m) {
    const ts = m.timeScale();
    return Math.ceil(ts.width() / ts.barSpacing());
  }
  function desiredWindow(m, target) {
    const series = m.mainSeries(),
      sync = series.syncModel(),
      n = screen(m);
    if (!sync?.isValid() || !(n > 0) || n > 19996)
      throw Error("显示范围过大，请缩小时间范围后重试");
    // projectTime uses the native session bar builder (including D/W/M and DST).
    let right, left, count;
    for (const [older, newer] of [
      [3, 2],
      [2, 1],
      [1, 1],
      [0.5, 0.5],
    ]) {
      right = sync.projectTime(target, Math.ceil(n * newer));
      left = sync.projectTime(target, -Math.ceil(n * older));
      count = Math.max(
        Math.ceil(n * (older + newer)),
        sync.mwRequiredCount(left, right, series.intervalObj().value()),
      );
      if (count + calculationPrefix(series.symbol(), m.interval()) <= 20000)
        break;
    }
    if (count + calculationPrefix(series.symbol(), m.interval()) > 20000)
      throw Error("显示范围过大，请缩小时间范围后重试");
    return {
      id: `mw${++nextWindow}`,
      symbol: series.symbol(),
      resolution: m.interval(),
      target,
      from: left,
      to: right,
      count,
      spacing: m.timeScale().barSpacing(),
    };
  }
  async function rebase(m, state, window) {
    const token = {};
    cancelPending(state);
    state.pending = token;
    const previousWindow = windowFor(m),
      series = m.mainSeries(),
      ts = m.timeScale();
    const thread = threads.get(
      `${series.symbol()}|${m.interval()}|${previousWindow?.id || ""}`,
    );
    const points = ts.points().range().value(),
      visible = ts.visibleBarsStrictRange();
    let rollback;
    if (thread?._cache.bars.length && points && visible) {
      const sync = series.syncModel(),
        bars = thread._cache.bars.map((bar) => ({
          ...bar,
          time: thread._dealignTime(bar.time),
        }));
      rollback = {
        ...previousWindow,
        id: previousWindow?.id || `mw${++nextWindow}`,
        symbol: series.symbol(),
        resolution: m.interval(),
        spacing: ts.barSpacing(),
        from: ts
          .points()
          .roughTime(
            Math.round(visible.firstBar()),
            sync.projectTime.bind(sync),
          ),
        to: sync.projectTime(bars.at(-1).time / 1000, 1),
        count: Math.min(bars.length, screen(m) + 4),
        viewport: {
          from: ts
            .points()
            .roughTime(
              Math.round(visible.firstBar()),
              sync.projectTime.bind(sync),
            ),
          to: ts
            .points()
            .roughTime(
              Math.round(visible.lastBar()),
              sync.projectTime.bind(sync),
            ),
        },
        nativeSeed: bars,
        latest: !previousWindow || previousWindow.latest,
        rollback: true,
        followViewport: false,
        replacing: false,
        dragPixels: 0,
        targetDate: undefined,
      };
    }
    let replaced = false,
      applied = false;
    const current = () =>
      models.get(m) === state &&
      state.pending === token &&
      m.mainSeries().symbol() === window.symbol &&
      m.interval() === window.resolution;
    try {
      // Validate the candidate before replacing the last valid native source.
      if (readWindow && !window.nativeSeed) await readWindow(window, current);
      if (!current()) return false;
      if (window.followViewport) {
        // Pointer movement can continue while the candidate is fetched. Use
        // the last valid viewport at replacement, rather than the fetch start.
        const visible = ts.visibleBarsStrictRange(),
          sync = series.syncModel();
        if (visible && sync?.isValid())
          window.viewport = {
            from: ts
              .points()
              .roughTime(
                Math.round(visible.firstBar()),
                sync.projectTime.bind(sync),
              ),
            to: ts
              .points()
              .roughTime(
                Math.round(visible.lastBar()),
                sync.projectTime.bind(sync),
              ),
          };
        if (rollback) rollback.viewport = { ...window.viewport };
      }
      const old = state.window;
      Object.defineProperty(window, "owner", {
        value: m,
        enumerable: false,
        configurable: true,
      });
      state.window = window;
      windows.set(window.id, window);
      replaced = true;
      if (window.followViewport) window.replacing = true;
      const source = series.seriesSource();
      const completed = new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          series.dataEvents().completed().unsubscribe(token, finish);
          if (state.finish === fail) state.finish = null;
          resolve();
        };
        const fail = (error) => {
          clearTimeout(timer);
          series.dataEvents().completed().unsubscribe(token, finish);
          if (state.finish === fail) state.finish = null;
          reject(error);
        };
        const timer = setTimeout(
          () =>
            fail(
              Object.assign(Error("历史定位超时"), { code: "HISTORY_TIMEOUT" }),
            ),
          30000,
        );
        state.finish = fail;
        series.dataEvents().completed().subscribe(token, finish);
      });
      try {
        source.stop();
        source.setInitialRequestOptions({ count: window.count });
        series.setDefaultTimeframe({
          type: "time-range",
          from: window.from,
          to: window.to,
        });
        series.rerequestData();
      } catch (error) {
        state.finish?.(error);
      }
      await completed;
      if (!current()) return false;
      // Native applies the initial timeframe after its completion event. Restore
      // geometry and center only after that final application, then reproject.
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (!current()) return false;
      m.timeScale().setBarSpacing(window.spacing);
      if (window.targetDate !== undefined) {
        state.applyingNavigation = true;
        let navigation;
        try {
          navigation = m._gotoTimeImpl(window.targetDate, window.options);
        } finally {
          state.applyingNavigation = false;
        }
        await navigation;
        if (!current()) return false;
      }
      if (window.viewport) {
        state.applyingRange = true;
        const range = m.gotoTimeRange(
          window.viewport.from * 1000,
          window.viewport.to * 1000,
        );
        state.applyingRange = false;
        await range;
        if (!current()) return false;
        if (window.followViewport || window.rollback) {
          const scale = m.timeScale(),
            visible = scale.visibleBarsStrictRange();
          const center = (visible.firstBar() + visible.lastBar()) / 2;
          scale.setBarSpacing(window.spacing);
          scale.setRightOffset(
            center +
              scale.width() / window.spacing / 2 -
              scale.baseIndex() -
              0.5,
          );
        }
      }
      if (!current()) return false;
      if (window.followViewport) {
        window.replacing = false;
        const scale = m.timeScale();
        if (state.scrollCoordinate !== undefined && scale.isBeingScrolled()) {
          // Native drag state is index based. Reset its origin to the same
          // pointer coordinate after replacing a source with different indices.
          scale._scrollData = null;
          scale._commonTransitionStartState = null;
          scale.startScroll(state.scrollCoordinate);
          if (window.dragPixels) {
            const coordinate = state.scrollCoordinate;
            m.scrollTimeTo(coordinate - window.dragPixels);
            scale._scrollData = null;
            scale._commonTransitionStartState = null;
            scale.startScroll(coordinate);
            state.scrollCoordinate = coordinate;
          }
        } else if (window.dragPixels)
          scale.setRightOffset(
            scale.rightOffset() + window.dragPixels / window.spacing,
          );
      }
      if (window.latest && !window.rollback && !window.followViewport)
        state.reset.call(m);
      replay(m, state);
      if (old && old.id !== window.id) windows.delete(old.id);
      for (const [id, entry] of windows)
        if (entry.owner === m && id !== window.id) windows.delete(id);
      window.seed = null;
      applied = true;
      return true;
    } catch (error) {
      if (!current()) return false;
      const scroll = m._scrollingState;
      m._scrollingState = null;
      scroll?.deferred.reject(error);
      if (replaced && rollback && !window.rollback) {
        // Leave the failed source's native dispatch before replacing it again.
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        if (!current()) return false;
        windows.delete(window.id);
        // Restore the previous valid bars through a new isolated source. This
        // one-shot seed is discarded after the native callback consumes it.
        await rebase(m, state, rollback);
      }
      globalThis.dispatchEvent(
        new CustomEvent("mw-navigation-error", { detail: error }),
      );
      throw error;
    } finally {
      if (state.pending === token) {
        state.pending = null;
        window.replacing = false;
        if (window.followViewport && applied)
          requestAnimationFrame(() => {
            if (models.get(m) === state)
              MWNativeNavigation.extendNewer(m, state);
          });
      }
    }
  }
  return {
    configure(read, prefix = () => 4) {
      readWindow = read;
      calculationPrefix = prefix;
    },
    crosshairEnabled(value) {
      if (!value)
        for (const state of models.values()) {
          state.cursor = null;
          state.generation++;
        }
    },
    hasWindow(id) {
      return windows.has(id);
    },
    historical(id) {
      return windows.has(id) && !windows.get(id).latest;
    },
    coverage(id) {
      const window = windows.get(id);
      if (!window) return;
      const thread = threads.get(`${window.symbol}|${window.resolution}|${id}`);
      return thread?._cache.bars.length
        ? {
            first: thread._dealignTime(thread._cache.bars[0].time),
            last: thread._dealignTime(thread._cache.bars.at(-1).time),
          }
        : undefined;
    },
    refreshChartWindow(chart) {
      const m = chart._chartWidget.model().model(),
        state = models.get(m),
        old = windowFor(m);
      if (!old || !state) return;
      const range = chart.getVisibleRange();
      const next = desiredWindow(m, (range.from + range.to) / 2);
      next.viewport = { ...range };
      next.followViewport = true;
      next.latest = old.latest;
      return rebase(m, state, next);
    },
    interacting(chart) {
      const model = chart._chartWidget.model().model();
      return model.timeScale().isBeingScrolled() || model._isTimeScrolling;
    },
    chartWindow(chart) {
      return windowFor(chart._chartWidget.model().model());
    },
    takeSeed(info, resolution, request) {
      const window = windows.get(info.mw_window),
        seed = window?.seed;
      if (
        !seed ||
        info.ticker !== window.symbol ||
        resolution !== window.resolution ||
        request.to !== window.to ||
        request.countBack > seed.count
      )
        return;
      window.seed = null;
      return seed.page;
    },
    decorate(m, symbol) {
      const window = windowFor(m);
      if (!window) return symbol;
      const result = structuredClone(symbol);
      let inner = result;
      while (typeof inner.symbol !== "string") inner = inner.symbol;
      if (inner.symbol !== window.symbol || m.interval() !== window.resolution)
        return symbol;
      inner["mw-window"] = window.id;
      return result;
    },
    windowInfo(info, id) {
      return id && windows.has(id) ? { ...info, mw_window: id } : info;
    },
    anchorThread(thread) {
      thread.mw_requestCursor = {
        left: thread._leftDate,
        next: thread._nextTime,
      };
      const window = windows.get(thread._symbolInfo.mw_window);
      if (window && !thread._cache.bars.length && thread._leftDate === null)
        thread._leftDate = window.to * 1000;
    },
    bindThread(thread, resolution) {
      if (
        !enabled ||
        (!thread._symbolInfo.ticker?.startsWith("MWP:") &&
          !thread._symbolInfo.mw_window)
      )
        return;
      const key = this.threadKey(thread._symbolInfo, resolution);
      threads.set(key, thread);
      thread.mw_key = key;
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
          cursor = thread.mw_requestCursor;
        const valid = () => !thread._destroyed && thread._cache === cache;
        const window = windows.get(info.mw_window),
          seed = info.ticker === window?.symbol ? window?.nativeSeed : null;
        if (seed) {
          window.nativeSeed = null;
          setTimeout(() => {
            if (valid())
              success(
                seed.filter((bar) => bar.time < request.to * 1000),
                { noData: false },
              );
          }, 0);
          return;
        }
        return original.getBars(
          info,
          resolution,
          request,
          (bars, meta) => {
            if (valid()) success(bars, meta);
          },
          (error) => {
            if (valid()) {
              thread.mw_failedCursor = cursor;
              failure(error);
            }
          },
        );
      };
      const purge = thread._purgeCache;
      thread._purgeCache = function () {
        this._requesting = false;
        return purge.call(this);
      };
    },
    unbindThread(thread) {
      if (threads.get(thread.mw_key) === thread) threads.delete(thread.mw_key);
    },
    prepareNavigation(m, targetDate, options, toUTC) {
      const state = models.get(m),
        ts = m.timeScale(),
        series = m.mainSeries();
      if (
        !enabled ||
        !state ||
        state.applyingNavigation ||
        !series.symbol().startsWith("MWP:")
      )
        return false;
      const target = (series.isDWM() ? targetDate : toUTC(targetDate)) / 1000;
      const points = ts.points().range().value();
      if (!points) return false;
      const first = ts.points().valueAt(points.firstIndex),
        last = ts.points().valueAt(points.lastIndex);
      if (target >= first && target <= last) {
        cancelPending(state);
        return false;
      }
      // A latest chart already owns the native future margin. Do not create a
      // history window for a click in that margin where no actual bar exists.
      if (target > last && !windowFor(m)) {
        cancelPending(state);
        return false;
      }
      const estimate =
        target < first ? ts.tickMarks().estimateLeft(targetDate) : Infinity;
      if (!state.window && estimate < screen(m) * 3) {
        cancelPending(state);
        return false;
      }
      if (state.pending && state.requestedDate === targetDate) return true;
      state.requestedDate = targetDate;
      try {
        const window = desiredWindow(m, target);
        window.targetDate = targetDate;
        window.options = options;
        if (target > Date.now() / 1000) {
          window.latest = true;
          window.to = Math.floor(Date.now() / 1000) + 60;
          window.targetDate = undefined;
        }
        void rebase(m, state, window).catch(() => {});
      } catch (error) {
        const scroll = m._scrollingState;
        m._scrollingState = null;
        scroll?.deferred.reject(error);
        globalThis.dispatchEvent(
          new CustomEvent("mw-navigation-error", { detail: error }),
        );
      }
      return true;
    },
    prepareRange(m, range, resume) {
      const state = models.get(m),
        ts = m.timeScale(),
        series = m.mainSeries();
      if (
        !enabled ||
        !state ||
        state.applyingRange ||
        !series.symbol().startsWith("MWP:")
      )
        return;
      const points = ts.points().range().value();
      if (!points) return;
      const first = ts.points().valueAt(points.firstIndex),
        last = ts.points().valueAt(points.lastIndex);
      if (range.from >= first && range.to <= last) {
        cancelPending(state);
        return;
      }
      const sync = series.syncModel();
      if (!sync?.isValid()) return;
      const count = sync.mwDistance(range.from, range.to);
      const prefix = calculationPrefix(series.symbol(), m.interval());
      if (!Number.isFinite(count) || count + prefix > 20000)
        return Promise.reject(Error("显示范围过大，请缩小时间范围后重试"));
      const window = desiredWindow(m, range.from);
      // Public range restoration must preserve the exact requested viewport;
      // the bounded window only controls the fetch envelope.
      window.viewport = { from: range.from, to: range.to };
      if (range.to > window.to) {
        window.to = range.to;
        window.count += count;
      }
      window.count = Math.max(
        window.count,
        sync.mwRequiredCount(
          window.from,
          window.to,
          series.intervalObj().value(),
        ),
      );
      if (window.count + prefix > 20000) {
        // Drop optional padding before rejecting an otherwise valid requested range.
        window.from = range.from;
        window.to = range.to;
        window.count = Math.max(
          count,
          sync.mwRequiredCount(
            range.from,
            range.to,
            series.intervalObj().value(),
          ),
        );
      }
      if (window.count + prefix > 20000)
        return Promise.reject(Error("显示范围过大，请缩小时间范围后重试"));
      return rebase(m, state, window).then(async (applied) => {
        if (!applied)
          throw Object.assign(Error("已取消旧图表的历史加载"), {
            code: "HISTORY_CANCELLED",
          });
        for (let attempt = 0; ; attempt++) {
          if (models.get(m) !== state || state.window !== window)
            throw Object.assign(Error("已取消旧图表的历史加载"), {
              code: "HISTORY_CANCELLED",
            });
          try {
            state.applyingRange = true;
            const result = resume();
            state.applyingRange = false;
            return await result;
          } catch (error) {
            if (error?.message !== "Value is null" || attempt >= 20)
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } finally {
            state.applyingRange = false;
            replay(m, state);
          }
        }
      });
    },
    collectThreads(factory) {
      // Native retains purged threads in its table indefinitely. Historical
      // windows have an explicit lifetime, including their subscriptions.
      setTimeout(() => {
        for (const [key, thread] of Object.entries(factory._threads)) {
          if (
            !thread._symbolInfo.mw_window ||
            thread._pendingSubscribers.length ||
            thread._subscribers.length
          )
            continue;
          thread.destroy();
          delete factory._threads[key];
        }
      }, 0);
    },
    historyFailure(thread, error) {
      if (
        !enabled ||
        (!thread._symbolInfo.ticker?.startsWith("MWP:") &&
          !thread._symbolInfo.mw_window)
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
        state.finish?.(error);
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
    extendNewer(m, state) {
      const window = windowFor(m),
        ts = m.timeScale();
      if (
        !window ||
        window.latest ||
        state.pending ||
        state.rangePending ||
        state.applyingRange ||
        !state.external
      )
        return;
      const range = ts.visibleBarsStrictRange(),
        points = ts.points().range().value();
      const sync = m.mainSeries().syncModel(),
        n = screen(m);
      if (
        !range ||
        !points ||
        !sync?.isValid() ||
        range.lastBar() < m.mainSeries().bars().lastIndex() - n * 0.6
      )
        return;
      const centerIndex = Math.round((range.firstBar() + range.lastBar()) / 2);
      const center = ts
        .points()
        .roughTime(centerIndex, sync.projectTime.bind(sync));
      const from = ts
        .points()
        .roughTime(Math.round(range.firstBar()), sync.projectTime.bind(sync));
      const to = ts
        .points()
        .roughTime(Math.round(range.lastBar()), sync.projectTime.bind(sync));
      if (![center, from, to].every(Number.isFinite)) return;
      const next = desiredWindow(m, center);
      // Do not rebuild repeatedly when the right edge has not advanced.
      if (next.to <= window.to) return;
      next.viewport = { from, to };
      next.followViewport = true;
      if (next.to >= Date.now() / 1000) {
        next.latest = true;
        next.to = Date.now() / 1000 + 60;
      }
      void rebase(m, state, next).catch(() => {});
    },
    bindModel(m) {
      if (!enabled || models.has(m)) return;
      const state = { generation: 0 };
      models.set(m, state);
      // The hook runs inside the model constructor; defer access to its series.
      requestAnimationFrame(() => {
        if (models.get(m) !== state) return;
        const series = m.mainSeries(),
          loadDataTo = series.loadDataTo;
        series.loadDataTo = function (range) {
          if (range?.type === "time-range") {
            const pending = MWNativeNavigation.prepareRange(m, range, () =>
              loadDataTo.call(this, range),
            );
            if (pending) {
              void pending.catch((error) =>
                globalThis.dispatchEvent(
                  new CustomEvent("mw-navigation-error", { detail: error }),
                ),
              );
              return;
            }
          }
          return loadDataTo.call(this, range);
        };
        state.external = m.setExternalPosition;
        m.setExternalPosition = function (point, environment) {
          state.cursor = point ? { point: { ...point }, environment } : null;
          return state.external.call(this, point, environment);
        };
        const startScroll = m.startScrollTime,
          scroll = m.scrollTimeTo,
          endScroll = m.endScrollTime;
        m.startScrollTime = function (coordinate) {
          state.scrollCoordinate = coordinate;
          return startScroll.call(this, coordinate);
        };
        m.scrollTimeTo = function (coordinate) {
          const window = windowFor(this);
          if (window?.replacing) {
            window.dragPixels =
              (window.dragPixels || 0) + (state.scrollCoordinate - coordinate);
            state.scrollCoordinate = coordinate;
            return;
          }
          state.scrollCoordinate = coordinate;
          return scroll.call(this, coordinate);
        };
        m.endScrollTime = function () {
          state.scrollCoordinate = undefined;
          return endScroll.call(this);
        };
        state.reset = m.resetTimeScale;
        m.resetTimeScale = function () {
          const window = windowFor(this);
          if (!window || window.latest) {
            cancelPending(state);
            return state.reset.call(this);
          }
          const next = desiredWindow(this, Date.now() / 1000);
          next.latest = true;
          next.to = Math.floor(Date.now() / 1000) + 60;
          void rebase(this, state, next).catch(() => {});
        };
        const extend = () => this.extendNewer(m, state);
        m.timeScale().visibleBarsStrictRangeChanged().subscribe(state, extend);
        state.extend = extend;
        const projected = () => replay(m, state);
        m.timeScale()
          .visibleBarsStrictRangeChanged()
          .subscribe(state, projected);
        m.mainSeries().dataEvents().completed().subscribe(state, projected);
        m.mainSeries().dataEvents().dataUpdated().subscribe(state, projected);
        const changed = () => {
          if (windowFor(m)) return;
          const old = state.window;
          state.window = null;
          state.cursor = null;
          state.generation++;
          if (old) windows.delete(old.id);
          state.finish?.(
            Object.assign(Error("已取消旧图表的历史加载"), {
              code: "HISTORY_CANCELLED",
            }),
          );
          state.pending = null;
        };
        m.mainSeries().onIntervalChanged().subscribe(state, changed);
        m.mainSeries().symbolResolved().subscribe(state, changed);
        for (const method of [
          "syncTimeWithModel",
          "gotoTime",
          "gotoTimeRange",
        ]) {
          const original = m[method];
          m[method] = async function (...args) {
            const generation = ++state.generation;
            const rangeToken = method === "gotoTimeRange" ? {} : null;
            if (rangeToken) state.rangePending = rangeToken;
            try {
              for (let attempt = 0; ; attempt++) {
                if (generation !== state.generation) return;
                try {
                  return await original.apply(this, args);
                } catch (error) {
                  // Native completion may precede restored tick metadata.
                  if (
                    method !== "gotoTime" ||
                    error?.message !== "Value is null" ||
                    attempt >= 20
                  )
                    throw error;
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
              }
            } finally {
              if (rangeToken && state.rangePending === rangeToken)
                state.rangePending = null;
              if (generation === state.generation) replay(this, state);
            }
          };
        }
      });
    },
    unbindModel(m) {
      const state = models.get(m);
      if (!state) return;
      for (const [id, entry] of windows)
        if (entry.owner === m) windows.delete(id);
      state.finish?.(
        Object.assign(Error("已取消旧图表的历史加载"), {
          code: "HISTORY_CANCELLED",
        }),
      );
      if (state.extend) {
        m.timeScale().visibleBarsStrictRangeChanged().unsubscribeAll(state);
        m.mainSeries().onIntervalChanged().unsubscribeAll(state);
        m.mainSeries().symbolResolved().unsubscribeAll(state);
        m.mainSeries().dataEvents().completed().unsubscribeAll(state);
        m.mainSeries().dataEvents().dataUpdated().unsubscribeAll(state);
      }
      models.delete(m);
    },
    modelKey(m) {
      return `${m.mainSeries().symbol()}|${m.interval()}|${windowFor(m)?.id || ""}`;
    },
    threadKey(info, resolution) {
      return `${info.ticker || info.name}|${resolution}|${info.mw_window || ""}`;
    },
    busy() {
      return [...models.values()].some(
        (state) => state.pending || state.rangePending,
      );
    },
    diagnostics() {
      return {
        windows: [...windows.values()].map(
          ({ seed, nativeSeed, ...window }) => window,
        ),
        models: models.size,
        threads: threads.size,
        pending: [...models.values()].filter((state) => state.pending).length,
      };
    },
  };
})();
globalThis.MWNativeNavigation = MWNativeNavigation;
