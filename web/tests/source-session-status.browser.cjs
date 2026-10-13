// Replay captured source-state fields on the built Ubuntu data-center page.
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const base = process.env.MW_SOURCE_STATUS_URL || "http://127.0.0.1:20282";
const capture = process.env.MW_SOURCE_STATUS_CAPTURE;
const credentials = process.env.MW_SOURCE_STATUS_CREDENTIALS;
if (!capture || !credentials) throw new Error("Supply restricted capture and development credential paths");

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MW_CHROMIUM_PATH ? { executablePath: process.env.MW_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const payload = JSON.parse(fs.readFileSync(capture, "utf8"));
  try {
    await page.route("**/api/market-data/live/status", route => route.fulfill({ json: payload }));
    const login = await page.request.post(`${base}/api/login`, { data: JSON.parse(fs.readFileSync(credentials, "utf8")) });
    expect(login.ok()).toBeTruthy();
    const harness = `${base}/session-harness`;
    await page.route(harness, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><link rel="stylesheet" href="/data-center-native.css"></head><body style="margin:0"><div id="center"></div><script src="/data-center-native.js"></script><script>MWNativeCenter.mount(document.getElementById('center'), {ui:null,context:{workspace:'source-state-test',target:'test-chart',theme:'dark',symbolSync:false,intervalSync:false,location:'/market-data?tab=sources'},post(){},subscribe(){return ()=>{};},request:async(path)=>{const response=await fetch('/api'+path);if(!response.ok)throw Error('status '+response.status);return response.json();}});</script></body></html>` }));
    await page.goto(harness);
    const center = page.locator("#center");
    await expect(center.locator(".dc-source-session").first()).toHaveText("已核实交易时段", { timeout: 20000 });
    await expect(center.getByText("时段尚未核实", { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(center.locator(".dc-source-session").first()).toBeVisible();
    const output = process.env.MW_SOURCE_STATUS_EVIDENCE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, "source-session-mobile.png"), fullPage: true });
      fs.writeFileSync(path.join(output, "source-session-browser.json"), JSON.stringify({
        host: "Ubuntu local Docker", base, captured_market_session: payload.datasets[0].market_session,
        captured_calendar_verified: payload.datasets[0].calendar_verified,
        displayed: await center.locator(".dc-source-session").first().innerText(), errors,
      }, null, 2) + "\n");
    }
    expect(errors).toEqual([]);
    console.log("PASS: built source-status page displays verified scheduled_open on desktop and mobile.");
  } catch (error) {
    const output = process.env.MW_SOURCE_STATUS_EVIDENCE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "browser-failure.private.json"), JSON.stringify({
        errors, frames: await Promise.all(page.frames().map(async frame => ({
          url: frame.url(), text: (await frame.locator("body").innerText().catch(() => "")).slice(0, 5000),
        }))),
      }, null, 2));
    }
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
