/** One business store, partitioned by verified origin/subject and schema. */
export const MOBILE_SCHEMA = 1;
export type Profile = {
  origin: string;
  subject: string;
  schema: typeof MOBILE_SCHEMA;
};
export type Snapshot<T> = { value: T; readAt: number };
const database = "mw-mobile";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("records");
      request.result.createObjectStore("profiles");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error("请关闭旧的手机页面后重试本机存储"));
    request.onsuccess = () => resolve(request.result);
  });
}
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction, result: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
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
): Promise<Profile> {
  if (!subject) return Promise.reject(Error("会话未提供身份"));
  const profile: Profile = { origin, subject, schema: MOBILE_SCHEMA };
  return transaction(["profiles"], "readwrite", (tx, done) => {
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
        request.result?.schema === MOBILE_SCHEMA ? request.result : undefined,
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
  return transaction(["records"], "readwrite", (tx) => {
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
  return transaction(["records", "profiles"], "readwrite", (tx) => {
    tx.objectStore("profiles").delete(origin);
    tx.objectStore("profiles").put(true, [origin, "signed-out"]);
    const cursor = tx.objectStore("records").openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (Array.isArray(row.key) && row.key[0] === origin) row.delete();
      row.continue();
    };
  });
}
/** An offline logout must not silently reuse an unretracted HttpOnly browser cookie. */
export function locallySignedOut(origin: string): Promise<boolean> {
  return transaction(["profiles"], "readonly", (tx, done) => {
    const request = tx.objectStore("profiles").get([origin, "signed-out"]);
    request.onsuccess = () => done(request.result === true);
  });
}
export function allowSession(origin: string): Promise<void> {
  return transaction(["profiles"], "readwrite", (tx) => {
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
