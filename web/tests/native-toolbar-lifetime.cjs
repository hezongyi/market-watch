// Exercise the actual licensed toolbar hooks without publishing the distribution.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mw-toolbar-"));
try {
  const file = path.join(temp, "toolset.js");
  fs.copyFileSync(
    path.join(
      root,
      "advanced-host/charting_library/bundles/restricted-toolset.4fbfc823d8551bbb3e53.js",
    ),
    file,
  );
  const patch = path.join(root, "advanced-host/patch-native-toolset.mjs");
  if (fs.existsSync(patch)) {
    execFileSync(process.execPath, [patch, file]);
    const installed = fs.readFileSync(file, "utf8");
    execFileSync(process.execPath, [patch, file]);
    assert.equal(fs.readFileSync(file, "utf8"), installed);
    // Upgrade the actual previous patch, then retain byte verification.
    execFileSync(process.execPath, [patch, file, "--disable"]);
    const legacy = path.join(temp, "legacy.mjs");
    fs.writeFileSync(legacy, execFileSync("git", [
      "show", "v2.0.1:advanced-host/patch-native-toolset.mjs",
    ], {cwd: root}));
    execFileSync(process.execPath, [legacy, file]);
    execFileSync(process.execPath, [patch, file]);
    assert.equal(fs.readFileSync(file, "utf8"), installed);
    const partial = installed.replace('this._mwDisposeSymbolResolved=void 0', '');
    fs.writeFileSync(file, partial);
    assert.notEqual(spawnSync(process.execPath, [patch, file]).status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), partial);
    fs.writeFileSync(file, installed);
    execFileSync(process.execPath, [patch, file, "--disable"]);
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, installed + "\n/* unsupported */");
    assert.notEqual(spawnSync(process.execPath, [patch, file]).status, 0);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      installed + "\n/* unsupported */",
    );
    fs.writeFileSync(file, original);
    execFileSync(process.execPath, [patch, file]);
    assert.equal(fs.readFileSync(file, "utf8"), installed);
  }
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf(
    "componentDidMount(){r.linking.proSymbol.subscribe(this._onSymbolChanged)",
  );
  assert.ok(start >= 0);
  const methods = source.slice(start, source.indexOf("render(){", start));
  for (const enabled of [true, false]) {
    const delegates = [],
      symbolListeners = new Set();
    let current,
      lookups = 0;
    const create = () => {
      const listeners = new Set();
      const delegate = {
        subscribe: (_context, callback) => listeners.add(callback),
        unsubscribe: (_context, callback) =>
          assert.ok(listeners.delete(callback)),
      };
      delegates.push(listeners);
      let ready = false;
      const pending = new Set();
      return {
        hasModel: () => ready,
        modelCreated: () => ({
          subscribe: (_context, cb) => pending.add(cb),
          unsubscribe: (_context, cb) => pending.delete(cb),
        }),
        attach: () => { ready = true; for (const cb of [...pending]) cb(); },
        pending,
        model: () => {
          if (!ready) throw Error("Value is null");
          lookups++;
          return { mainSeries: () => ({ symbolResolved: () => delegate }) };
        },
      };
    };
    const Toolbar = vm.runInNewContext("(class Toolbar {" + methods + "})", {
      r: {
        linking: {
          proSymbol: {
            subscribe: (cb) => symbolListeners.add(cb),
            unsubscribe: (cb) => symbolListeners.delete(cb),
          },
          getChartWidget: () => current,
        },
      },
      n: { isFeaturesetEnabled: () => enabled },
      ea: { SymbolSearchUI: { preload() {} } },
    });
    for (let i = 0; i < 20; i++) {
      current = create();
      const activeListeners = new Set();
      const toolbar = new Toolbar();
      toolbar.context = { chartWidgetCollection: { activeChartWidget: {
        value: () => current,
        subscribe: cb => activeListeners.add(cb),
        unsubscribe: cb => activeListeners.delete(cb),
      } } };
      toolbar._onSymbolChanged = () => {};
      toolbar._onSymbolInfoResolved = () => {};
      toolbar.componentDidMount();
      assert.equal(lookups, i * (enabled ? 1 : 0), "mount must wait for a model");
      const initial = current;
      initial.attach();
      assert.equal(delegates.at(-1).size, enabled ? 1 : 0, "subscribe after model creation");
      const reads = lookups;
      // Saved-layout restore replaces or destroys the currently linked model.
      current =
        i % 2
          ? create()
          : {
              model: () => {
                throw Error("Value is null");
              },
            };
      toolbar.componentWillUnmount();
      assert.equal(lookups, reads, "unmount must not resolve another model");
      assert.equal(symbolListeners.size, 0);
      assert.equal(initial.pending.size, 0, "model readiness listener is released");
      assert.equal(activeListeners.size, 0, "active chart listener is released");
      assert.ok(
        delegates.every((listeners) => listeners.size === 0),
        "no leaked delegate",
      );
    }
  }
  console.log(
    "Toolbar: pending/attached model, destroyed/replaced model, feature disabled, repeated lifetimes and legacy upgrade passed",
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
