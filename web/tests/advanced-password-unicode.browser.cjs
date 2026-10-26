// Controlled real-browser contract test; no account credentials or deployed API.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const parent = fs.readFileSync(path.join(root, 'web/src/advanced/ChartApplicationPage.tsx'), 'utf8');
const start = parent.indexOf('        const body = m.query;', parent.indexOf('m.type === "account-password"'));
const end = parent.indexOf('      } else if (m.type === "style-template-name")', start);
assert.ok(start > 0 && end > start);
const parentBody = parent.slice(start, end);
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({path: path.join(root, 'advanced-host/chart-account.js')});
    const cases = [
      ['six emoji', '🦉'.repeat(6), true],
      ['300 emoji', '🦉'.repeat(300), true],
      ['512 emoji', '🦉'.repeat(512), true],
      ['five emoji', '🦉'.repeat(5), false],
      ['513 emoji', '🦉'.repeat(513), false],
      ['spaces retained', ' 密码 任意字符 ', true],
    ];
    for (const [name, password, accepted] of cases) {
      await page.evaluate(parentBody => {
        document.body.replaceChildren();
        window.calls = []; window.replies = [];
        const runParent = new Function('m', 'api', 'reply', 'return (async () => {' + parentBody + '})();');
        const submit = async body => {
          await runParent({id: 'example', query: body}, async (_, payload) => {
            window.calls.push(payload); return {ok: true};
          }, response => window.replies.push(response));
          const response = window.replies.at(-1);
          if (response.error) throw Error(response.error);
        };
        let onClose;
        const widget = {showNoticeDialog(options) {
          if (options.title !== '修改密码') return;
          onClose = options.callback;
          document.body.innerHTML = '<div><div data-name="warning-dialog"><span class="title-native">修改密码</span><button data-name="close">×</button><div class="content-native"></div><div class="footer-native"><button class="primary-D4RPB3ZC"><span class="content-native">确定</span></button></div></div></div>';
          document.querySelector('[data-name="close"]').onclick = () => {document.body.replaceChildren(); onClose();};
        }};
        chartPasswordDialog(widget, document, submit, () => {});
      }, parentBody);
      const inputs = page.locator('input');
      await inputs.nth(0).fill('existing-test-password');
      await inputs.nth(1).fill(password);
      await inputs.nth(2).fill(password);
      await page.getByRole('button', {name: '保存', exact: true}).click();
      if (accepted) {
        await page.waitForFunction(() => window.calls.length === 1);
        const payload = await page.evaluate(() => window.calls[0]);
        assert.equal(payload.new_password, password, name);
      } else {
        await page.waitForFunction(() => document.querySelector('[role="alert"]')?.hidden === false || document.querySelector('input:invalid'));
        assert.equal(await page.evaluate(() => window.calls.length), 0, name);
      }
    }
    const boundary = await page.evaluate(async parentBody => {
      const runParent = new Function('m', 'api', 'reply', 'return (async () => {' + parentBody + '})();');
      const results = [];
      for (const length of [512, 513]) {
        let called = false, response;
        await runParent({id: 'current-boundary', query: {current_password: '🦉'.repeat(length), new_password: 'abcdef'}}, async () => {called = true; return {ok: true};}, value => {response = value;});
        results.push({length, called, error: response.error});
      }
      return results;
    }, parentBody);
    assert.equal(boundary[0].called, true);
    assert.equal(boundary[1].called, false);
    console.log(JSON.stringify({scope: 'Controlled DOM and actual parent RPC branch; no deployed native image/API acceptance.', passed: cases.length + 2, account_password_changed: false}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
