const assert = require("node:assert/strict"),
  { build } = require("esbuild"),
  vm = require("node:vm"),
  { webcrypto } = require("node:crypto");
(async () => {
  const built = await build({
    entryPoints: ["src/notifications/runtime.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Notices",
    platform: "browser",
    plugins: [
      {
        name: "test-api",
        setup(b) {
          b.onLoad({ filter: /\/src\/api\.ts$/ }, () => ({
            contents: `export class ApiError extends Error {constructor(message,status,code){super(message);this.status=status;this.code=code;}} globalThis.TestApiError=ApiError; export const api=(...args)=>globalThis.testAPI(...args);`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const sandbox = {
    console,
    crypto: webcrypto,
    TextEncoder,
    URLSearchParams,
    performance,
    AbortSignal,
    DOMException,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox);
  const Runtime = sandbox.Notices.NoticeRuntime,
    live = {
      id: "s:live",
      version: 1,
      kind: "failure",
      attention: false,
      occurred_at: 1,
      incident_id: "live",
    };
  function fixture(uploadError) {
    const runtime = new Runtime();
    runtime.ready = true;
    runtime.subject = "admin";
    runtime.nextHealth = Infinity;
    runtime.schedule = () => {};
    runtime.nextPrune = Infinity;
    runtime.playCandidates = async () => {};
    runtime.observation = async () => {};
    const pending = new Map([
        [
          "admin:b:test",
          {
            key: "admin:b:test",
            at: 1,
            value: {
              status: "pending",
              event: {
                event_id: "b:test",
                title: "failure",
                context: {},
                evidence: {},
              },
            },
          },
        ],
      ]),
      calls = [];
    runtime.store = {
      remove: async (name, key) => pending.delete(key),
      all: async (name) => (name === "pending" ? [...pending.values()] : []),
      update: async (name, key, subject, fn) => {
        const row = pending.get(key);
        if (row) row.value = fn(row.value);
      },
      saveProgress: async (subject, after, epoch, events) => {
        for (const event of events) pending.delete(subject + ":" + event.id);
      },
    };
    sandbox.testAPI = async (path, body) => {
      calls.push(path);
      if (path === "/notification-center/events" && body) {
        if (uploadError) throw uploadError;
        return { status: "accepted" };
      }
      if (path === "/notification-center/events")
        return {
          events: [],
          after: "baseline",
          epoch: "epoch",
          unread: 0,
          server_time: Date.now(),
        };
      if (path.startsWith("/notification-center/events/"))
        throw new sandbox.TestApiError("awaiting projection", 404, "MISSING");
      if (path.startsWith("/notification-center/changes"))
        return {
          changes: [{ kind: "created", body: live }],
          after: "next",
          epoch: "epoch",
          unread: 1,
          server_time: Date.now(),
          more: false,
        };
      throw Error("unexpected " + path);
    };
    return { runtime, pending, calls };
  }
  for (const status of [409, 413, 422]) {
    const { runtime, pending, calls } = fixture(
      new sandbox.TestApiError("rejected", status, "INVALID"),
    );
    await runtime.cycle(0);
    assert.equal(runtime.state.events[0].id, "s:live");
    assert.equal(pending.get("admin:b:test").value.status, "rejected");
    assert.ok(
      calls.findIndex((x) => x.includes("/changes")) <
        calls.lastIndexOf("/notification-center/events"),
    );
    await runtime.cycle(0);
    assert.equal(
      calls.filter((x) => x === "/notification-center/events").length,
      2,
      "permanent poison must not retry",
    );
  }
  for (const error of [
    new sandbox.TestApiError("limited", 429, "LIMIT"),
    new TypeError("offline"),
  ]) {
    const { runtime, pending } = fixture(error);
    await runtime.cycle(0);
    assert.equal(runtime.state.events[0].id, "s:live");
    assert.equal(pending.get("admin:b:test").value.status, "pending");
  }
  const accepted = fixture();
  await accepted.runtime.cycle(0);
  assert.equal(
    accepted.runtime.state.pending[0].local_status,
    "accepted",
    "accepted intake stays visible before projection",
  );
  const recovery = fixture();
  recovery.pending.get("admin:b:test").value.event.recovery_of = "b:original";
  await recovery.runtime.cycle(0);
  assert.equal(
    recovery.pending.size,
    0,
    "accepted recovery has no projected event ID to await",
  );

  const observations = fixture();
  const rows = new Map(
    Array.from({ length: 11 }, (_, i) => [
      "observation:" + i,
      {
        key: "observation:" + i,
        at: 1,
        value: { pending: true, value: { event_id: "b:" + i } },
      },
    ]),
  );
  const originalAll = observations.runtime.store.all;
  const originalUpdate = observations.runtime.store.update;
  observations.runtime.store.all = async (name) =>
    name === "observations" ? [...rows.values()] : originalAll(name);
  observations.runtime.store.update = async (name, key, subject, fn) => {
    if (name === "observations") rows.get(key).value = fn(rows.get(key).value);
    else await originalUpdate(name, key, subject, fn);
  };
  let validUploads = 0;
  const originalAPI = sandbox.testAPI;
  sandbox.testAPI = async (path, body, signal) => {
    if (path === "/notification-center/observations") {
      if (body.event_id !== "b:10")
        throw new sandbox.TestApiError("missing", 404);
      validUploads++;
      return {};
    }
    return originalAPI(path, body, signal);
  };
  await observations.runtime.cycle(0);
  await observations.runtime.cycle(0);
  assert.equal(
    validUploads,
    1,
    "404 observations rotate so the eleventh can upload",
  );
  assert.equal(rows.get("observation:10").value.pending, false);

  const outsideSummary = fixture();
  outsideSummary.pending.get("admin:b:test").value.status = "accepted";
  const beforeConfirm = sandbox.testAPI;
  sandbox.testAPI = async (path, body, signal) =>
    path === "/notification-center/events/b%3Atest"
      ? { id: "b:test" }
      : beforeConfirm(path, body, signal);
  await outsideSummary.runtime.cycle(0);
  assert.equal(
    outsideSummary.pending.size,
    0,
    "accepted events outside the summary window get independent confirmation",
  );

  const causal = fixture();
  causal.pending.clear();
  for (const [id, order, recovery_of] of [["b:B",3],["b:R",2,"b:A"],["b:A",1]]) {
    causal.pending.set("admin:"+id,{key:"admin:"+id,at:1,order,value:{status:"pending",event:{event_id:id,recovery_of}}});
  }
  const uploads=[];
  const causalAPI=sandbox.testAPI;
  sandbox.testAPI=async(path,body,signal)=>{
    if(path==="/notification-center/events" && body){
      uploads.push(body.event_id);
      if(body.event_id==="b:R")throw new TypeError("response lost or disconnected");
      return {status:"accepted"};
    }
    return causalAPI(path,body,signal);
  };
  await causal.runtime.cycle(0);
  assert.deepEqual(uploads,["b:A","b:R"],"B must not overtake unaccepted recovery R, including timestamp ties");
  causal.runtime.nextUpload=0;
  sandbox.testAPI=async(path,body,signal)=>{
    if(path==="/notification-center/events" && body){uploads.push(body.event_id);return {status:"accepted"};}
    return causalAPI(path,body,signal);
  };
  await causal.runtime.cycle(0);
  assert.deepEqual(uploads,["b:A","b:R","b:R","b:B"],"repeated transport preserves A/recovery/B order");

  const storageFailure = new Runtime();
  storageFailure.ready = true;
  storageFailure.subject = "admin";
  storageFailure.store = {
    get: async () => {
      throw Error("IDB unavailable");
    },
  };
  await storageFailure.resolve({
    source_kind: "workspace",
    code: "SAVE_FAILED",
  });
  assert.match(storageFailure.state.gap, /恢复事实尚未保存/);
  storageFailure.playCandidatesWithClaims = async () => {
    throw Error("claim capacity");
  };
  await storageFailure.playCandidates();
  assert.equal(storageFailure.state.soundLimited, true);

  const runtime = new Runtime();
  runtime.ready = true;
  runtime.subject = "admin";
  runtime.resolve = async () => {
    throw Error("IDB unavailable");
  };
  let reports = 0;
  runtime.report = async () => {
    reports++;
  };
  assert.equal(await runtime.operation({}, async () => 42), 42);
  assert.equal(reports, 0);
  assert.match(runtime.state.gap, /操作已成功/);
  const original = Error("business failure");
  await assert.rejects(
    runtime.operation({}, async () => {
      throw original;
    }),
    (e) => e === original,
  );
  assert.equal(reports, 1);
  const ingress = new Runtime(), durable = new Map(), staged = [];
  ingress.ready = true; ingress.subject = 'admin'; ingress.profile = '00000000-0000-4000-8000-000000000001';
  ingress.schedule = () => {}; ingress.enqueue = () => {};
  ingress.store = {
    get: async (name, key) => durable.get(name + ':' + key),
    update: async (name, key, subject, create) => {
      const id = name + ':' + key, old = durable.get(id), next = create(old);
      if (next !== undefined) durable.set(id, next); return old;
    },
    stage: async (subject, value, observation) => {
      staged.push(value); durable.set('pending:' + subject + ':' + value.event_id, value);
      if (observation) { const key='meta:'+observation.key, old=durable.get(key);
        durable.set(key, observation.value); return old; }
    },
  };
  const fault = {source_kind:'market',attempt_id:'attempt-a',code:'READ_FAILED',title:'读取失败',message:'503',context:{workspace_id:'a',source_id:'owner'}};
  const [firstId,,secondId] = await Promise.all([
    ingress.report(fault), ingress.resolve(fault), ingress.report({...fault,attempt_id:'attempt-b'}),
  ]);
  assert.equal(staged.length,3,'concurrent producer transitions retain failure, recovery and recurrence');
  assert.equal(staged[0].event_id,firstId);
  assert.equal(staged[1].recovery_of,firstId,'recovery cannot overtake its source failure');
  assert.equal(staged[2].event_id,secondId);
  const group = [...durable].find(([key])=>key.startsWith('meta:admin:fault:'))[1];
  assert.equal(group.open,true);assert.equal(group.latest,secondId);
  const resetCase = fixture();
  const regularAPI = sandbox.testAPI;
  let resetOnce = true;
  resetCase.runtime.state.gap = "已有本机记录未能保存";
  sandbox.testAPI = async (path, ...args) => {
    if (path === "/notification-center/health")
      return {at: Date.now(), display_enabled: true, state: "ok"};
    if (resetOnce && path.startsWith("/notification-center/changes")) {
      resetOnce = false;
      throw new sandbox.TestApiError("epoch changed", 409, "NOTICE_RESET");
    }
    return regularAPI(path, ...args);
  };
  await resetCase.runtime.cycle(0);
  assert.match(resetCase.runtime.state.status, /日志已换代/);
  assert.equal(resetCase.runtime.state.gap, "已有本机记录未能保存");
  await resetCase.runtime.cycle(0);
  assert.equal(resetCase.runtime.state.status, "已同步");
  assert.equal(resetCase.runtime.state.gap, "已有本机记录未能保存",
    "successful reset clears transient progress without hiding persistent storage loss");
  // A previous server's signed cursor can fail validation before epoch comparison.
  for (const invalid of [
    new sandbox.TestApiError("无效通知游标", 400, "HISTORY_UNAVAILABLE"),
    new sandbox.TestApiError("cursor invalid", 400, "NOTICE_CURSOR_INVALID"),
  ]) {
    const stale = fixture();
    stale.runtime.after = "old-signed-cursor";
    stale.runtime.state.gap = "已有持久证据";
    const trade = { id: "waiting-trade", source_kind: "chart_alert" };
    stale.runtime.state.bubble = trade;
    stale.runtime.alertQueue = [trade];
    const regular = sandbox.testAPI;
    sandbox.testAPI = async (path, ...args) => {
      if (path.includes("/changes?after=old-signed-cursor")) throw invalid;
      if (path === "/notification-center/health")
        return { at: Date.now(), display_enabled: true, state: "ok" };
      return regular(path, ...args);
    };
    await stale.runtime.cycle(0);
    assert.equal(stale.runtime.after, "", "invalid changes cursor must rebuild baseline");
    assert.equal(stale.pending.get("admin:b:test").value.status, "accepted",
      "a failed changes read must not prevent local intake upload");
    assert.equal(stale.runtime.state.bubble, trade, "waiting trade survives reset");
    assert.equal(stale.runtime.state.gap, "已有持久证据");
    // Isolate the subsequent read from the separate persisted-alert restoration suite.
    stale.runtime.restoreAlerts = async () => {};
    await stale.runtime.cycle(0);
    assert.equal(stale.runtime.after, "next");
    assert.equal(stale.calls.filter(p => p === "/notification-center/events").length, 2,
      "one upload and one fresh baseline; accepted records are not uploaded twice");
  }
  for (const failure of [
    new sandbox.TestApiError("unrelated bad request", 400),
    new sandbox.TestApiError("service unavailable", 503),
  ]) {
    const limited = fixture();
    limited.runtime.after = "current-cursor";
    const regular = sandbox.testAPI;
    sandbox.testAPI = async (path, ...args) => {
      if (path.startsWith("/notification-center/changes")) throw failure;
      return regular(path, ...args);
    };
    await limited.runtime.cycle(0);
    assert.equal(limited.runtime.after, "current-cursor", "arbitrary errors must not reset cursor");
    assert.equal(limited.pending.get("admin:b:test").value.status, "accepted");
  }
  const ordered = fixture();
  ordered.pending.clear();
  for (let i = 0; i < 210; i++) {
    const id = "b:" + String(999 - i);
    ordered.pending.set("admin:" + id, {key:"admin:" + id,at:i,
      value:{status:"pending",event:{event_id:id,occurred_at:i,context:{},evidence:{}}}});
  }
  await ordered.runtime.loadPending(0);
  assert.equal(ordered.runtime.state.pending.length, 200);
  assert.equal(ordered.runtime.state.pending[0].occurred_at, 209,
    "newest evidence is retained regardless of IndexedDB key order");
  assert.equal(ordered.runtime.state.pending.at(-1).occurred_at, 10);
  ordered.pending.clear();
  for (const id of ["a", "c", "b"]) ordered.pending.set(id, {key:id,at:1,
    value:{status:"pending",event:{event_id:id,occurred_at:1,context:{},evidence:{}}}});
  await ordered.runtime.loadPending(0);
  assert.equal(ordered.runtime.state.pending.map(r=>r.id).join(","), "c,b,a");
  const unauthorized = fixture();
  unauthorized.runtime.after = "current-cursor";
  sandbox.testAPI = async () => { throw new sandbox.TestApiError("expired", 401); };
  await unauthorized.runtime.cycle(0);
  assert.equal(unauthorized.pending.get("admin:b:test").value.status, "pending",
    "authentication failure must not continue uploads");

  const preferences = fixture();
  const savedPreferences = new Map();
  const broadcasts = [];
  preferences.runtime.store.update = async (table, key, subject, fn) => {
    const next = fn(savedPreferences.get(key));
    savedPreferences.set(key, next);
  };
  preferences.runtime.channel = {postMessage: value => broadcasts.push(value)};
  assert.equal(preferences.runtime.state.systemPopupSeconds, 3);
  preferences.runtime.state.bubble = {id: "keep-trade", source_kind: "chart_alert"};
  await preferences.runtime.action({action:"system-popup-seconds", seconds:10});
  assert.equal(preferences.runtime.state.systemPopupSeconds,10);
  assert.equal(savedPreferences.get("admin:system-popup-seconds"),10);
  assert.equal(broadcasts[0].seconds,10);
  assert.equal(preferences.runtime.state.bubble.id,"keep-trade","duration cannot dismiss or confirm a trade");
  await preferences.runtime.action({action:"system-popup-seconds", seconds:NaN});
  assert.equal(preferences.runtime.state.systemPopupSeconds,3,"invalid persisted/input duration falls back to 3 seconds");

  const unified = fixture();
  unified.runtime.pop = async () => {};
  unified.runtime.estimateNow = () => 1000;
  const instant = {id:"trade",source_kind:"chart_alert",kind:"alert",severity:"warning",attention:true,occurred_at:1000};
  unified.runtime.state.systemPopups = false;
  unified.runtime.enqueue({...instant,id:"system",source_kind:"workspace"});
  assert.equal(unified.runtime.queue.length,0);
  unified.runtime.state.systemPopups = true;
  unified.runtime.enqueue({...instant,id:"ordinary",source_kind:"workspace",severity:"info"});
  assert.equal(unified.runtime.queue.length,0,"ordinary system records never pop");
  unified.runtime.enqueue({...instant,id:"abnormal",source_kind:"workspace",severity:"error"});
  assert.equal(unified.runtime.queue.length,1);
  unified.runtime.state.bubble = unified.runtime.queue.shift();
  unified.runtime.applySystemPopups(false);
  assert.equal(unified.runtime.state.bubble,null);
  const delayed = fixture();
  sandbox.document = {visibilityState:"visible"};
  delayed.runtime.presentation = true;
  delayed.runtime.estimateNow = () => 40001;
  delayed.runtime.queue = [
    {...instant,id:"expired",source_kind:"workspace",occurred_at:1000},
    {...instant,id:"fresh",source_kind:"workspace",occurred_at:40000},
  ];
  const claimed = [];
  delayed.runtime.store.update = async (_name,key) => {claimed.push(key);};
  await delayed.runtime.pop();
  assert.equal(delayed.runtime.state.bubble.id,"fresh","system messages still respect freshness");
  assert.equal(claimed.length,1);
  const receipts = new Map(Array.from({length:25},(_,i)=> {
    const key="admin:alert-popup:trade-"+i;
    return [key,{key,at:1,value:{event:{...instant,id:"trade-"+i,first_seq:i},confirmed_at:null}}];
  }));
  const tradeRuntime = () => {
    const r=new Runtime();r.ready=true;r.subject="admin";r.presentation=true;
    r.estimateNow=()=>1e12;
    r.store={all:async(name)=>name==="cache"?[...receipts.values()]:[],
      update:async(name,key,subject,fn)=>{const row=receipts.get(key);const old=row?.value;const next=fn(old);if(next!==undefined)row.value=next;return old;}};
    return r;
  };
  const trades=tradeRuntime();
  trades.state.bubble={...instant,id:"passive",source_kind:"workspace"};
  await trades.restoreAlerts(0);await trades.pop();
  assert.equal(trades.state.bubble.id,"trade-0");
  assert.equal(trades.state.alertPending,25);
  trades.enqueue({...instant,id:"during",source_kind:"workspace",severity:"critical"});
  assert.equal(trades.queue.length,0,"system messages during trade confirmation cannot replay");
  trades.dismiss("trade-0");assert.equal(trades.state.bubble.id,"trade-0","dismiss is never trade confirmation");
  const refresh=tradeRuntime();await refresh.restoreAlerts(0);await refresh.pop();
  assert.equal(refresh.state.bubble.id,"trade-0","refresh restores the same pending alert");
  await trades.action({action:"confirm-alert",event_id:"trade-0"});
  assert.equal(trades.state.bubble.id,"trade-1");
  assert.equal(trades.state.alertPending,24);
  await trades.action({action:"confirm-alert",event_id:"trade-0"});
  assert.equal(trades.state.bubble.id,"trade-1","a stale double-click cannot confirm the next alert");
  await refresh.restoreAlerts(0);await refresh.pop();
  assert.equal(refresh.state.bubble.id,"trade-1","same-profile tabs reconcile confirmation");
  assert.equal(receipts.get("admin:alert-popup:trade-0").value.event.viewed_at,undefined);
  assert.equal(receipts.get("admin:alert-popup:trade-0").value.event.handled_at,undefined);
  const preemption = fixture();
  preemption.runtime.presentation = true;
  preemption.runtime.state.bubble = {...instant,id:"passive-before-trade",source_kind:"workspace"};
  const preemptionReceipts = [];
  const preemptionStore = preemption.runtime.store;
  preemption.runtime.store = {
    ...preemptionStore,
    all: async name => name === "cache" ? preemptionReceipts : preemptionStore.all(name),
    saveProgress: async (...args) => {
      await preemptionStore.saveProgress(...args);
      for (const event of args[6] || [])
        preemptionReceipts.push({key:"admin:alert-popup:"+event.id,at:1,value:{event,confirmed_at:null}});
    },
  };
  let uploadStarted, releaseUpload;
  const uploading = new Promise(resolve => {uploadStarted=resolve;});
  const uploadGate = new Promise(resolve => {releaseUpload=resolve;});
  const preemptionAPI = sandbox.testAPI;
  sandbox.testAPI = async (path,body,...args) => {
    if (path.startsWith("/notification-center/changes"))
      return {changes:[{kind:"created",body:{...instant,id:"priority-trade",notify_web:true,first_seq:1}}],
        after:"next",epoch:"epoch",unread:0,server_time:Date.now(),more:false};
    if (path === "/notification-center/events" && body) {
      uploadStarted();
      await uploadGate;
      return {status:"accepted"};
    }
    return preemptionAPI(path,body,...args);
  };
  const preemptionCycle = preemption.runtime.cycle(0);
  await uploading;
  try {
    assert.equal(preemption.runtime.state.bubble?.id,"priority-trade",
      "a persisted live trade immediately replaces a system card before unrelated background uploads complete");
    assert.equal(preemption.runtime.state.alertPending,1);
  } finally {
    releaseUpload();
  }
  await preemptionCycle;
  const offlineStartup = new Runtime();
  offlineStartup.attach = () => {};
  offlineStartup.schedule = () => {};
  sandbox.navigator = {};
  let openStartupStore;
  const startupStoreGate = new Promise(resolve => {openStartupStore=resolve;});
  offlineStartup.store = {
    open: () => startupStoreGate,
    update: async () => "profile",
    prune: async () => ({lost:0}),
    get: async (_name,key) => key === "admin:progress"
      ? {after:"saved-cursor",epoch:"epoch",unread:0} : undefined,
    all: async name => name === "cache"
      ? [{key:"admin:alert-popup:offline-trade",at:1,
        value:{event:{...instant,id:"offline-trade",first_seq:1},confirmed_at:null}}] : [],
  };
  let networkStarted;
  const startupNetwork = new Promise(resolve => {networkStarted=resolve;});
  sandbox.testAPI = async () => {
    networkStarted();
    return new Promise(() => {});
  };
  const startingOffline = offlineStartup.start("admin");
  offlineStartup.setPresentation(true);
  openStartupStore();
  await startingOffline;
  await startupNetwork;
  assert.equal(offlineStartup.state.bubble?.id,"offline-trade",
    "startup restores persisted unconfirmed trades without waiting for the network, even when presentation mounts before IDB opens");
  assert.equal(offlineStartup.state.alertPending,1);
  offlineStartup.pause();
  sandbox.testAPI = async path => {assert.match(path,/audience=system/);return {events:[]};};
  await unified.runtime.action({action:"history",filters:{audience:"alerts"}});
  const counts=fixture();
  const unscoped=sandbox.testAPI;
  sandbox.testAPI=async(path,...args)=>({...await unscoped(path,...args),unread:42,system_unread:2});
  await counts.runtime.cycle(0);
  assert.equal(counts.runtime.state.unread,2,"trading alerts never increase the system-message badge");
  console.log(
    "PASS notification intake isolation, permanent rejection, accepted projection gap and business outcome",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
