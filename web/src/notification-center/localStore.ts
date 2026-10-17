/** Minimal promise wrapper around IndexedDB with an explicit failure mode. */
export type LocalState = "ok" | "unavailable" | "limited";

const DB_NAME = "mw-notification-center";
const DB_VERSION = 2;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending");
      if (!db.objectStoreNames.contains("sounds")) db.createObjectStore("sounds");
      if (!db.objectStoreNames.contains("bubbles")) db.createObjectStore("bubbles");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

export class LocalStore {
  private db: Promise<IDBDatabase> | null = null;
  state: LocalState = "ok";

  private async handle(): Promise<IDBDatabase> {
    this.db ??= open().catch((error) => {
      this.state = "unavailable";
      throw error;
    });
    try {
      return await this.db;
    } catch (error) {
      this.db = null;
      throw error;
    }
  }

  async get<T>(store: "state" | "pending" | "sounds" | "bubbles", key: string): Promise<T | undefined> {
    try {
      const db = await this.handle();
      return await new Promise<T | undefined>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return undefined;
    }
  }

  async all<T>(store: "pending"): Promise<T[]> {
    try {
      const db = await this.handle();
      return await new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return [];
    }
  }

  async put(store: "state" | "pending" | "sounds" | "bubbles", key: string, value: unknown): Promise<boolean> {
    try {
      const db = await this.handle();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        transaction.objectStore(store).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return true;
    } catch {
      if (this.state === "ok") this.state = "limited";
      return false;
    }
  }

  async delete(store: "state" | "pending" | "sounds" | "bubbles", key: string): Promise<void> {
    try {
      const db = await this.handle();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        transaction.objectStore(store).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch {
      /* best effort: the server remains the durable record */
    }
  }

  async add(store: "sounds", key: string): Promise<boolean> {
    try {
      const db = await this.handle();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        transaction.objectStore(store).add(1, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      return true;
    } catch {
      return false;
    }
  }
}
