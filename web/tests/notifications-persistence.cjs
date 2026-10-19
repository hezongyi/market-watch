const assert = require("node:assert/strict"),
  { build } = require("esbuild"),
  vm = require("node:vm"),
  { IDBFactory } = require("fake-indexeddb");
(async () => {
  const { outputFiles } = await build({
    entryPoints: ["src/notifications/store.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Storage",
  });
  const indexedDB = new IDBFactory(),
    context = { indexedDB, Date, TextEncoder, console };
  vm.createContext(context);
  vm.runInContext(outputFiles[0].text, context);
  const store = new context.Storage.NoticeStore();
  await store.open();
  assert.equal(store.db.version, 1, "old clients can still open this schema");
  const trades = Array.from({ length: 25 }, (_, i) => ({
    id: "s:" + i,
    first_seq: i,
    source_kind: "chart_alert",
  }));
  await store.saveProgress("admin", "cursor-1", "epoch-1", [], 0, [], trades);
  const receipts = () =>
    store
      .all("cache", "admin")
      .then((rows) => rows.filter((row) => row.key.includes(":alert-popup:")));
  assert.equal((await receipts()).length, 25, "no 20-card queue loss");
  const key = "admin:alert-popup:s:0";
  await store.update("cache", key, "admin", (old) => ({
    ...old,
    confirmed_at: Date.now(),
  }));
  await store.saveProgress("admin", "cursor-2", "epoch-1", [], 0, [], trades);
  assert.ok(
    (await store.get("cache", key)).confirmed_at,
    "replay cannot reset confirmation",
  );
  assert.equal(
    (await receipts()).length,
    25,
    "same event deduplicates; different triggers remain",
  );
  await store.saveProgress(
    "other",
    "cursor-other",
    "epoch-1",
    [],
    0,
    [],
    [{ id: "s:other" }],
  );
  assert.equal((await receipts()).length, 25, "subjects stay isolated");
  // Abort immediately after the cursor write succeeds: neither half may persist.
  const transaction = store.db.transaction.bind(store.db);
  let abort = true;
  store.db.transaction = (...args) => {
    const tx = transaction(...args);
    if (abort && args[1] === "readwrite" && Array.isArray(args[0])) {
      abort = false;
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = (name) => {
        const table = objectStore(name);
        if (name === "meta") {
          const put = table.put.bind(table);
          table.put = (...values) => {
            const request = put(...values);
            request.onsuccess = () => tx.abort();
            return request;
          };
        }
        return table;
      };
    }
    return tx;
  };
  await assert.rejects(
    store.saveProgress(
      "admin",
      "must-not-advance",
      "epoch-1",
      [],
      0,
      [],
      [{ id: "s:lost" }],
    ),
  );
  store.db.transaction = transaction;
  assert.equal((await store.get("meta", "admin:progress")).after, "cursor-2");
  assert.equal(await store.get("cache", "admin:alert-popup:s:lost"), undefined);
  await store.saveProgress(
    "admin",
    "cursor-3",
    "epoch-1",
    [],
    0,
    [],
    [{ id: "s:lost" }],
  );
  assert.ok(await store.get("cache", "admin:alert-popup:s:lost"));
  const now = Date.now;
  Date.now = () => now() + 40 * 86400000;
  await store.prune("admin");
  Date.now = now;
  assert.equal(
    await store.get("cache", key),
    undefined,
    "only old confirmed receipts age out",
  );
  assert.equal(
    (await receipts()).length,
    25,
    "unconfirmed alerts survive retention sweeps",
  );
  store.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reopened = new context.Storage.NoticeStore();
  await reopened.open();
  assert.equal(
    (await reopened.all("cache", "admin")).filter((r) =>
      r.key.includes(":alert-popup:"),
    ).length,
    25,
  );
  const legacy = await new Promise((resolve, reject) => {
    const r = indexedDB.open("mw-professional-notices-v1", 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  assert.equal(legacy.version, 1);
  legacy.close();
  reopened.close();
  console.log(
    "PASS atomic alert/cursor recovery, dedupe, retention, subject isolation and v1 compatibility",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
