/** One business store, partitioned by verified origin/subject and schema. */
export const MOBILE_SCHEMA = 1;
export type Profile = {
  origin: string;
  subject: string;
  schema: typeof MOBILE_SCHEMA;
  generation?: number;
};
const generations = new Map<string, number>();
export function invalidateProfile(origin: string) {
  generations.set(origin, (generations.get(origin) || 0) + 1);
}
export const profileActive = (profile: Profile) =>
  (profile.generation || 0) === (generations.get(profile.origin) || 0);
export const profileFor = (origin: string, subject: string): Profile => ({
  origin,
  subject,
  schema: MOBILE_SCHEMA,
  generation: generations.get(origin) || 0,
});
export type Snapshot<T> = { value: T; readAt: number };
const database = "mw-mobile";
export const noticeStores = [
  "pending",
  "cache",
  "meta",
  "claims",
  "observations",
];
export function openMobileDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 2);
    request.onupgradeneeded = () => {
      for (const name of ["records", "profiles"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name);
      for (const name of noticeStores)
        if (!request.result.objectStoreNames.contains(name)) {
          const store = request.result.createObjectStore(name, {
            keyPath: "key",
          });
          store.createIndex("subject", "subject");
          store.createIndex("at", "at");
        }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error("请关闭旧的手机页面后重试本机存储"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction, result: (value: T) => void) => void,
): Promise<T> {
  const db = await openMobileDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error || Error("本机存储未完成"));
    };
    try {
      action(tx, (next) => {
        value = next;
      });
    } catch (error) {
      tx.abort();
      db.close();
      reject(error);
    }
  });
}
function key(profile: Profile, name: string): IDBValidKey[] {
  return [profile.origin, profile.subject, profile.schema, name];
}
export function rememberProfile(
  origin: string,
  subject: string,
  profile = profileFor(origin, subject),
): Promise<Profile> {
  if (!subject) return Promise.reject(Error("会话未提供身份"));
  return transaction(["profiles"], "readwrite", (tx, done) => {
    if (!profileActive(profile)) throw Error("会话已结束");
    tx.objectStore("profiles").put(profile, origin);
    done(profile);
  });
}
/** Called only for offline reading; this never establishes an authenticated session. */
export function lastProfile(origin: string): Promise<Profile | undefined> {
  return transaction(["profiles"], "readonly", (tx, done) => {
    const request = tx.objectStore("profiles").get(origin);
    request.onsuccess = () =>
      done(
        request.result?.schema === MOBILE_SCHEMA
          ? profileFor(origin, request.result.subject)
          : undefined,
      );
  });
}
export function readSnapshot<T>(
  profile: Profile,
  name: string,
): Promise<Snapshot<T> | undefined> {
  return transaction(["records"], "readonly", (tx, done) => {
    const request = tx.objectStore("records").get(key(profile, name));
    request.onsuccess = () => done(request.result);
  });
}
/** Completion means the entire replacement committed, not just IDBRequest success. */
export function writeSnapshot<T>(
  profile: Profile,
  name: string,
  value: T,
): Promise<void> {
  if (!profileActive(profile))
    return Promise.reject(Error("会话已结束，忽略迟到的本机写入"));
  return transaction(["records"], "readwrite", (tx) => {
    if (!profileActive(profile)) throw Error("会话已结束");
    tx.objectStore("records").put(
      { value, readAt: Date.now() },
      key(profile, name),
    );
  });
}
export function dropSnapshot(profile: Profile, name: string): Promise<void> {
  return transaction(["records"], "readwrite", (tx) => {
    tx.objectStore("records").delete(key(profile, name));
  });
}
export function clearOrigin(origin: string): Promise<void> {
  invalidateProfile(origin);
  return transaction(
    ["records", "profiles", ...noticeStores],
    "readwrite",
    (tx) => {
      // IndexedDB is origin scoped. Notification runtime shares this database.
      if (origin === window.location.origin)
        for (const name of noticeStores) tx.objectStore(name).clear();
      tx.objectStore("profiles").delete(origin);
      tx.objectStore("profiles").put(true, [origin, "signed-out"]);
      const cursor = tx.objectStore("records").openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (Array.isArray(row.key) && row.key[0] === origin) row.delete();
        row.continue();
      };
    },
  );
}
/** An offline logout must not silently reuse an unretracted HttpOnly browser cookie. */
export function locallySignedOut(origin: string): Promise<boolean> {
  return transaction(["profiles"], "readonly", (tx, done) => {
    const request = tx.objectStore("profiles").get([origin, "signed-out"]);
    request.onsuccess = () => done(request.result === true);
  });
}
export function allowSession(origin: string, profile?: Profile): Promise<void> {
  return transaction(["profiles"], "readwrite", (tx) => {
    if (profile && !profileActive(profile)) throw Error("会话已结束");
    tx.objectStore("profiles").delete([origin, "signed-out"]);
  });
}
export type ChartDocument = {
  engine: "tv31";
  schemaVersion: 1;
  state?: Record<string, any>;
  symbol?: string;
  interval?: string;
  theme?: string;
};
export function validChartDocument(value: unknown): value is ChartDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as ChartDocument;
  return (
    doc.engine === "tv31" &&
    doc.schemaVersion === 1 &&
    (!doc.state ||
      (Array.isArray(doc.state.charts) && doc.state.charts.length === 1))
  );
}
