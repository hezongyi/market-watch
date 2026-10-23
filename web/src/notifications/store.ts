/** Same-origin, subject-scoped durability. All claims are atomic IDB transactions. */
type Item = {
  key: string;
  subject: string;
  at: number;
  order?: number;
  value: any;
};
export class NoticeStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<void> | null = null;
  open(): Promise<void> {
    if (this.db) return Promise.resolve();
    return (this.opening ??= this.connect().finally(() => {
      this.opening = null;
    }));
  }
  private async connect() {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mw-professional-notices-v1", 1);
      request.onupgradeneeded = () => {
        for (const name of [
          "pending",
          "cache",
          "meta",
          "claims",
          "observations",
        ]) {
          const store = request.result.createObjectStore(name, {
            keyPath: "key",
          });
          store.createIndex("subject", "subject");
          store.createIndex("at", "at");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("通知本机存储被其他页面阻止"));
    });
    this.db.onversionchange = () => this.db?.close();
  }
  close() {
    void (this.opening || Promise.resolve()).then(() => {
      this.db?.close();
      this.db = null;
    });
  }
  async all(name: string, subject: string): Promise<Item[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(name),
        request = tx.objectStore(name).index("subject").getAll(subject);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async get(name: string, key: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = this.db!.transaction(name).objectStore(name).get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }
  /** Returns the previous value. A false create callback leaves the record unchanged. */
  async update(
    name: string,
    key: string,
    subject: string,
    create: (previous: any) => any,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(name, "readwrite"),
        store = tx.objectStore(name);
      const request = store.get(key);
      let previous: any;
      request.onsuccess = () => {
        previous = request.result?.value;
        const value = create(previous);
        if (value !== undefined) {
          const write = () =>
            store.put({
              key,
              subject,
              ...(request.result?.order === undefined
                ? {}
                : { order: request.result.order }),
              at:
                name === "pending" || (name === "observations" && value.pending)
                  ? (request.result?.at ?? Date.now())
                  : Date.now(),
              value,
            });
          if (
            previous === undefined &&
            ["claims", "observations", "meta"].includes(name)
          ) {
            const budget =
              name === "claims" ? 10000 : name === "observations" ? 2000 : 1100;
            const rows = store.index("subject").getAll(subject);
            rows.onsuccess = () => {
              const bytes = rows.result.reduce(
                (total, row) =>
                  total +
                  new TextEncoder().encode(JSON.stringify(row.value)).length,
                0,
              );
              if (
                rows.result.length >= budget ||
                bytes + new TextEncoder().encode(JSON.stringify(value)).length >
                  2 * 1024 * 1024
              )
                tx.abort();
              else write();
            };
          } else write();
        }
      };
      tx.oncomplete = () => resolve(previous);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("通知存储事务中止"));
    });
  }
  async remove(name: string, key: string) {
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(name, "readwrite");
      tx.objectStore(name).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async stage(subject: string, value: any, observation?: { key: string; value: any }) {
    return new Promise<any>((resolve, reject) => {
      const tx = this.db!.transaction(observation ? ["pending", "meta"] : "pending", "readwrite"),
        store = tx.objectStore("pending");
      let previous: any;
      const request = store.index("subject").getAll(subject);
      request.onsuccess = () => {
        const rows = request.result as Item[],
          size = new TextEncoder().encode(JSON.stringify(value)).length;
        if (rows.some((r) => r.key === subject + ":" + value.event_id)) return;
        if (
          size > 16384 ||
          [value.context, value.evidence].some(
            (part) =>
              new TextEncoder().encode(JSON.stringify(part || {})).length >
              12288,
          ) ||
          rows.length >= 1000 ||
          rows.reduce((n, r) => n + JSON.stringify(r.value).length * 2, 0) +
            size >
            10 * 1024 * 1024
        ) {
          tx.abort();
          return;
        }
        store.put({
          key: subject + ":" + value.event_id,
          subject,
          at: Date.now(),
          // This transaction serializes tabs; wall-clock ties cannot reorder a
          // failure, its recovery and a subsequent recurrence in the uploader.
          order: Math.max(
            Date.now(),
            ...rows.map((row) => (row.order ?? row.at) + 1),
          ),
          value: { event: value, status: "pending" },
        });
        if (observation) {
          const meta = tx.objectStore("meta"), read = meta.get(observation.key);
          read.onsuccess = () => {
            previous = read.result?.value;
            const write = () => meta.put({ key: observation.key, subject, at: Date.now(), value: observation.value });
            if (previous !== undefined) write();
            else {
              const all = meta.index("subject").getAll(subject);
              all.onsuccess = () => {
                if (all.result.length >= 1100 || new TextEncoder().encode(JSON.stringify(observation.value)).length +
                    all.result.reduce((bytes, row) => bytes + new TextEncoder().encode(JSON.stringify(row.value)).length, 0) > 2 * 1024 * 1024)
                  tx.abort();
                else write();
              };
            }
          };
        }
      };
      tx.oncomplete = () => resolve(previous);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(Error("本机通知队列已满或不能写入；新增事件未能保存"));
    });
  }
  async saveProgress(
    subject: string,
    after: string,
    epoch: string,
    events: any[],
    unread: number,
    projectedIds: string[] = events.map((event) => event.id),
    instantAlerts: any[] = [],
  ) {
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(
        ["cache", "meta", "pending"],
        "readwrite",
      );
      tx.objectStore("cache").put({
        key: subject,
        subject,
        at: Date.now(),
        value: events,
      });
      tx.objectStore("meta").put({
        key: subject + ":progress",
        subject,
        at: Date.now(),
        value: { presentationVersion: 1, after, epoch, unread },
      });
      // Persist eligible live alerts before advancing the cursor. Keep the v1
      // schema readable by older clients; queue records use separate cache keys.
      const cache = tx.objectStore("cache");
      for (const event of instantAlerts) {
        const key = subject + ":alert-popup:" + event.id;
        const request = cache.get(key);
        request.onsuccess = () => {
          if (!request.result)
            cache.put({
              key,
              subject,
              at: Date.now(),
              value: { event, confirmed_at: null },
            });
        };
      }
      const pending = tx.objectStore("pending");
      for (const id of projectedIds) {
        const key = subject + ":" + id;
        const request = pending.get(key);
        request.onsuccess = () => {
          // A conflicting local payload remains reviewable even if the original
          // server event with the same ID is projected successfully.
          if (request.result?.value.status !== "rejected") pending.delete(key);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async prune(subject: string): Promise<{ lost: number; from: number | null }> {
    const expired = (await this.all("pending", subject)).filter(
      (row) => row.at < Date.now() - 7 * 86400000,
    );
    for (const row of expired) await this.remove("pending", row.key);
    for (const name of ["claims", "observations", "meta"]) {
      const rows = await this.all(name, subject);
      for (const row of rows)
        if (
          row.at <
            Date.now() -
              (name === "observations" && !row.value.pending ? 1 : 31) *
                86400000 &&
          (name !== "meta" || row.key.includes(":fault:"))
        )
          await this.remove(name, row.key);
    }
    // Waiting alerts have no TTL. Only old, explicitly confirmed receipts age out.
    for (const row of await this.all("cache", subject))
      if (
        row.key.startsWith(subject + ":alert-popup:") &&
        row.value.confirmed_at &&
        row.value.confirmed_at < Date.now() - 31 * 86400000
      )
        await this.remove("cache", row.key);
    const lost = expired.filter((row) => row.value.status !== "accepted");
    return { lost: lost.length, from: lost[0]?.at || null };
  }
}
