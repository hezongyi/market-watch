// Snapshot before local Compose recreation, then compare after.
// MW_SNAPSHOT_MODE=before records hashes only; normal mode verifies full API documents.
// Self-signed TLS is accepted only for this local fixture.
const { chromium } = require("playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 950 },
  });
  await page.goto("https://localhost:15443/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync("../../market-watch/artifacts/local-credentials.json"),
      ).password,
    );
  const login = page.waitForResponse(
    (r) => r.url().endsWith("/api/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录工作台" }).click();
  assert.equal((await login).status(), 200);
  const state = await page.evaluate(async()=>{
    const read=async(path)=>{const r=await fetch(path);if(!r.ok)throw Error(r.status);return r.json()};
    return {workspaces:await read('/api/advanced-charts/workspaces'),preferences:await read('/api/advanced-charts/preferences')};
  });
  assert.ok(state.workspaces.length > 0 && state.preferences.length > 0, "Fixture must contain persisted analysis data");
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
  const snapshot=Object.fromEntries(Object.entries(state).map(([k,v])=>[k,{count:v.length,sha256:require('node:crypto').createHash('sha256').update(JSON.stringify(v.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')}]));
  const path='/tmp/mw-recreate-state.json';
  if(process.env.MW_SNAPSHOT_MODE==='before') fs.writeFileSync(path,JSON.stringify(snapshot),{mode:0o600});
  else assert.deepEqual(snapshot,JSON.parse(fs.readFileSync(path)),"Container rebuild must preserve full workspace/preference contents");
  console.log('RECREATE_STORAGE_SNAPSHOT',snapshot);
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
