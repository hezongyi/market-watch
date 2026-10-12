// Actual task-owned Docker stop/start, using the unchanged 300-second threshold.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const {
  root,
  base,
  out,
  privateDir,
  project,
  password,
} = require("./production-ux-env.cjs");
function cmd(action, services) {
  if (
    !["stop", "start"].includes(action) ||
    services.some(
      (s) =>
        ![
          "history-worker",
          "chart-history-worker",
          "native-history-worker",
          "legacy-import-worker",
        ].includes(s),
    )
  )
    throw Error("Invalid worker action");
  execFileSync(
    "sg",
    [
      "docker",
      "-c",
      `docker compose --env-file ${privateDir}/acceptance.env -p ${project} -f deploy/ubuntu/production-ux.acceptance.yaml -f ${privateDir}/health.override.yaml ${action} ${services.join(" ")}`,
    ],
    { cwd: root, stdio: "ignore" },
  );
}
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const roles = {
    history_versions: "history-worker",
    chart_history: "chart-history-worker",
    native_history: "native-history-worker",
    legacy_import: "legacy-import-worker",
  };
  const snapshots = [];
  try {
    await p.goto(base + "/settings");
    await p.getByLabel("管理员密码").fill(password);
    await p.getByRole("button", { name: "登录工作台" }).click();
    await expect(p.getByLabel("管理员密码")).toHaveCount(0);
    const states = async () => {
      const h = await (await p.request.get(base + "/api/health")).json();
      return Object.fromEntries(
        [...h.history_services, h.legacy_import].map((r) => [r.id, r.status]),
      );
    };
    async function poll(expected, timeout = 60000) {
      await expect
        .poll(states, { timeout, intervals: [5000] })
        .toEqual(expected);
      snapshots.push({ at: new Date().toISOString(), states: await states() });
    }
    const expected = Object.fromEntries(
      Object.keys(roles).map((r) => [r, "running"]),
    );
    await poll(expected);
    cmd("stop", Object.values(roles));
    console.log(
      "All four stopped; waiting for actual 300-second stale threshold",
    );
    for (const role of Object.keys(roles)) expected[role] = "stale";
    await poll(expected, 360000);
    async function capture(name) {
      await p.reload();
      const status = p.getByLabel("历史服务运行状态");
      await expect(status).toContainText("自建历史发布");
      await status
        .locator("..")
        .screenshot({ path: out + "/" + name + ".png" });
    }
    await capture("health-all-stopped");
    for (const [role, service] of Object.entries(roles)) {
      cmd("start", [service]);
      expected[role] = "running";
      await poll(expected);
      await capture("health-recovered-" + role);
      const status = p.getByLabel("历史服务运行状态");
      const count = Object.entries(expected).filter(
        ([id, value]) => id !== "legacy_import" && value === "stale",
      ).length;
      await expect(
        status.getByText("心跳过期，请检查对应服务", { exact: true }),
      ).toHaveCount(count);
      console.log(role + " recovered independently");
    }
    fs.writeFileSync(
      out + "/health-stop-recovery.json",
      JSON.stringify(
        {
          scope:
            "Actual Docker stop/start of every current and legacy role, real 300-second stale threshold, sequential independent recovery",
          snapshots,
        },
        null,
        2,
      ),
    );
  } finally {
    cmd("start", Object.values(roles));
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
