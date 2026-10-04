const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
module.exports = async function prefixRevision({
  frame,
  settle,
  item,
  save,
  m5,
}) {
  await frame.evaluate(() => {
    globalThis.__prefixBars = [];
    globalThis.__prefixRequests = [];
    const getBars = feed.getBars;
    feed.getBars = function (s, r, p, cb, err) {
      __prefixRequests.push({ ticker: s.ticker, res: r, params: p });
      return getBars.call(
        this,
        s,
        r,
        p,
        (bars, meta) => {
          const decoded = decode(s.ticker);
          if (
            r === "5" &&
            decoded.spec?.name === "SMA" &&
            decoded.spec.params.period === 201
          )
            __prefixBars.push(...bars);
          cb(bars, meta);
        },
        err,
      );
    };
  });
  await frame.evaluate(async (m5) => {
    const c = widget.chart(m5);
    for (const study of c.getAllStudies())
      if (study.name === "守望 Python SMA") c.removeEntity(study.id);
    // Different input gives a new real native indicator source rather than
    // reusing the already loaded SMA200 cache from the preceding acceptance.
    await c.createStudy("守望 Python SMA", false, false, { period: 201 });
  }, m5);
  try {
    await frame.waitForFunction(() => __prefixBars.length > 0, null, {
      timeout: 90000,
    });
  } catch (error) {
    item.prefixRevision = {
      requests: await frame.evaluate(() => __prefixRequests),
      studies: await frame.evaluate(
        (m5) =>
          widget
            .chart(m5)
            .getAllStudies()
            .map((s) => ({
              ...s,
              inputs: widget.chart(m5).getStudyById(s.id).getInputValues(),
            })),
        m5,
      ),
    };
    save();
    throw error;
  }
  await settle();
  const before = await frame.evaluate(() => {
    const first = Math.min(...__prefixBars.map((b) => b.time));
    const bar = __prefixBars.filter((b) => b.time === first).at(-1);
    return { first, value: bar?.close };
  });
  assert.ok(Number.isFinite(before.first) && Number.isFinite(before.value));
  // Make the dependency-sensitive value visible. A legitimate correction
  // reload restores the visible range, not every historical bar ever loaded.
  await frame.evaluate(
    ({ m5, first }) =>
      widget.chart(m5).setVisibleRange(
        {
          from: first / 1000,
          to: first / 1000 + 3600,
        },
        { rejectByTimeout: 120000 },
      ),
    { m5, first: before.first },
  );
  await settle();
  const compose =
    "/home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml";
  const run = (mode, at) =>
    JSON.parse(
      execFileSync(
        "sg",
        [
          "docker",
          "-c",
          `docker compose -f ${compose} exec -T --user 0 api python /private/prefix_fixture.py ${mode} ${at}`,
        ],
        { encoding: "utf8" },
      ),
    );
  const audit = (item.prefixRevision = { before });
  save();
  try {
    audit.injection = run("revise", before.first);
    assert.ok(
      audit.injection.prefix_time < before.first,
      "changed bar is outside delivered Python bars",
    );
    await frame.waitForFunction(
      ({ first, expected }) =>
        __prefixBars.some(
          (b) => b.time === first && Math.abs(b.close - expected) < 1e-9,
        ),
      { first: before.first, expected: audit.injection.expected },
      { timeout: 90000 },
    );
    await settle();
    audit.after = await frame.evaluate(
      (first) => __prefixBars.filter((b) => b.time === first).at(-1),
      before.first,
    );
    assert.ok(Math.abs(audit.after.close - audit.injection.expected) < 1e-9);
    assert.ok(
      Math.abs(audit.after.close - before.value) > 1e-8,
      "prefix correction changes native Python study values",
    );
    audit.passed = true;
    save();
  } finally {
    audit.restoration = run("restore", before.first);
    save();
  }
};
