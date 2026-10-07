// Verify vendor integrity, upgrade from the actual v1.12.0 patcher, idempotence
// and byte-for-byte rollback. The private bundle is never written into Git.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-maximize-patch-"));
const file = path.join(dir, "native.js");
const patcher = path.join(root, "advanced-host/patch-native-reserve.mjs");
const hash = () => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (...args) => execFileSync(process.execPath, [patcher, file, ...args], {encoding:"utf8"});
try {
  fs.copyFileSync(path.join(root,"advanced-host/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js"),file);
  run("--disable");
  const original = hash();
  assert.equal(original,"114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1");
  const old = path.join(dir,"production.mjs");
  fs.writeFileSync(old,execFileSync("git",["show","v1.12.0:advanced-host/patch-native-reserve.mjs"],{cwd:root}));
  execFileSync(process.execPath,[old,file]);
  const production = hash();
  run();
  const upgraded = hash();
  assert.notEqual(upgraded,production);
  run();
  assert.equal(hash(),upgraded);
  run("--disable");
  assert.equal(hash(),original);
  run();
  assert.equal(hash(),upgraded);
  fs.appendFileSync(file,"\n// unsupported mutation\n");
  const tampered=hash();
  const bad=spawnSync(process.execPath,[patcher,file],{encoding:"utf8"});
  assert.notEqual(bad.status,0);
  assert.match(bad.stderr,/Unsupported licensed bundle/);
  assert.equal(hash(),tampered);
  console.log("PASS: verified original, v1.12 upgrade, idempotence, exact rollback, clean install, tamper refusal");
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
