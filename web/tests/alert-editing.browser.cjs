// Actual React dialog/panel with controlled server replies; no user workspace.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright");
(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ChartAlertsPanel} from './src/advanced/ChartAlertsPanel';
 import {ChartAlertDialog} from './src/advanced/ChartAlertDialog';
 import {responseError} from './src/apiErrors';
 import {freshDraft,normalizeCondition,eventPresentation} from './src/advanced/chartAlerts';
 import {useAlertData} from './src/advanced/useAlertData';
 const config=freshDraft({request_id:'test',instrument:'EURUSD',series_kind:'managed',source:'fixture',timeframe:'H1',price:'101',association:null});
 const row={id:'rule',name:'中文历史名称',version:2,control_revision:2,run:1,status:'paused',health:'ready',health_reason:null,count:0,max_triggers:1,effective_at:1,created_at:1,updated_at:1,config,condition_summary:'上穿 101',runtime:{}};
 const event={id:'evt',alert_id:'rule',occurred_at:1700000000000,detected_at:1700000000000,evidence:{config:{...config,name:'中文历史名称'},rule_version:2,ordinal:1,left:'102',observation:{}},message:'body message',threshold:'101',price:'102',notification_status:'web_only'};
 let root, mode, options={}, current={...row},hold=false, held=[],writes=[],bridgeRows=[];
 async function request(path,body){
 if(path==='/chart-alerts/capabilities')return {sources:[{source:'fixture',series_kind:'managed',available:true,atr_frames:['H1']}],modes:['close'],indicators:[]};
 if(body){writes.push({path,body});if(options.failure){const failure=options.failure;options.failure=null;throw responseError(failure.detail,failure.status)}if(path.endsWith('/edit')){if(body.version!==current.version)throw responseError('告警已被其他窗口修改',409);current={...current,version:current.version+1,control_revision:current.control_revision+1,config:body.config};return structuredClone(current)}if(path.endsWith('/lifecycle')){current={...current,control_revision:current.control_revision+1,status:body.action==='archive'?'archived':body.action==='pause'?'paused':'active'};}return structuredClone(current)}
 if(options.listFailure && path==='/chart-alerts'){options.listFailure=false;throw Error('读取失败，请重试')}
 if(path.endsWith('/events'))return options.slowEvents ? new Promise(()=>{}) : [event];
 if(path==='/chart-alerts/rule')return structuredClone(current);
 const result=structuredClone(options.stale ? [row] : [current]);if(hold)return new Promise(resolve=>held.push(()=>resolve(result)));return result;
 }
 function Probe(){const data=useAlertData(request,rows=>bridgeRows=rows);window.probe=data;React.useEffect(()=>{data.refresh()},[]);return null;}
 function View(){if(mode==='data')return <Probe/>;return mode==='dialog'?<ChartAlertDialog initial={options.config||config} theme='dark' requestId='save' editing={null} onDraft={()=>{}} onSaved={()=>{}} onClose={()=>{}} request={request}/>:<ChartAlertsPanel workspaceId={options.workspace||'test'} context={null} open theme='dark' readonly={false} associationNotices={{}} onClose={()=>{}} onRequest={()=>{}} onLocate={()=>{}} onRows={rows=>bridgeRows=rows} onDrawingAction={()=>{}} request={request}/>}
 window.test={config,row,event,writes,normalizeCondition,eventPresentation,external(){current={...current,version:7,control_revision:8}},get held(){return held},get bridgeRows(){return bridgeRows},hold(){hold=true},release(){hold=false;held.splice(0).forEach(fn=>fn())},mount(m,o={}){if(root)root.unmount();localStorage.clear();mode=m;options=o;current={...structuredClone(row),status:o.status||row.status};writes.length=0;held=[];hold=false;root=createRoot(document.getElementById('root'));root.render(<View/>);},rerender(o){options=o;root.render(<View/>);}};
 `,
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  const page = await browser.newPage();
  await page.route("http://localhost/", (r) =>
    r.fulfill({ body: '<div id="root"></div>', contentType: "text/html" }),
  );
  await page.goto("http://localhost/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  page.setDefaultTimeout(5000);
  const failures = [];
  async function check(name, fn) {
    try {
      await fn();
      console.log("PASS", name);
    } catch (e) {
      failures.push(name + ": " + e.message);
      console.error("FAIL", name, e.message);
      require("fs").writeFileSync(
        "/tmp/mw88-failure.html",
        await page.content(),
      );
    }
  }
  try {
    await check(
      "all range/single switches and restored drafts submit mutually exclusive payloads",
      async () => {
        for (const range of ["enter", "exit", "break_upper", "break_lower"])
          for (const single of [
            "cross",
            "cross_up",
            "cross_down",
            "above",
            "below",
          ]) {
            await page.evaluate(
              (range) =>
                test.mount("dialog", {
                  config: {
                    ...test.config,
                    condition: {
                      relation: range,
                      left: { kind: "price" },
                      lower: "90.12345",
                      upper: "110.123",
                    },
                  },
                }),
              range,
            );
            await page.getByLabel("关系", { exact: true }).selectOption(single);
            await page.getByLabel("比较值", { exact: true }).fill("0");
            await page
              .getByRole("button", { name: "创建告警", exact: true })
              .click();
            await page.waitForFunction(() => test.writes.length);
            let c = await page.evaluate(
              () => test.writes.at(-1).body.config.condition,
            );
            assert.equal(c.right.value, "0");
            assert.equal(c.lower, undefined);
            assert.equal(c.upper, undefined);
            await page.getByLabel("关系", { exact: true }).selectOption(range);
            await page.getByLabel("下限", { exact: true }).fill("1.12345");
            await page.getByLabel("上限", { exact: true }).fill("2.123");
            await page
              .getByRole("button", { name: "创建告警", exact: true })
              .click();
            await page.waitForFunction(() => test.writes.length === 2);
            c = await page.evaluate(
              () => test.writes.at(-1).body.config.condition,
            );
            assert.equal(c.lower, "1.12345");
            assert.equal(c.upper, "2.123");
            assert.equal(c.right, undefined);
            assert.equal(c.offset, undefined);
          }
        await page.evaluate(() =>
          test.mount("dialog", {
            config: {
              ...test.config,
              condition: {
                relation: "cross_up",
                left: { kind: "price" },
                right: { kind: "constant", value: "1.12345" },
                lower: "dirty",
                upper: "dirty",
              },
            },
          }),
        );
        await page
          .getByRole("button", { name: "创建告警", exact: true })
          .click();
        await page.waitForFunction(() => test.writes.length);
        assert.equal(
          await page.evaluate(() => test.writes[0].body.config.condition.lower),
          undefined,
        );
      },
    );
    await check(
      "saved authoritative row survives a stale GET and immediate second edit",
      async () => {
        await page.evaluate(() => test.mount("panel"));
        await page.getByRole("button", { name: "编辑", exact: true }).waitFor();
        await page.evaluate(() => {
          test.hold();
        });
        await page.waitForFunction(() => test.held.length > 0, undefined, {
          timeout: 7000,
        });
        await page.getByRole("button", { name: "编辑", exact: true }).click();
        await page
          .getByRole("button", { name: "保存新版本", exact: true })
          .click();
        await page.locator("dialog").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "编辑", exact: true }).click();
        await page
          .getByRole("button", { name: "保存新版本", exact: true })
          .click();
        await page.waitForFunction(() => test.writes.length === 2);
        assert.deepEqual(
          await page.evaluate(() => test.writes.map((w) => w.body.version)),
          [2, 3],
        );
        await page.evaluate(() => test.release());
        await page.waitForFunction(() => test.bridgeRows[0]?.version === 4);
        assert.equal(await page.evaluate(() => test.bridgeRows[0].version), 4);
      },
    );
    await check("slow events do not delay rule edits", async () => {
      await page.evaluate(() => test.mount("panel", { slowEvents: true }));
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      await page
        .getByRole("button", { name: "保存新版本", exact: true })
        .click();
      await page.waitForFunction(() => test.bridgeRows[0]?.version === 3);
    });
    await check(
      "field validation focuses the invalid input without raw body or duplicate prefixes",
      async () => {
        await page.evaluate(() =>
          test.mount("dialog", {
            failure: {
              status: 422,
              detail: [
                {
                  type: "decimal_parsing",
                  loc: ["body", "config", "condition", "right", "value"],
                  msg: "Input should be a valid decimal",
                  input: "PRIVATE_INPUT",
                },
              ],
            },
          }),
        );
        await page.getByLabel("比较值", { exact: true }).fill("abc");
        await page
          .getByRole("button", { name: "创建告警", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute("aria-label") === "比较值" &&
            document.activeElement?.getAttribute("aria-invalid") === "true",
        );
        assert.ok(await page.getByRole("alert").innerText());
        assert.equal(
          (await page.getByRole("alert").innerText()).includes("PRIVATE_INPUT"),
          false,
        );
        assert.equal(
          (await page.getByRole("alert").innerText()).includes("ApiError"),
          false,
        );
        assert.equal(
          await page
            .getByLabel("比较值", { exact: true })
            .getAttribute("aria-describedby"),
          "alert-validation-error",
        );
      },
    );
    await check(
      "real competing version retains draft until explicit reload and save",
      async () => {
        await page.evaluate(() => test.mount("panel"));
        await page.getByRole("button", { name: "编辑", exact: true }).click();
        await page.getByLabel("比较值", { exact: true }).fill("123.12345");
        await page.evaluate(() => test.external());
        await page
          .getByRole("button", { name: "保存新版本", exact: true })
          .click();
        await page
          .getByRole("button", { name: "保留草稿并重新读取", exact: true })
          .click();
        assert.equal(
          await page.getByLabel("比较值", { exact: true }).inputValue(),
          "123.12345",
        );
        assert.equal(await page.evaluate(() => test.writes.length), 1);
        await page
          .getByRole("button", { name: "保存新版本", exact: true })
          .click();
        await page.waitForFunction(() => test.writes.length === 2);
        assert.deepEqual(
          await page.evaluate(() => test.writes.map((w) => w.body.version)),
          [2, 7],
        );
      },
    );
    await check("historical event searches its visible name", async () => {
      await page.evaluate(() => test.mount("panel"));
      await page.getByRole("tab", { name: "日志", exact: true }).click();
      await page.getByRole("button", { name: "搜索告警", exact: true }).click();
      for (const query of [
        "中文历史名称",
        "BODY MESSAGE",
        "EURUSD",
        "价格 上穿",
      ]) {
        await page.getByLabel("搜索", { exact: true }).fill(query);
        assert.equal(await page.locator('[data-signal-id="evt"]').count(), 1);
      }
    });
    await check(
      "lifecycle commits complete rows and archived rules cannot reappear",
      async () => {
        for (const [status, button, action] of [
          ["paused", "恢复", "resume"],
          ["active", "暂停", "pause"],
          ["completed", "重新启用（新一轮）", "restart"],
        ]) {
          await page.evaluate(
            (status) => test.mount("panel", { status }),
            status,
          );
          await page.getByRole("button", { name: button, exact: true }).click();
          await page.waitForFunction(
            () =>
              test.writes.length === 1 &&
              test.bridgeRows[0]?.control_revision === 3,
          );
          assert.equal(
            await page.evaluate(() => test.writes[0].body.action),
            action,
          );
          assert.equal(
            await page.evaluate(() => test.bridgeRows[0].status),
            action === "pause" ? "paused" : "active",
          );
        }
        await page.evaluate(() => test.mount("panel", { stale: true }));
        await page
          .getByRole("button", { name: "中文历史名称 行操作", exact: true })
          .click();
        await page.getByRole("menuitem", { name: "删除", exact: true }).click();
        await page.waitForFunction(
          () => test.writes.length && test.bridgeRows.length === 0,
        );
        await page.waitForTimeout(50);
        assert.equal(
          await page.getByRole("button", { name: "编辑", exact: true }).count(),
          0,
        );
      },
    );
    await check(
      "runtime observations advance; late mutations, read failures and workspace changes are fenced",
      async () => {
        await page.evaluate(() => test.mount("data"));
        await page.waitForFunction(() => test.bridgeRows.length === 1);
        await page.evaluate(() => {
          probe.commit({
            ...test.row,
            control_revision: 5,
            health: "blocked",
            run: 2,
            count: 3,
            updated_at: 5,
          });
          probe.commit({ ...test.row, control_revision: 4, status: "active" });
        });
        assert.equal(
          await page.evaluate(() => test.bridgeRows[0].health),
          "blocked",
        );
        await page.evaluate(() => {
          probe.commit({
            ...test.row,
            control_revision: 5,
            health: "ready",
            run: 2,
            count: 4,
            updated_at: 6,
          });
        });
        assert.equal(await page.evaluate(() => test.bridgeRows[0].count), 4);
        await page.evaluate(() => test.mount("data", { listFailure: true }));
        await page.waitForFunction(() => probe.error.includes("读取失败"));
        await page.evaluate(() => probe.refresh());
        await page.waitForFunction(
          () => test.bridgeRows.length === 1 && !probe.error,
        );
        await page.evaluate(() => test.mount("panel", { workspace: "old" }));
        await page.getByRole("button", { name: "编辑", exact: true }).waitFor();
        await page.evaluate(() => {
          test.hold();
        });
        await page.waitForFunction(() => test.held.length > 0, undefined, {
          timeout: 7000,
        });
        await page.evaluate(() => {
          test.rerender({ workspace: "new" });
          test.release();
        });
        await page.getByRole("button", { name: "编辑", exact: true }).waitFor();
        assert.equal(await page.evaluate(() => test.bridgeRows[0].version), 2);
      },
    );
    await check(
      "range, MACD and expiry validation messages locate their fields",
      async () => {
        const cases = [
          {
            condition: {
              relation: "enter",
              left: { kind: "price" },
              lower: "110",
              upper: "90",
            },
            detail: [
              {
                loc: ["body", "config", "condition"],
                msg: "Value error, 区间下限必须小于上限",
                input: { private: "secret" },
              },
            ],
            field: "condition.lower",
          },
          {
            condition: {
              relation: "cross_up",
              left: {
                kind: "indicator",
                indicator: {
                  name: "MACD",
                  version: "1",
                  params: { fast: 26, slow: 12, signal: 9 },
                  output: "macd",
                },
              },
              right: { kind: "constant", value: "0" },
            },
            detail: [
              {
                loc: ["body", "config", "condition", "left", "indicator"],
                msg: "Value error, MACD fast 必须小于 slow",
              },
            ],
            field: "condition.left.indicator.params.fast",
          },
          { detail: "到期时间必须晚于生效时间", field: "expires_at" },
        ];
        for (const item of cases) {
          await page.evaluate(
            (item) =>
              test.mount("dialog", {
                config: {
                  ...test.config,
                  ...(item.condition ? { condition: item.condition } : {}),
                },
                failure: { status: 422, detail: item.detail },
              }),
            item,
          );
          await page
            .getByRole("button", { name: "创建告警", exact: true })
            .click();
          await page.waitForFunction(
            (field) =>
              document.activeElement
                ?.closest("[data-alert-field]")
                ?.getAttribute("data-alert-field") === field,
            item.field,
          );
          assert.equal(
            (await page.locator('[aria-invalid="true"]').count()) > 0,
            true,
          );
          assert.doesNotMatch(
            await page.getByRole("alert").innerText(),
            /secret|ApiError/,
          );
        }
      },
    );
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, []);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
