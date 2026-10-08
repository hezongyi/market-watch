type Subscription = {
  client: string;
  listener: string;
  [key: string]: unknown;
};
type Stream = { close(): void; onmessage: ((event: MessageEvent) => void) | null;
  onopen?: ((event: Event) => void) | null; onerror?: ((event: Event) => void) | null;
  readonly readyState?: number };

// Transport ordering only. Bar acquisition, freshness and recovery belong to
// the backend. A cancellation must follow its in-flight registration.
export function providerSubscriptions(
  request: (path: string, body: unknown) => Promise<unknown>,
  connect: (client: string) => Stream,
  receive: (event: any) => void,
  failure: (error: unknown) => void,
  paths = {subscribe: '/charts/provider/subscribe', unsubscribe: '/charts/provider/unsubscribe'},
) {
  let disposed = false;
  const desired = new Map<string, Subscription>();
  const queues = new Map<string, Promise<void>>();
  const streams = new Map<string, Stream>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const keyOf = (args: Subscription) => args.client + "|" + args.listener;
  function closeUnused(client: string) {
    if ([...desired.values()].some(args => args.client === client)) return;
    clearTimeout(retries.get(client));
    retries.delete(client);
    streams.get(client)?.close();
    streams.delete(client);
  }
  function enqueue(args: Subscription, action: () => Promise<void>) {
    const key = keyOf(args);
    const next = (queues.get(key) || Promise.resolve()).then(action).catch(error => {
      if (!disposed) failure(error);
    });
    queues.set(key, next);
    void next.then(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  }
  function unsubscribe(args: Subscription) {
    const current = desired.get(keyOf(args));
    if (current?.generation != null && args.generation != null &&
        Number(args.generation) < Number(current.generation)) return Promise.resolve();
    desired.delete(keyOf(args));
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
    stream.onopen = () => {
      if (streams.get(client) !== stream) return;
      for (const current of desired.values()) if (current.client === client)
        void enqueue(current, async () => {
          if (!disposed && desired.get(keyOf(current)) === current)
            await request(paths.subscribe, current);
        });
    };
    stream.onerror = () => {
      // Native EventSource retries CONNECTING itself. An HTTP error may leave
      // it CLOSED permanently, so recreate only that terminal transport.
      if (disposed || streams.get(client) !== stream || stream.readyState !== 2) return;
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
          receive(value);
          if(value.type === 'bars') {
            if(value.cursor != null) current.cursor=value.cursor;
            else if(value.bars?.length) current.cursor=value.bars.at(-1).chart_time ?? value.bars.at(-1).start;
            if(value.revision != null) current.revision=value.revision;
            if(value.as_of != null) current.observed_at=value.as_of;
          }
          if (value.sequence != null) current.sequence = value.sequence;
        }
      } catch (error) { failure(error); }
    };
  }
  return {
    subscribe(args: Subscription) {
      if (disposed) return Promise.resolve();
      desired.set(keyOf(args), args);
      return enqueue(args, async () => {
        if (disposed || desired.get(keyOf(args)) !== args) return;
        await request(paths.subscribe, args);
        if (disposed || desired.get(keyOf(args)) !== args) return;
        if (!retries.has(args.client)) open(args.client);
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
