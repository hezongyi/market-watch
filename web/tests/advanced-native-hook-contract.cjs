// Verify installation and resource URLs using only a private temporary copy.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const host = path.join(root, "advanced-host");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mw-native-contract-"));
const file = path.join(temp, "library.js");
const patch = path.join(host, "patch-native-reserve.mjs");
const digest = (source) =>
  crypto.createHash("sha256").update(source).digest("hex");
const run = (...args) =>
  execFileSync(process.execPath, [patch, file, ...args], { encoding: "utf8" });
try {
  fs.copyFileSync(
    path.join(host, "charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js"),
    file,
  );
  run("--disable");
  const original = fs.readFileSync(file, "utf8");
  assert.equal(
    digest(original),
    "114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1",
  );
  run();
  const installed = fs.readFileSync(file, "utf8");
  assert.notEqual(digest(installed), digest(original));
  assert.ok(installed.includes('Object.assign(this._chartWidgetCollection.state('));
  assert.ok(installed.includes('_mwBarRangeMapping:globalThis.parent.MWBarRangeMapping.snapshot()'));

  run();
  assert.equal(fs.readFileSync(file, "utf8"), installed);
  run("--disable");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  // Complete v1.7.0 hooks must migrate, without trusting arbitrary bytes.
  const legacy = path.join(temp, "legacy.mjs");
  fs.writeFileSync(
    legacy,
    execFileSync(
      "git",
      ["show", "62488c6:advanced-host/patch-native-reserve.mjs"],
      { cwd: root },
    ),
  );
  execFileSync(process.execPath, [legacy, file]);
  run();
  assert.equal(fs.readFileSync(file, "utf8"), installed);
  run('--disable');
  const navigation = path.join(temp,'navigation.mjs');
  fs.writeFileSync(navigation,execFileSync('git',['show','2041869:advanced-host/patch-native-reserve.mjs'],{cwd:root}));
  execFileSync(process.execPath,[navigation,file]); run();
  assert.equal(fs.readFileSync(file,'utf8'),installed);
  run('--disable');
  for (const ref of ['v1.8.0', 'ed149e1']) {
    const known = path.join(temp, ref.replaceAll('.', '-') + '.mjs');
    fs.writeFileSync(known, execFileSync('git', ['show', ref + ':advanced-host/patch-native-reserve.mjs'], {cwd:root}));
    execFileSync(process.execPath, [known, file]);
    run();
    assert.equal(fs.readFileSync(file, 'utf8'), installed);
    run('--disable');
  }
  run();
  assert.ok(installed.includes('timeScaleUpdated(this)'));
  assert.ok(installed.includes('engineRangeCurrent()'));
  assert.ok(installed.includes('admitCheckpoint(i,e)'));
  // The earlier sync-settings candidate has pause/zoom hooks but no logical
  // Undo routing or save-revision cleanup. Upgrade those exact known bytes.
  const previousSync = installed
    .replace('if(globalThis.parent?.MWNativeSync?.handleChoice(this,"date",e,Cf))return;', '')
    .replace('if(globalThis.parent?.MWNativeSync?.handleChoice(this,"time",e,Tf))return;', '')
    .replace('_handleChartSaved(e){e&&this._setContentHasChanges(globalThis.parent?.MWNativeSave?.hasUnsavedChanges()===true)}',
      '_handleChartSaved(e){e&&this._setContentHasChanges(!1)}');
  fs.writeFileSync(file, previousSync);
  run();
  assert.equal(fs.readFileSync(file, 'utf8'), installed);
  // A partial installation and an unrelated byte change must fail atomically.
  for (const invalid of [
    installed.replace(
      "globalThis.parent?.MWNativeNavigation?.bindModel(t);",
      "",
    ),
    installed + "\n/* unknown bytes */",
  ]) {
    fs.writeFileSync(file, invalid);
    assert.notEqual(spawnSync(process.execPath, [patch, file]).status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), invalid);
  }
  const assets = path.join(temp, "assets");
  fs.mkdirSync(assets);
  for (const entry of fs.readdirSync(host)) {
    if (
      (entry.endsWith(".js") && !entry.startsWith("host.")) ||
      ["index.html", "build-assets.mjs"].includes(entry)
    )
      fs.copyFileSync(path.join(host, entry), path.join(assets, entry));
  }
  fs.mkdirSync(path.join(assets, "charting_library/bundles"), {
    recursive: true,
  });
  const assetBundle = path.join(
    assets,
    "charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js",
  );
  for (const source of [original, installed]) {
    fs.writeFileSync(assetBundle, source);
    execFileSync(process.execPath, [path.join(assets, "build-assets.mjs")]);
    const html = fs.readFileSync(path.join(assets, "index.html"), "utf8");
    const version = digest(source).slice(0, 16);
    assert.ok(
      html.includes(`/charting_library_${version}/charting_library.js`),
    );
    const hostFile = html.match(/src="\/(host\.[a-f0-9]+\.js)"/)[1];
    assert.ok(
      fs
        .readFileSync(path.join(assets, hostFile), "utf8")
        .includes(`MW_CHART_LIBRARY_PATH="/charting_library_${version}/"`),
    );
    assert.equal((html.match(/src="\/host\./g) || []).length, 1);
  }
  console.log(
    "Original, legacy, idempotent, partial/tampered, disable and distinct cache URL contracts passed",
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
