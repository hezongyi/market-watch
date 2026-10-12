// Task-owned Ubuntu Docker only; see docs/production-ux-fixes-20261012.md.
const { chromium, expect } = require("@playwright/test");
const fs = require("fs"),
  { execFileSync } = require("child_process");
const root = require("node:path").resolve(__dirname, "../.."),
  base = "http://127.0.0.1:19971";
const compose =
  "docker compose --env-file /tmp/mw-production-ux-20261012-private/acceptance.env -p mw-production-ux-20261012 -f deploy/ubuntu/production-ux.acceptance.yaml -f /tmp/mw-production-ux-20261012-private/health.override.yaml ";
function cmd(s) {
  execFileSync("sg", ["docker", "-c", compose + s], {
    cwd: root,
    stdio: "ignore",
  });
}
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await p.goto(base);
    await p
      .getByLabel("管理员密码")
      .fill(
        fs.readFileSync(
          "/tmp/mw-production-ux-20261012-private/password",
          "utf8",
        ),
      );
    await p.getByRole("button", { name: "登录工作台" }).click();
    await expect(p.getByLabel("管理员密码")).toHaveCount(0);
    const snapshots = [];
    async function states() {
      const h = await (await p.request.get(base + "/api/health")).json();
      return Object.fromEntries(
        [...h.history_services, h.legacy_import].map((r) => [r.id, r.status]),
      );
    }
    async function poll(test, timeout) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        let s = await states();
        if (test(s)) {
          snapshots.push({ at: new Date().toISOString(), states: s });
          return s;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw Error("health did not reach expected state");
    }
    await poll((s) => Object.values(s).every((v) => v === "running"), 60000);
    console.log(
      "All four roles fresh; stopping history publisher and legacy only",
    );
    cmd("stop history-worker legacy-import-worker");
    await poll(
      (s) =>
        s.history_versions === "stale" &&
        s.legacy_import === "stale" &&
        s.chart_history === "running" &&
        s.native_history === "running",
      360000,
    );
    await p.goto(base + "/settings");
    await expect(p.getByLabel("历史服务运行状态")).toContainText(
      "心跳过期，请检查对应服务",
    );
    await expect(
      p.getByText("兼容链路心跳过期；不代表现行历史服务状态", { exact: true }),
    ).toBeVisible();
    await p.screenshot({
      path: root + "/artifacts/production-ux-real/health-stopped.png",
    });
    cmd("start history-worker");
    await poll(
      (s) => s.history_versions === "running" && s.legacy_import === "stale",
      60000,
    );
    await p.reload();
    await expect(
      p.getByLabel("历史服务运行状态").getByText("心跳过期，请检查对应服务"),
    ).toHaveCount(0);
    await p.screenshot({
      path: root + "/artifacts/production-ux-real/health-current-recovered.png",
    });
    cmd("start legacy-import-worker");
    await poll((s) => Object.values(s).every((v) => v === "running"), 60000);
    fs.writeFileSync(
      root + "/artifacts/production-ux-real/health-stop-recovery.json",
      JSON.stringify(
        {
          scope:
            "Actual Docker stop/start and elapsed 300-second stale threshold",
          snapshots,
        },
        null,
        2,
      ),
    );
    console.log("Independent stop and recovery verified");
  } finally {
    await b.close();
    cmd("start history-worker legacy-import-worker");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
