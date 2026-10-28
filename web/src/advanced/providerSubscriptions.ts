type Subscription = {
  client: string;
  listener: string;
  [key: string]: unknown;
};
type Stream = { close(): void; onmessage: ((event: MessageEvent) => void) | null;
  onopen?: ((event: Event) => void) | null; onerror?: ((event: Event) => void) | null;
  readonly readyState?: number };
type FailureKind = 'market' | 'connection' | 'subscription';
type TransportEvidence = Record<string, string | number | boolean | null>;

// Transport ordering only. Bar acquisition, freshness and recovery belong to
// the backend. A cancellation must follow its in-flight registration.
export function providerSubscriptions(
  request: (path: string, body: unknown) => Promise<unknown>,
  connect: (client: string) => Stream,
  receive: (event: any) => void,
  failure: (error: unknown) => void,
  paths = {subscribe: '/charts/stream/subscribe', unsubscribe: '/charts/stream/unsubscribe'},
  observe: (args: Subscription, kind: FailureKind, error: unknown | null, attempt: string, lifecycle?: 'ended', evidence?: TransportEvidence) => void = () => {},
  established: (args: Subscription) => Promise<boolean> = async () => true,
) {
  let disposed = false;
  const waiting = new Set<string>();
  const desired = new Map<string, Subscription>();
  const queues = new Map<string, Promise<void>>();
  const streams = new Map<string, Stream>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const outages = new Map<string, string>();
  const connections = new Map<string, {args: Subscription; attempt: string; evidence: TransportEvidence}>();
  const reconnects = new Map<string, number>();
  const invalid = new Set<string>();
  const registrationRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const registrationDelays = new Map<string, number>();
  let attempt = 0;
  function status(args: Subscription, kind: FailureKind, error: unknown | null) {
    if (disposed || desired.get(keyOf(args)) !== args) return;
    const key = keyOf(args) + '|' + String(args.generation ?? '') + '|' + kind;
    const previous = outages.get(key);
    if (error != null && !previous) {
      const id = String(++attempt);
      outages.set(key, id);
      observe(args, kind, error, id);
    } else if (error == null && previous) {
      outages.delete(key);
      observe(args, kind, null, previous);
    }
  }
  const keyOf = (args: Subscription) => args.client + "|" + args.listener;
  function connection(client: string, error: unknown | null, ended = false, evidence: TransportEvidence = {}) {
    const old = connections.get(client);
    if (error && !old) {
      const args = [...desired.values()].find(value => value.client === client);
      if (!args) return;
      const id = String(++attempt);
      connections.set(client, {args, attempt: id, evidence});
      observe(args, 'connection', error, id, undefined, evidence);
    } else if (!error && old) {
      connections.delete(client);
      observe(old.args, 'connection', null, old.attempt, ended ? 'ended' : undefined,
        {...old.evidence, ...evidence, [ended ? 'ended_at' : 'recovered_at']: Date.now()});
    }
  }
  function end(args: Subscription, kind?: FailureKind) {
    const prefix = keyOf(args) + '|' + String(args.generation ?? '') + '|';
    for (const [key, id] of outages) if (key.startsWith(prefix) && (!kind || key.endsWith('|' + kind))) {
      observe(args, key.slice(prefix.length) as FailureKind, null, id, 'ended');
      outages.delete(key);
    }
  }
  function closeUnused(client: string) {
    if ([...desired.values()].some(args => args.client === client)) return;
    connection(client, null, true);
    clearTimeout(retries.get(client));
    retries.delete(client);
    streams.get(client)?.close();
    streams.delete(client);
    reconnects.delete(client);
  }
  async function register(args: Subscription) {
    if (disposed || desired.get(keyOf(args)) !== args) return;
    waiting.add(keyOf(args));
    if (!(await established(args))) {
      if (!disposed && desired.get(keyOf(args)) === args) waiting.add(keyOf(args));
      return;
    }
    if (disposed || desired.get(keyOf(args)) !== args) return;
    waiting.delete(keyOf(args));
    await request(paths.subscribe, args);
    if (disposed || desired.get(keyOf(args)) !== args) return;
    const key = keyOf(args);
    clearTimeout(registrationRetries.get(key)); registrationRetries.delete(key); registrationDelays.delete(key);
    status(args, 'subscription', null);
    if (!retries.has(args.client)) open(args.client);
  }
  function enqueue(args: Subscription, action: () => Promise<void>) {
    const key = keyOf(args);
    const next = (queues.get(key) || Promise.resolve()).then(action).catch(error => {
      if (!disposed && desired.get(keyOf(args)) === args) {
        if ((error as {code?: string})?.code === 'COMPOSITE_NOT_ESTABLISHED') {
          waiting.add(key);
          return;
        }
        status(args, 'subscription', error);
        const statusCode = (error as {status?: number})?.status || 0;
        if (statusCode >= 400 && statusCode < 500 && ![408, 429].includes(statusCode)) invalid.add(keyOf(args));
        else if (!registrationRetries.has(key)) {
          const delay = Math.min(30_000, (registrationDelays.get(key) || 500) * 2);
          registrationDelays.set(key, delay);
          registrationRetries.set(key, setTimeout(() => {
            registrationRetries.delete(key);
            if (!disposed && desired.get(key) === args) void enqueue(args, () => register(args));
          }, delay));
        }
        failure(error);
      }
    });
    queues.set(key, next);
    void next.then(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  }
  function unsubscribe(args: Subscription) {
    const current = desired.get(keyOf(args));
    if (current?.generation != null && args.generation != null &&
        Number(args.generation) < Number(current.generation)) return Promise.resolve();
    if (current) end(current);
    desired.delete(keyOf(args));
    waiting.delete(keyOf(args));
    invalid.delete(keyOf(args));
    clearTimeout(registrationRetries.get(keyOf(args))); registrationRetries.delete(keyOf(args)); registrationDelays.delete(keyOf(args));
    closeUnused(args.client);
    return enqueue(args, async () => {
      await request(paths.unsubscribe, {client: args.client, listener: args.listener,
        ...(args.generation != null ? {generation: args.generation} : {})});
    });
  }
  function open(client: string) {
    if (disposed || streams.has(client) || ![...desired.values()].some(args => args.client === client)) return;
    const stream = connect(client);
    streams.set(client, stream);
    const evidence = (): TransportEvidence => ({ready_state: stream.readyState ?? null,
      online: typeof navigator === 'undefined' ? null : navigator.onLine,
      visibility: typeof document === 'undefined' ? null : document.visibilityState,
      observed_at: Date.now(), reconnect_count: reconnects.get(client) || 0});
    stream.onopen = () => {
      if (disposed || streams.get(client) !== stream) return;
      if (connections.has(client)) reconnects.set(client, Math.min(1_000_000, (reconnects.get(client) || 0)+1));
      connection(client, null, false, evidence());
      for (const current of desired.values()) if (current.client === client && !invalid.has(keyOf(current)) && !waiting.has(keyOf(current)))
        void enqueue(current, async () => {
          await register(current);
        });
    };
    stream.onerror = () => {
      // Native EventSource retries CONNECTING itself. An HTTP error may leave
      // it CLOSED permanently, so recreate only that terminal transport.
      if (disposed || streams.get(client) !== stream) return;
      connection(client, Error('行情事件连接中断，正在重连'), false,
        {...evidence(), occurred_at: Date.now()});
      if (stream.readyState !== 2) return;
      stream.close();
      streams.delete(client);
      retries.set(client, setTimeout(() => {
        retries.delete(client);
        open(client);
      }, 1000));
    };
    stream.onmessage = event => {
      if (disposed || streams.get(client) !== stream) return;
      try {
        const value = JSON.parse(event.data);
        const current = desired.get(client + '|' + value.listener);
        const epochChanged = current?.result_epoch != null && value.result_epoch != null &&
          value.result_epoch !== current.result_epoch;
        if (current && (current.generation == null || value.generation === current.generation) &&
            (epochChanged || current.sequence == null || value.sequence > Number(current.sequence))) {
          if (epochChanged) current.sequence = 0;
          if (value.result_epoch != null) current.result_epoch = value.result_epoch;
          if (value.notice_owner === 'server') end(current, 'market');
          const quoteWaiting = value.type === 'quotes' && value.quotes?.some((row: any) => ['pending', 'stale'].includes(row.v?.fetch_status));
          const quoteError = value.type === 'quotes' && value.quotes?.some((row: any) => row.s === 'error' || (row.v?.fetch_status && !['ok', 'pending', 'stale'].includes(row.v.fetch_status)));
          if (value.notice_owner !== 'server' && (quoteError || value.status?.connection_error || value.status?.error || value.type === 'error' || (value.type === 'status' && (value.error || value.status === 'error'))))
            status(current, 'market', Error(value.error || value.status?.error || value.status?.connection_error || '行情读取失败'));
          else if (value.notice_owner !== 'server' && ((value.type === 'bars' && (!value.status || value.status.state === 'ready' || (value.status.connection === 'connected' && value.status.owned === true && value.status.current_account === true && (value.status.sample_ready === true || value.status.confirmed_tail_ready === true)))) || (value.type === 'quotes' && value.quotes?.length && !quoteWaiting))) status(current, 'market', null);
          receive(value);
          if(value.type === 'bars') {
            if(value.cursor != null) current.cursor=value.cursor;
            else if(value.bars?.length) current.cursor=value.bars.at(-1).chart_time ?? value.bars.at(-1).start;
            if(value.revision != null) current.revision=value.revision;
            if(value.as_of != null) current.observed_at=value.as_of;
            for (const name of ['loaded_before', 'history_revision', 'history_tail_revision', 'initial_input_revision'])
              if (value[name] != null) current[name] = value[name];
          }
          for(const name of ['dependency_observed_at','dependency_revision','initial_input_revision'])
            if(value[name]!=null)current[name]=value[name];
          if (value.type === 'quotes') {
            const binding = value.quotes?.find((quote: any) => quote.snapshot)?.snapshot?.revision_id;
            if (binding != null) current.binding = binding;
          }
          if (value.sequence != null) current.sequence = value.sequence;
        }
      } catch (error) { failure(error); }
    };
  }
  return {
    established(instrument: string) {
      // Cross-tab hints always re-check authoritative metadata, never create.
      return Promise.all([...desired.values()].filter(args => {
        const query = args.query as {series_kind?: string; instrument?: string};
        return query?.series_kind === 'composite' && query.instrument === instrument && waiting.has(keyOf(args));
      }).map(args => enqueue(args, async () => { if(waiting.has(keyOf(args)))await register(args); })));
    },
    accept(args: Subscription) {
      const current = desired.get(keyOf(args));
      if (disposed || !current || current.generation !== args.generation ||
          current.result_epoch !== args.result_epoch || !Array.isArray(args.provider_acceptance))
        return Promise.resolve();
      // This message comes from the host after successful native callbacks,
      // independently of EventSource receipt. Preserve it on reconnect too.
      const values = new Map<number, any>();
      for (const row of (current.provider_acceptance as any[] || [])) values.set(row.start, row);
      for (const row of args.provider_acceptance) values.set(row.start, row);
      current.provider_acceptance = [...values.values()].sort((a,b)=>a.start-b.start).slice(-2048);
      return enqueue(args, async () => {
        if (disposed || desired.get(keyOf(args)) !== current) return;
        await request('/charts/stream/accept', args);
      });
    },
    subscribe(args: Subscription) {
      if (disposed) return Promise.resolve();
      const prior = desired.get(keyOf(args));
      if (prior && prior !== args) end(prior);
      invalid.delete(keyOf(args));
      clearTimeout(registrationRetries.get(keyOf(args))); registrationRetries.delete(keyOf(args));
      registrationDelays.delete(keyOf(args));
      desired.set(keyOf(args), args);
      return enqueue(args, async () => {
        if (disposed || desired.get(keyOf(args)) !== args) return;
        await register(args);
      });
    },
    unsubscribe,
    clear() {
      return Promise.all([...desired.values()].map(unsubscribe));
    },
    dispose() {
      disposed = true;
      return Promise.all([...desired.values()].map(unsubscribe));
    },
  };
}
