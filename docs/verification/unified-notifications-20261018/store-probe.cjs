const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { indexedDB } = require('fake-indexeddb');
const repo = path.resolve(process.argv[2] || process.cwd());
const { build } = createRequire(path.join(repo, 'web/package.json'))('esbuild');
const output = path.join(__dirname, 'store-probe-results.json');
const report = { testedAt: new Date().toISOString(), repo, engine: 'fake-indexeddb 6.2.4', checks: [] };
const passed = (name) => { report.checks.push({ name, outcome: 'PASS' }); console.log('PASS ' + name); };
(async () => {
  const built = await build({ entryPoints: [path.join(repo, 'web/src/notifications/store.ts')], bundle: true, write: false, format: 'iife', globalName: 'StoreModule', platform: 'browser' });
  let clock = 1900000000000;
  const sandbox = { indexedDB, TextEncoder, Date: { now: () => clock } };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox);
  const store = new sandbox.StoreModule.NoticeStore();
  await store.open();
  const start = clock, day = 86400000;
  const event = (id) => ({ event_id: id, context: {}, evidence: {}, title: 'synthetic test' });
  await store.stage('admin', event('b:ttl'));
  await store.update('observations', 'obs:ttl', 'admin', () => ({ pending: true, value: { event_id: 'b:ttl' } }));
  const initialOrder = (await store.all('pending', 'admin'))[0].order;
  for (let n = 1; n <= 3; n++) {
    clock = start + n * day;
    await store.update('pending', 'admin:b:ttl', 'admin', old => ({ ...old, status: 'accepted', nextCheck: clock + 30000 }));
    await store.update('observations', 'obs:ttl', 'admin', old => ({ ...old, nextCheck: clock + 30000 }));
  }
  const pending = (await store.all('pending', 'admin'))[0];
  assert.equal(pending.at, start);
  assert.equal(pending.order, initialOrder);
  assert.equal((await store.all('observations', 'admin'))[0].at, start);
  clock = start + 8 * day;
  await store.prune('admin');
  assert.equal((await store.all('pending', 'admin')).length, 0);
  assert.equal((await store.all('observations', 'admin')).length, 1);
  clock = start + 32 * day;
  await store.prune('admin');
  assert.equal((await store.all('observations', 'admin')).length, 0);
  passed('Repeated nextCheck preserves original pending/observation TTL and pending order; seven-day/31-day expiry works');

  await store.update('observations', 'obs:done', 'admin', () => ({ pending: true, value: {} }));
  clock += 3 * day;
  await store.update('observations', 'obs:done', 'admin', old => ({ ...old, pending: false }));
  assert.equal((await store.all('observations', 'admin'))[0].at, clock);
  clock += day + 1;
  await store.prune('admin');
  assert.equal((await store.all('observations', 'admin')).length, 0);
  passed('Completed observation starts one-day retention at completion');

  await store.stage('admin', event('b:normal'));
  await store.stage('admin', event('b:rejected'));
  await store.update('pending', 'admin:b:rejected', 'admin', old => ({ ...old, status: 'rejected', rejection: 'synthetic conflict' }));
  await store.saveProgress('admin', 'cursor1', 'epoch', [], 0, ['b:normal', 'b:rejected']);
  assert.equal(await store.get('pending', 'admin:b:normal'), undefined);
  assert.equal((await store.get('pending', 'admin:b:rejected')).status, 'rejected');
  assert.equal((await store.get('meta', 'admin:progress')).after, 'cursor1');
  passed('saveProgress removes projected pending IDs while preserving rejected same-ID evidence');

  await store.stage('admin', event('b:atomic'));
  const db = store.db, original = db.transaction.bind(db);
  db.transaction = (names, ...args) => {
    const tx = original(names, ...args);
    if (Array.isArray(names) && names.includes('cache')) queueMicrotask(() => tx.abort());
    return tx;
  };
  await assert.rejects(store.saveProgress('admin', 'cursor2', 'epoch', [], 0, ['b:atomic']));
  db.transaction = original;
  assert.ok(await store.get('pending', 'admin:b:atomic'));
  assert.equal((await store.get('meta', 'admin:progress')).after, 'cursor1');
  passed('Aborted saveProgress atomically preserves pending evidence and prior cursor');

  const z = 'b:ffffffff-ffff-ffff-ffff-ffffffffffff';
  const m = 'b:88888888-8888-8888-8888-888888888888';
  const a = 'b:00000000-0000-0000-0000-000000000000';
  await store.stage('causal', event(z));
  await store.stage('causal', { ...event(m), recovery_of: z });
  await store.stage('causal', event(a));
  const sameTime = await store.all('pending', 'causal');
  assert.ok(sameTime.every(row => row.at === clock));
  assert.deepEqual(Array.from(sameTime, row => row.value.event.event_id), [a, m, z]);
  const causalRows = sameTime.slice().sort((left, right) => (left.order ?? left.at) - (right.order ?? right.at));
  assert.deepEqual(Array.from(causalRows, row => row.value.event.event_id), [z, m, a]);
  assert.ok(causalRows[0].order < causalRows[1].order && causalRows[1].order < causalRows[2].order);
  const originalAt = causalRows[1].at, originalOrder = causalRows[1].order;
  clock += day;
  await store.update('pending', 'causal:' + m, 'causal', old => ({ ...old, nextCheck: clock + 30000 }));
  const updatedRecovery = (await store.all('pending', 'causal')).find(row => row.key === 'causal:' + m);
  assert.equal(updatedRecovery.at, originalAt);
  assert.equal(updatedRecovery.order, originalOrder);
  passed('Same-millisecond reverse-lexical failure/recovery/recurrence stages in causal order without rewriting at; update preserves order');

  const left = new sandbox.StoreModule.NoticeStore(), right = new sandbox.StoreModule.NoticeStore();
  await left.open(); await right.open();
  await Promise.all([left.stage('concurrent', event(z)), right.stage('concurrent', event(a))]);
  const concurrent = (await left.all('pending', 'concurrent')).sort((x, y) => x.order - y.order);
  assert.equal(concurrent.length, 2);
  assert.equal(concurrent[0].at, concurrent[1].at);
  assert.equal(concurrent[0].order + 1, concurrent[1].order);
  passed('Separate Store connections serialize concurrent same-millisecond stage orders');
  left.close(); right.close(); store.close();
  report.outcome = 'PASS';
})().catch(error => {
  report.outcome = 'FAIL'; report.error = String(error.stack || error); console.error(error); process.exitCode = 1;
}).finally(() => { fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log('Results: ' + output); });
