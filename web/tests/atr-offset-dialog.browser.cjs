// Shipped React form in Chromium with a captured API fixture; no service deployment.
const { chromium } = require("@playwright/test");
const { build } = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const output = process.env.MW_ATR_UI_OUTPUT || "/tmp/mw-atr-offset-ui";

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const bundle = await build({
    stdin: { resolveDir: path.join(root, "web"), loader: "tsx", contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {ChartAlertDialog} from './src/advanced/ChartAlertDialog';
      import {freshDraft} from './src/advanced/chartAlerts';
      const initial=freshDraft({instrument:'BTCUSDT',series_kind:'managed',source:'binance',timeframe:'H4',
        price:'100',association:null});
      const writes=[]; window.writes=writes;
      const request=async(path,body)=>{
        if(path.endsWith('/capabilities'))return {sources:[{source:'binance',series_kind:'managed',available:true,
          basis:'last',observation_basis:'fixture',reason:null,atr_frames:['H1','H4','D1']}],modes:['close','intrabar'],indicators:['SMA','EMA','RSI','MACD']};
        if(path.endsWith('/geometry'))return {...body,mapping_version:'bar-index-v1',points:body.points.map((p,index)=>({...p,index}))};
        writes.push(structuredClone(body));return {id:'fixture',version:1,config:body.config};
      };
      let generation=0;const root=createRoot(document.getElementById('root'));
      window.render=(config=initial,editing=null,theme='dark')=>root.render(<ChartAlertDialog key={++generation}
        initial={config} requestId='fixture' editing={editing} theme={theme} request={request}
        onSaved={row=>{window.saved=row;}} onClose={()=>{}} onDraft={value=>{window.draft=value;}}/>);
      window.render();
    ` },
    bundle: true, write: false, format: "iife", jsx: "automatic",
  });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("https://atr-dialog.invalid/**", route => route.fulfill({
      contentType: "text/html", body: `<html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>${fs.readFileSync(path.join(root, "web/src/advanced/chart-alerts.css"), "utf8")}</style>
        <div id="root"></div><script>${bundle.outputFiles[0].text}</script></html>`,
    }));
    await page.goto("https://atr-dialog.invalid/");
    const select = label => page.getByLabel(label, { exact: true });
    assert.equal(await select("突破阈值").inputValue(), "none");
    await select("突破阈值").selectOption("atr");
    assert.equal(await select("ATR K线周期").inputValue(), "D1");
    assert.equal(await select("ATR 计算长度").inputValue(), "14");
    assert.equal(await select("ATR 乘数").inputValue(), "0.2");
    await select("ATR K线周期").selectOption("H1");
    await select("ATR 计算长度").fill("20");
    await select("ATR 乘数").fill("0.35");
    await select("关系").selectOption("cross_down");
    assert.equal(await select("ATR 乘数").inputValue(), "0.35", "changing relation keeps the offset");
    await page.getByRole("button", { name: "创建告警", exact: true }).click();
    await page.waitForFunction(() => window.writes.length === 1);
    const saved = await page.evaluate(() => window.writes[0].config);
    assert.equal(saved.timeframe, "H4");
    assert.equal(saved.condition.offset.timeframe, "H1");
    assert.equal(saved.condition.offset.period, 20);
    assert.equal(saved.condition.offset.multiplier, "0.35");
    await page.evaluate(config => window.render(config, { id: "fixture", version: 1 }), saved);
    assert.equal(await select("ATR K线周期").inputValue(), "H1");
    assert.equal(await select("ATR 乘数").inputValue(), "0.35");
    await select("ATR 乘数").fill("0");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    assert.equal(await page.evaluate(() => window.writes.length), 1, "zero multiplier fails form validation");
    await select("ATR 乘数").fill("0.35");
    for (const [theme, width] of [["dark", 1280], ["light", 375]]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(({ config, theme }) => window.render(config, { id: "fixture", version: 1 }, theme), { config: saved, theme });
      await select("ATR 乘数").waitFor();
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await select("突破阈值").selectOption("none");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await page.waitForFunction(() => window.writes.length === 2);
    assert.equal(await page.evaluate(() => window.writes[1].config.condition.offset), null);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({
      scope: "Ubuntu Chromium, shipped React form, synthetic captured API; no deployed application acceptance",
      passed: ["default off", "D1/14/0.2 defaults", "smaller timeframe", "relation preserves offset", "serialized save/edit",
        "zero rejected", "dark desktop", "light 375px", "disable offset"], errors,
    }, null, 2));
    console.log(`ATR form checks passed; evidence: ${output}/report.json`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
