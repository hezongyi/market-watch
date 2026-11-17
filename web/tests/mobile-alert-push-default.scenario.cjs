// Uses the existing HTTP fixtures; never creates real rules or sends a push.
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

module.exports = async ({page, pick, close, refresh, shot, errors, rows, createBodies, setPhoneEnabled}) => {
  const push = form => form.getByRole('switch', {name: '手机推送', exact: true});
  const detail = () => page.getByRole('dialog', {name: '规则详情', exact: true});
  const edit = () => page.getByRole('dialog', {name: '编辑告警', exact: true});
  const fill = async form => {
    await form.getByRole('button', {name: '触价', exact: true}).click();
    await form.getByLabel('目标价格', {exact: true}).fill('1.08500');
  };
  // An available transport enables a new mobile rule, and the submitted config
  // retains that choice through the existing lost-response recovery flow.
  let form = await pick();
  await expect(push(form)).toBeEnabled();
  await expect(push(form)).toBeChecked();
  await fill(form);
  await shot('new-push-enabled');
  await form.getByRole('button', {name: '创建告警', exact: true}).click();
  await form.getByRole('button', {name: '核查同一次提交', exact: true}).click();
  await expect(form).toHaveCount(0);
  assert.equal(createBodies[0].config.notify_ntfy, true);
  assert.equal(rows.length, 1);
  await detail().getByRole('button', {name: '编辑条件', exact: true}).click();
  await expect(push(edit())).toBeChecked();
  await close(edit());
  await close(detail());

  // A manual opt-out survives background health reads and is sent as false.
  form = await pick();
  await expect(push(form)).toBeChecked();
  await push(form).click();
  await refresh();
  await expect(push(form)).not.toBeChecked();
  await fill(form);
  await form.getByRole('button', {name: '创建告警', exact: true}).click();
  await expect(form).toHaveCount(0);
  assert.equal(createBodies.at(-1).config.notify_ntfy, false);
  assert.equal(rows.length, 2);
  await detail().getByRole('button', {name: '编辑条件', exact: true}).click();
  await expect(push(edit())).not.toBeChecked();
  await expect(push(edit())).toBeEnabled();
  await close(edit());
  await close(detail());

  // Closing global delivery must not default a new rule to unusable push.
  setPhoneEnabled(false);
  const healthRead = page.waitForResponse(r => r.url().endsWith('/api/health'));
  await refresh();
  await healthRead;
  form = await pick();
  await expect(push(form)).not.toBeChecked();
  await expect(push(form)).toBeDisabled();
  await shot('new-push-unavailable');
  await close(form);
  assert.deepEqual(errors, []);
  console.log('PASS mobile push default with available/unavailable transport, manual opt-out, health refresh, existing rule choices and submitted configs');
};
