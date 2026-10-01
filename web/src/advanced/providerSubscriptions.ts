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
    desired.delete(keyOf(args));
    closeUnused(args.client);
    return enqueue(args, async () => {
      await request('/charts/provider/unsubscribe', {client: args.client, listener: args.listener});
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
            await request('/charts/provider/subscribe', current);
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
        if (current) {
          receive(value);
          if(value.type === 'bars') {
            current.cursor=value.cursor;
            current.revision=value.revision;
            current.observed_at=value.as_of;
          }
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
        await request('/charts/provider/subscribe', args);
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
