const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const bridge = fs.readFileSync(
  process.env.MW_BRIDGE_BASE || "../advanced-host/chart-runtime.js",
  "utf8",
);
const producers = bridge.slice(
  bridge.indexOf("function emitNotice("),
  bridge.indexOf("// Each live request owner"),
);
const adapterStart = bridge.indexOf("  const prefs = ");
assert.ok(adapterStart >= 0, "production preference adapter must be located");
const adapter = bridge.slice(
  adapterStart,
  bridge.indexOf(
    "  autoSave?.dispose();",
    adapterStart,
  ),
);

(async () => {
  for (const readonly of [false, true]) {
    const sent = [],
      writes = [];
    let fail = true;
    const sandbox = vm.createContext({
      Map,
      Promise,
      JSON,
      Error,
      crypto: webcrypto,
      readonly,
      preferences: [],
      alertUIWorkspace: "isolated-workspace",
      alertUISession: "session",
      workspaceEpoch: 7,
      send: (message) => sent.push(message),
      request: async ({ op, args }) => {
        if (op === "read") return [];
        if (op.startsWith("draft")) return true;
        writes.push(op);
        if (fail)
          throw Object.assign(Error("scoped write failure"), { status: 503 });
        return { ...args, id: "saved", revision: 1 };
      },
    });
    vm.runInContext(
      fs.readFileSync("../advanced-host/preferences.js", "utf8") +
        "\n" +
        producers +
        "\n" +
        adapter +
        "\nglobalThis.testPrefs=prefs;",
      sandbox,
    );
    await assert.rejects(
      sandbox.testPrefs.templates.saveStudyTemplate({
        name: "acceptance-template",
        content: "{}",
      }),
      /设置未保存/,
    );
    assert.equal(sent.length, 1, "one final adapter failure");
    const message = sent[0];
    assert.equal(
      message.type,
      "notice-source",
      "failure must reach the visible notification runtime",
    );
    assert.equal(message.fault.title, "设置未保存");
    assert.match(message.fault.message, /设置未保存/);
    assert.equal(message.fault.source_kind, "preferences");
    assert.equal(message.epoch, 7);
    assert.match(message.fault.context.source_id, /acceptance-template/);
    assert.equal(
      writes.length,
      readonly ? 0 : 1,
      "readonly sends no write and uncertain writes are not retried",
    );
    if (!readonly) {
      fail = false;
      await sandbox.testPrefs.templates.saveStudyTemplate({
        name: "acceptance-template",
        content: "{}",
      });
      assert.equal(
        sent[1].recovered,
        true,
        "successful save closes only its own observation",
      );
      assert.equal(
        sent[1].fault.context.source_id,
        message.fault.context.source_id,
      );
      fail = true;
      await assert.rejects(
        sandbox.testPrefs.savePreference("setting", "mw.theme", "Dark"),
        /设置未保存/,
      );
      assert.equal(
        sent[2].type,
        "notice-source",
        "direct setting writes use the same visible failure path",
      );
      assert.match(sent[2].fault.context.source_id, /mw.theme/);
      sandbox.reportPreferenceOutcome(null, {
        kind: "study",
        name: "acceptance-template",
        operation: "delete",
      });
      assert.notEqual(
        sent[3].fault.context.source_id,
        message.fault.context.source_id,
        "delete cannot recover a save failure",
      );
    }
  }
  for (const successful of [false, true]) {
    const sent = [];
    let finish, started;
    const began = new Promise((resolve) => (started = resolve));
    const sandbox = vm.createContext({
      Map,
      Promise,
      JSON,
      Error,
      crypto: webcrypto,
      readonly: false,
      preferences: [],
      alertUIWorkspace: "old-workspace",
      alertUISession: "old-session",
      workspaceEpoch: 7,
      send: (message) => sent.push(message),
      request: async ({ op, args }) => {
        if (op === "read") return [];
        if (op.startsWith("draft")) return true;
        started();
        return new Promise((resolve, reject) => {
          finish = () =>
            successful
              ? resolve({ ...args, id: "saved", revision: 1 })
              : reject(Error("late failure"));
        });
      },
    });
    vm.runInContext(
      fs.readFileSync("../advanced-host/preferences.js", "utf8") +
        "\n" +
        producers +
        "\n" +
        adapter +
        "\nglobalThis.testPrefs=prefs;",
      sandbox,
    );
    const pending = sandbox.testPrefs
      .savePreference("setting", "mw.theme", "Dark")
      .catch(() => {});
    await began;
    sandbox.alertUIWorkspace = "new-workspace";
    sandbox.alertUISession = "new-session";
    sandbox.workspaceEpoch = 8;
    finish();
    await pending;
    assert.equal(
      sent.length,
      0,
      "late completion cannot report or recover in a different workspace/epoch",
    );
  }
  console.log(
    "PASS native preference adapter → actual bridge → visible notice, network failure and readonly, one final report",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
