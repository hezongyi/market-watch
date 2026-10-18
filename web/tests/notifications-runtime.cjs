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
    stage: async (subject, value) => {
      staged.push(value); durable.set('pending:' + subject + ':' + value.event_id, value);
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
  console.log(
    "PASS notification intake isolation, permanent rejection, accepted projection gap and business outcome",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
