// Local component regression: no deployed instance, market feed or backend writes.
const { build } = require("esbuild"),
  { chromium } = require("@playwright/test"),
  assert = require("node:assert/strict");
(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ChartAlertsPanel} from './src/advanced/ChartAlertsPanel';import {freshDraft} from './src/advanced/chartAlerts';
const identity={code:'EURUSD',series_kind:'managed',source:'fixture',basis:'bid',timeframe:'H1'};
const config={...freshDraft({instrument:'EURUSD',series_kind:'managed',source:'fixture',timeframe:'H1',price:'1.11935',association:null}),name:'EURUSD 穿过 1.11935',condition:{left:{kind:'price'},right:{kind:'constant',value:'1.11935'},relation:'cross'}};
const row={id:'r1',name:config.name,config,display_identity:identity,display_label:'EURUSD · 自建行情 · bid · H1 · FIXTURE',version:1,control_revision:1,run:1,status:'active',health:'ready',health_reason:null,count:0,max_triggers:1,created_at:1792668882000,updated_at:1792668882000,effective_at:1,condition_summary:'价格 穿过 1.11935',runtime:{}};
let rows=[row,{...row,id:'r2',name:'真实陈旧规则',health:'stale',health_reason:'真实行情陈旧'}];
const event=i=>({id:'e'+i,alert_id:'r1',display_identity:identity,display_label:row.display_label,occurred_at:1791196871000-i*1000,detected_at:1791196871000-i*1000,price:'1.12061',threshold:'1.120610000000000001',evidence:{config:{...config,name:'自定义历史名称',condition:{...config.condition,right:{kind:'constant',value:'1.120610000000000001'}}},ordinal:1,rule_version:1,left:'1.12061',observation:{},alert_created_at:1791182743000},message:'fixture',notification_id:'n'+i,notification_status:'pending',ack_at:null,delivery_status:'pending',notice:{id:'s:e'+i,first_seq:i+1,viewed_at:null,handled_at:null}});
let events=Array.from({length:10},(_,i)=>event(i));events[1].notice.handled_at=1;
const calls=[],writes=[],locates=[];let fail='',hold=false,release;
async function request(path,body){if(body){writes.push({path,body});if(path.endsWith('capabilities'))return {sources:[{source:'fixture',series_kind:'managed',available:true,atr_frames:['H1']}]};if(path.endsWith('lifecycle')){const saved={...rows.find(r=>path.includes(r.id)),status:body.action==='archive'?'archived':'paused',control_revision:2};rows=rows.filter(r=>r.id!==saved.id);if(saved.status!=='archived')rows.push(saved);return saved;}return row;}return structuredClone(path.endsWith('events')?events:rows);}
async function noticeRequest(q){calls.push(q);if(hold&&q.kind==='handled')await new Promise(resolve=>release=resolve);if(q.event_id===fail&&q.kind==='handled')throw Error('fixture rejection');const e=events.find(e=>e.notice?.id===q.event_id);if(e&&q.kind==='viewed')e.notice.viewed_at=Date.now();if(e&&q.kind==='handled')e.notice.handled_at=Date.now();return {ok:true};}
const root=createRoot(document.getElementById('root'));let context=null;
const create=()=>{context={instrument:'EURUSD',series_kind:'managed',source:'fixture',timeframe:'H1',price:'1.11935',request_id:crypto.randomUUID(),association:null,display_identity:identity,display_label:row.display_label};render()};
function render(){root.render(<ChartAlertsPanel workspaceId='reference-test' context={context} open theme='dark' readonly={false} associationNotices={{}} onClose={()=>{}} onRequest={create} onLocate={(...x)=>locates.push(x)} onRows={()=>{}} onDrawingAction={()=>{}} request={request} noticeRequest={noticeRequest} alertUnread={101}/>)}render();
window.t={calls,writes,locates,create,inject(id='new'){const occurred_at=Math.max(...events.map(e=>e.occurred_at))+1000;events.unshift({...event(99),id,occurred_at,detected_at:occurred_at,notice:{id:'s:'+id,first_seq:99,viewed_at:null,handled_at:null}})},fail(id){fail=id},hold(){hold=true},release(){hold=false;release?.()}};
`,
    },
    bundle: true,
    write: false,
    outfile: "fixture.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    }),
    page = await browser.newPage({ viewport: { width: 1100, height: 700 } }),
    errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("PAGEERROR", e.message);
  });
  await page.route("https://alert-component.invalid/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#0f0f0f}#root{position:absolute;right:0;top:0;width:380px;height:250px}</style><div id="root"></div>',
    }),
  );
  async function assertUnreadBehindOverlay(id) {
    await page.locator(".alert-panel-content").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const intersection = await page
      .locator(`[data-signal-id="${id}"]`)
      .evaluate((el) => {
        const row = el.getBoundingClientRect();
        const root = el.closest(".alert-panel-content").getBoundingClientRect();
        return (
          Math.max(
            0,
            Math.min(row.bottom, root.bottom) - Math.max(row.top, root.top),
          ) / row.height
        );
      });
    assert.ok(
      intersection >= 0.5,
      "fixture row must be geometrically in view behind its overlay",
    );
    assert.equal(
      await page.evaluate(
        (id) => t.calls.some((q) => q.event_id === "s:" + id),
        id,
      ),
      false,
      `logs covered by an overlay stay unread after refresh: ${id}`,
    );
  }
  try {
    await page.goto("https://alert-component.invalid/");
    await page.addStyleTag({
      content: bundle.outputFiles.find((f) => f.path.endsWith(".css")).text,
    });
    await page.addScriptTag({
      content: bundle.outputFiles.find((f) => f.path.endsWith(".js")).text,
    });
    await page.getByText("真实陈旧规则", { exact: true }).waitFor();
    assert.equal(await page.locator(".alert-list-count").count(), 0);
    assert.equal(await page.locator(".alert-unread-badge").innerText(), "99+");
    assert.equal(
      await page.evaluate(() => t.calls.length),
      0,
      "alert-list view and background fetch never mark logs read",
    );
    const row = page.locator(".chart-alert-card").first(),
      before = await row.boundingBox();
    await row.locator(".alert-row-summary").click();
    assert.equal(await page.locator(".alert-row-detail").count(), 0);
    assert.equal(await page.evaluate(() => t.locates.length), 1);
    assert.equal((await row.boundingBox()).height, before.height);
    await row.locator(".alert-row-summary").hover();
    await page.getByRole("tooltip").waitFor();
    const tip = await page.getByRole("tooltip").boundingBox();
    assert.ok(tip.x + tip.width <= before.x);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").count(), 0);
    assert.match(
      await page.locator(".alert-state-unhealthy").innerText(),
      /陈旧/,
    );
    await row.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByLabel("比较值", { exact: true })
      .fill("1.123456789012345678");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() =>
      t.writes.some((q) => q.path.endsWith("/edit")),
    );
    assert.equal(
      await page.evaluate(
        () =>
          t.writes.find((q) => q.path.endsWith("/edit")).body.config.condition
            .right.value,
      ),
      "1.123456789012345678",
    );
    await page.getByRole("tab", { name: /日志/ }).click();
    await page.waitForFunction(() => t.calls.some((q) => q.kind === "viewed"));
    assert.equal(
      await page.evaluate(() => t.calls.some((q) => q.event_id === "s:e9")),
      false,
      "offscreen logs stay unread",
    );
    assert.equal(await page.locator('[data-signal-id="e1"]').count(), 0);
    const firstLog = page.locator('[data-signal-id="e0"]');
    await firstLog.locator(".alert-row-summary").hover();
    await page.getByRole("tooltip").waitFor();
    assert.match(await page.getByRole("tooltip").innerText(), /自定义历史名称/);
    assert.match(
      await page.getByRole("tooltip").innerText(),
      /价格 穿过 1\.120610000000000001/,
      "historical summary uses its frozen condition at original precision",
    );
    await page.keyboard.press("Escape");
    await firstLog.getByRole("button", { name: "日志详情" }).click();
    await page.getByRole("menuitem", { name: "查看详情" }).click();
    await page.getByRole("region", { name: "告警详情" }).waitFor();
    await page.evaluate(() => t.inject("behind-detail"));
    await page.locator('[data-signal-id="behind-detail"]').waitFor({
      state: "attached",
      timeout: 7000,
    });
    await assertUnreadBehindOverlay("behind-detail");
    await page.getByRole("button", { name: "关闭详情" }).click();
    await page.waitForFunction(() =>
      t.calls.some(
        (q) => q.event_id === "s:behind-detail" && q.kind === "viewed",
      ),
    );
    await page
      .locator('[data-signal-id="e0"]')
      .getByRole("button", { name: "从日志列表移除" })
      .click();
    await page.getByRole("dialog", { name: "移除 1 条已加载日志？" }).waitFor();
    await page.evaluate(() => {
      t.hold();
      t.inject();
    });
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.waitForFunction(() => t.calls.some((q) => q.kind === "handled"));
    await page.locator('[data-signal-id="new"]').waitFor({
      state: "attached",
      timeout: 7000,
    });
    await assertUnreadBehindOverlay("new");
    assert.equal(
      await page.locator('[data-signal-id="e0"]').count(),
      1,
      "in-flight removal keeps the row",
    );
    await page.evaluate(() => t.release());
    await page.waitForFunction(
      () => !document.querySelector('[data-signal-id="e0"]'),
    );
    assert.equal(await page.locator('[data-signal-id="new"]').count(), 1);
    await page.waitForFunction(() =>
      t.calls.some((q) => q.event_id === "s:new" && q.kind === "viewed"),
    );
    assert.equal(
      await page.evaluate(() =>
        t.calls.some((q) => q.event_id === "s:new" && q.kind === "handled"),
      ),
      false,
    );
    assert.equal(
      await page.evaluate(() => t.writes.some((q) => q.path.includes("/ack"))),
      false,
    );
    await page
      .locator('[data-signal-id="new"]')
      .getByRole("button", { name: "从日志列表移除" })
      .click();
    await page.evaluate(() => t.fail("s:new"));
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('[role="alert"]')?.textContent.includes("未移除"),
    );
    assert.equal(await page.locator('[data-signal-id="new"]').count(), 1);
    await page.getByRole("button", { name: "更多选项" }).click();
    await page
      .getByRole("menuitemcheckbox", { name: "显示已清理日志" })
      .click();
    assert.equal(await page.locator('[data-signal-id="e0"]').count(), 1);
    await page.evaluate(() => t.create());
    await page.getByRole("dialog").waitFor();
    await page.evaluate(() => t.inject("behind-editor"));
    await page.locator('[data-signal-id="behind-editor"]').waitFor({
      state: "attached",
      timeout: 7000,
    });
    await assertUnreadBehindOverlay("behind-editor");
    const persistedDraft = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("mw-chart-alert-draft:reference-test")),
      );
    const price = page.getByLabel("比较值", { exact: true });
    const messageButton = page.getByRole("button", {
      name: "消息",
      exact: true,
    });
    await messageButton.click();
    await page.getByLabel("警报名称", { exact: true }).fill("取消的名称");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await price.fill("1.234567890123456789");
    await page.waitForFunction(() =>
      JSON.parse(
        localStorage.getItem("mw-chart-alert-draft:reference-test"),
      )?.config.name.includes("1.234567890123456789"),
    );
    assert.equal((await persistedDraft()).automaticName, true);
    await messageButton.click();
    await page.getByLabel("警报名称", { exact: true }).fill("Escape取消的名称");
    await page.keyboard.press("Escape");
    await price.fill("1.234567890123456788");
    await page.waitForFunction(() =>
      JSON.parse(
        localStorage.getItem("mw-chart-alert-draft:reference-test"),
      )?.config.name.includes("1.234567890123456788"),
    );
    assert.equal((await persistedDraft()).automaticName, true);
    await messageButton.click();
    await page.getByLabel("消息正文", { exact: true }).fill("只改消息");
    await page.getByRole("button", { name: "应用到草稿", exact: true }).click();
    assert.equal((await persistedDraft()).automaticName, true);
    await messageButton.click();
    await page.getByLabel("警报名称", { exact: true }).fill("保留的自定义名称");
    await page.getByRole("button", { name: "应用到草稿", exact: true }).click();
    await price.fill("1.234567890123456787");
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("mw-chart-alert-draft:reference-test"))
          ?.config.condition.right.value === "1.234567890123456787",
    );
    assert.equal((await persistedDraft()).automaticName, false);
    assert.equal((await persistedDraft()).config.name, "保留的自定义名称");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForFunction(() =>
      t.calls.some(
        (q) => q.event_id === "s:behind-editor" && q.kind === "viewed",
      ),
    );
    await page.setViewportSize({ width: 375, height: 500 });
    await page.locator("#root").evaluate((el) => (el.style.width = "320px"));
    assert.ok(
      await page
        .locator(".chart-alert-panel")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS reference UI: selection, frozen tooltip, badges, exact decimals, overlay-aware reading, captured cleanup, failure recovery and automatic-name apply/cancel",
    );
  } catch (e) {
    require("node:fs").writeFileSync(
      "/tmp/alert-component-failure.html",
      await page.content(),
    );
    await page.screenshot({ path: "/tmp/alert-component-failure.png" });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
