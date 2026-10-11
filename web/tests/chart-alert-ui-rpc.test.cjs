const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  path = require("node:path");
const { buildSync } = require("esbuild");
const output = buildSync({
  entryPoints: [path.resolve(__dirname, "../src/advanced/chartAlertUiApi.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
}).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(output, {
  module: moduleObject,
  exports: moduleObject.exports,
  fetch: () => {
    throw Error("Unexpected fetch");
  },
  DOMException,
});
const { chartAlertUiRequest } = moduleObject.exports;
const scope = { workspace_id: "workspace-one", session: "session-one" },
  id = "1a9c47d0-1452-4018-a58d-eacbb38d9bd7";
const query = (path, body) => ({
  ...scope,
  path,
  ...(body === undefined ? {} : { body }),
});
test("UI bridge rejects URLs, methods, forged sessions and workspace association before API work", async () => {
  let calls = 0;
  const api = async () => {
    calls++;
  };
  for (const value of [
    query("/logout", {}),
    query("/chart-alerts/../logout", {}),
    query("/chart-alerts/events", {}),
    query(`/chart-alerts/${id}/edit`),
    query(`/chart-alerts/${id}/lifecycle`, { action: "drawing_deleted" }),
    { ...query("/chart-alerts"), session: "old" },
    { ...query("/chart-alerts"), workspace_id: "other" },
    query("/chart-alerts", {
      config: { association: { workspace_id: "other" } },
    }),
  ])
    await assert.rejects(chartAlertUiRequest(value, scope, () => true, api));
  assert.equal(calls, 0);
});
test("read, capability, geometry, create, edit, lifecycle and ack have bounded allowed routes", async () => {
  const calls = [];
  const api = async (path, body) => {
    calls.push({ path, body });
    return { ok: true };
  };
  for (const value of [
    query("/chart-alerts"),
    query("/chart-alerts/events"),
    query("/chart-alerts/capabilities", { instrument: "EURUSD" }),
    query("/chart-alerts/geometry", { instrument: "EURUSD", points: [] }),
    query("/chart-alerts", {
      config: { association: { workspace_id: "workspace-one" } },
    }),
    query(`/chart-alerts/${id}/edit`, { version: 1, config: {} }),
    query(`/chart-alerts/${id}/lifecycle`, { action: "pause" }),
    query(`/notifications/${id}/ack`, {}),
  ])
    assert.equal(
      (await chartAlertUiRequest(value, scope, () => true, api)).ok,
      true,
    );
  assert.equal(calls.length, 8);
});
test("workspace change suppresses delayed response and refuses subsequent calls", async () => {
  let current = true,
    release,
    calls = 0;
  const result = chartAlertUiRequest(
    query("/chart-alerts"),
    scope,
    () => current,
    () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  );
  current = false;
  release([]);
  await assert.rejects(result, /过期响应/);
  await assert.rejects(
    chartAlertUiRequest(
      query("/chart-alerts"),
      scope,
      () => current,
      () => {
        calls++;
      },
    ),
    /工作区已切换/,
  );
  assert.equal(calls, 1);
});
