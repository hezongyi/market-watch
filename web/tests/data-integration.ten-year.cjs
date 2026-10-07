// Validate the published ten-year identities and resume their actual pinned runs.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const root = path.resolve(__dirname, "../..");
  const base = "http://127.0.0.1:16589";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const credential = JSON.parse(fs.readFileSync(path.join(root, "artifacts/data-integration/login.json")));
  const evidence = JSON.parse(fs.readFileSync(path.join(root, "docs/verification/data-integration/ten-year-replays.json")));
  const errors = [];
  page.on("pageerror", error => errors.push(error.name));
  const results = [];
  let stage = "login";
  try {
    await page.goto(base);
    await page.getByLabel("管理员密码").fill(credential.password);
    await page.getByRole("button", { name: "登录工作台" }).click();
    await expect(page.getByLabel("管理员密码")).not.toBeVisible();
    for (const run of evidence.runs) {
      stage = run.symbol + " published-version-link";
      console.log(JSON.stringify({ stage }));
      await page.goto(base + "/market-data");
      const link = page.locator(`a[href="/replay?dataset_version=${run.version}"]`);
      await expect(link).toBeVisible();
      await expect(link.locator("..")).toContainText("published");
      await link.click();
      stage = run.symbol + " version-selection";
      console.log(JSON.stringify({ stage }));
      await expect(page.getByLabel("不可变历史版本")).toHaveValue(run.version);
      const datasets = await page.evaluate(async () => (await fetch("/api/market-data/datasets")).json());
      const actualIdentity = datasets.find(dataset => Object.entries(run.identity)
        .every(([key, value]) => dataset.identity[key] === value));
      await expect(page.getByLabel("品种")).toHaveValue(actualIdentity.instrument_id);
      const reply = page.waitForResponse(r => r.url().endsWith("/api/replays/" + run.run));
      stage = run.symbol + " saved-run-selection";
      console.log(JSON.stringify({ stage }));
      await page.getByLabel("已保存的演练").selectOption(run.run);
      const loaded = await (await reply).json();
      stage = run.symbol + " render-pinned-run";
      console.log(JSON.stringify({ stage }));
      expect(loaded.dataset_version).toBe(run.version);
      expect(loaded.input_manifest.checksum).toBe(run.manifest_checksum);
      await expect(page.locator("canvas").first()).toBeVisible();
      expect(loaded.bars.every(bar => bar.end <= loaded.cursor)).toBeTruthy();
      results.push({ symbol: run.symbol, version: run.version, run: run.run,
        warmup_bar_count: loaded.warmup_bar_count, visible_bars: loaded.bars.length,
        future_hidden: true, manifest_matched: true });
    }
    expect(errors).toEqual([]);
    fs.writeFileSync(path.join(root, "docs/verification/data-integration/ten-year-browser.json"),
      JSON.stringify({ host: "Ubuntu Chromium + isolated Docker", runs: results, errors, passed: true }, null, 2) + "\n");
  } catch (error) {
    const selects = await page.locator("select").evaluateAll(elements => elements.map(element => ({ value: element.value,
      label: element.closest("label")?.firstChild?.textContent?.trim() })));
    const failure = { host: "Ubuntu Chromium", stage, error_type: error.name, page_errors: errors, selects, passed: false };
    fs.writeFileSync(path.join(root, "artifacts/data-integration/ten-year-browser-failure.json"),
      JSON.stringify(failure, null, 2));
    await page.screenshot({ path: path.join(root, "artifacts/data-integration/ten-year-browser-failure.png"), fullPage: true });
    console.log(JSON.stringify(failure));
    throw error;
  } finally {
    await browser.close();
  }
})().catch(() => { console.error("Ten-year browser verification failed; no credentials logged"); process.exit(1); });
