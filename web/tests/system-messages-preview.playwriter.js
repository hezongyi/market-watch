// Run through Playwriter in the task-owned isolated context. No backend writes.
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};
state.panelPreviewProof = { cases: [], errors: [], mutations: [] };
const proof = state.panelPreviewProof;
const page = state.panelPreviewPage;
page.on("pageerror", (error) => proof.errors.push(String(error)));
page.on("request", (request) => {
  if (!["GET", "HEAD"].includes(request.method()))
    proof.mutations.push({ method: request.method(), url: request.url() });
});
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload();
await page.locator("#preview-status").filter({ hasText: "预览就绪" }).waitFor();
let frame = (state.panelFrame = page
  .frames()
  .find((item) => item.url().startsWith("blob:")));
await frame.locator(".nc-row").first().waitFor();
const geometry = () =>
  frame.evaluate(() => {
    const canvas = document.querySelector("canvas[aria-label]"),
      rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
    };
  });
const openedGeometry = await geometry();
const palette = await frame.evaluate(() => ({
  surface: getComputedStyle(document.querySelector(".nc-native-surface"))
    .backgroundColor,
  panel: getComputedStyle(document.querySelector(".nc-panel")).backgroundColor,
  searchHeight: getComputedStyle(
    document.querySelector(".mw-native-search input"),
  ).height,
  modal: document
    .querySelector(".nc-native-surface")
    .getAttribute("aria-modal"),
}));
const scrollSkin = await frame.locator(".nc-list").evaluate((node) => ({
  nativeClass: node.className,
  bar: getComputedStyle(node, "::-webkit-scrollbar").width,
  thumb: getComputedStyle(node, "::-webkit-scrollbar-thumb").backgroundColor,
}));
assert(
  scrollSkin.nativeClass.includes("scrollContainer-") &&
    scrollSkin.bar === "5px",
  "Actual native scrollbar rules",
);
assert(
  await frame
    .getByRole("searchbox", { name: "搜索系统消息" })
    .evaluate((node) => node !== document.activeElement && !node.autofocus),
  "Search does not autofocus on initial open",
);
assert(
  (await frame.locator(".nc-pagination").count()) === 0,
  "No pagination UI",
);
proof.cases.push({
  name: "Search never autofocused on open and actual native 5px scrollbar",
  scrollSkin,
});
assert(
  palette.surface === "rgb(31, 31, 31)" && palette.panel === "rgba(0, 0, 0, 0)",
  "Native dark surface",
);
assert(
  palette.searchHeight === "24px" && palette.modal === "false",
  "Native search and nonmodal dialog",
);
await frame.getByRole("button", { name: "关闭系统消息" }).click();
await frame.locator(".nc-native-surface").waitFor({ state: "detached" });
assert(
  JSON.stringify(openedGeometry) === JSON.stringify(await geometry()),
  "No chart resize on close",
);
await frame.locator(".nc-system-entry").click();
await frame.locator(".nc-row").first().waitFor();
assert(
  await frame.evaluate(
    () =>
      !document
        .querySelector(".nc-native-surface")
        .contains(document.activeElement),
  ),
  "Mouse open must not move focus into center",
);
assert(
  JSON.stringify(openedGeometry) === JSON.stringify(await geometry()),
  "No chart resize on open",
);
proof.cases.push({
  name: "Native surface, mouse focus and unchanged chart geometry",
  palette,
  geometry: openedGeometry,
});

await page.keyboard.press("Escape");
await frame.locator(".nc-native-surface").waitFor({ state: "detached" });
await frame.locator(".nc-system-entry").press("Enter");
await frame.waitForFunction(() =>
  document
    .querySelector(".nc-native-surface")
    ?.contains(document.activeElement),
);
assert(
  await frame
    .getByRole("button", { name: "系统消息设置", exact: true })
    .evaluate((node) => node === document.activeElement),
  "Keyboard opening enters first control",
);
const search = frame.getByRole("searchbox", { name: "搜索系统消息" });
await search.fill("历史");
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 2,
);
await page.evaluate(() => messagePreview.fixture.refresh());
assert((await search.inputValue()) === "历史", "Refresh preserves search");
assert(
  await search.evaluate((node) => node === document.activeElement),
  "Refresh preserves focus",
);
await frame.getByRole("button", { name: /历史数据加载失败/ }).click();
await frame.getByRole("heading", { name: "历史数据加载失败" }).waitFor();
await page.waitForFunction(() => messagePreview.fixture.state().unread === 3);
await frame.getByRole("button", { name: "标为已处理", exact: true }).click();
await frame.getByRole("button", { name: "已处理", exact: true }).waitFor();
await frame.getByRole("button", { name: "关闭系统消息" }).focus();
await page.keyboard.press("Escape");
await search.waitFor();
assert(
  (await search.inputValue()) === "历史",
  "Detail return preserves search",
);
proof.cases.push({
  name: "Keyboard opening, Chinese search, refresh preservation, detail/read/handled and Escape return",
});

await search.fill("没有匹配的示例消息");
await frame.getByText("没有符合条件的系统消息", { exact: true }).waitFor();
await search.fill("");
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 6,
);
await frame.locator(".nc-list").evaluate((node) => (node.scrollTop = 20));
const scroll = await frame
  .locator(".nc-list")
  .evaluate((node) => node.scrollTop);
await page.evaluate(() => messagePreview.fixture.refresh());
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 6,
);
assert(
  (await frame.locator(".nc-list").evaluate((node) => node.scrollTop)) ===
    scroll,
  "Refresh preserves list scroll",
);
// Loading failures keep existing rows and require an explicit retry.
await page.evaluate(() => messagePreview.fixture.failNextOlder());
await frame
  .locator(".nc-list")
  .evaluate((node) => (node.scrollTop = node.scrollHeight));
await frame.getByRole("button", { name: "重试加载", exact: true }).waitFor();
assert(
  (await frame.locator(".nc-row").count()) === 6,
  "Older load failure retains current rows",
);
await frame.getByRole("button", { name: "重试加载", exact: true }).click();
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 12,
);
const idsBefore = await frame.locator(".nc-row").allTextContents();
await page.evaluate(() => messagePreview.fixture.refresh());
await frame.waitForFunction(
  () =>
    document.querySelector(".nc-list")?.getAttribute("aria-busy") === "false",
);
assert(
  (await frame.locator(".nc-row").count()) === 12,
  "Refresh retains loaded history chunks",
);
const unique = await frame.locator(".nc-row").allTextContents();
assert(
  JSON.stringify(idsBefore) === JSON.stringify(unique),
  "Refresh does not reorder or duplicate rows",
);
for (const count of [18, 21]) {
  await frame.locator(".nc-list").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
    node.dispatchEvent(new Event("scroll"));
  });
  await frame.waitForFunction(
    (expected) => document.querySelectorAll(".nc-row").length === expected,
    count,
  );
}
await frame.getByText("已显示全部消息", { exact: true }).waitFor();
const endCalls = await page.evaluate(
  () => messagePreview.fixture.historyCalls.length,
);
await frame
  .locator(".nc-list")
  .evaluate((node) => (node.scrollTop = node.scrollHeight));
assert(
  (await page.evaluate(() => messagePreview.fixture.historyCalls.length)) ===
    endCalls,
  "End of history does not request again",
);
await search.fill("历史");
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 2,
);
await search.fill("");
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 6,
);
// A filter change while an older chunk is in flight invalidates its response.
await frame
  .locator(".nc-list")
  .evaluate((node) => (node.scrollTop = node.scrollHeight));
await search.fill("历史");
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 2,
);
await search.fill("");
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 6,
);
proof.cases.push({
  name: "Continuous history 6/12/18/21, retry, refresh retention, end, filtering and stale response isolation",
});

await frame.getByRole("button", { name: "筛选系统消息" }).click();
await frame
  .getByRole("menuitemcheckbox", { name: "仅未读", exact: true })
  .click();
await frame.waitForFunction(
  () => document.querySelectorAll(".nc-row").length === 3,
);
assert(
  await page.evaluate(() => messagePreview.controller.isOpen()),
  "Native menu cannot close center",
);
await frame.getByRole("button", { name: "筛选系统消息" }).click();
await page.keyboard.press("Escape");
assert(
  await page.evaluate(() => messagePreview.controller.isOpen()),
  "Menu Escape closes only menu",
);
await frame.getByRole("button", { name: "筛选系统消息" }).click();
await frame
  .getByRole("menuitemcheckbox", { name: "更多筛选", exact: true })
  .click();
await frame.getByRole("button", { name: "系统消息级别", exact: true }).click();
await frame.getByRole("option", { name: "错误", exact: true }).click();
await frame
  .getByRole("button", { name: "系统消息级别", exact: true })
  .waitFor();
assert(
  await page.evaluate(() => messagePreview.controller.isOpen()),
  "Native select cannot close center",
);
await frame.getByRole("button", { name: "筛选系统消息" }).click();
await frame
  .getByRole("menuitemcheckbox", { name: "全部消息", exact: true })
  .click();
proof.cases.push({
  name: "Native PopupMenu and Select, unread filtering and nested Escape",
});

await frame.getByRole("button", { name: "系统消息设置", exact: true }).click();
await frame.getByRole("checkbox", { name: "异常即时提示" }).click();
await page.waitForFunction(() => !messagePreview.fixture.state().systemPopups);
assert(
  await page.evaluate(() => !messagePreview.fixture.state().systemPopups),
  "Fixture checkbox off",
);
await frame.waitForFunction(
  () => !document.querySelector(".nc-settings input[type=checkbox]").checked,
);
await frame.getByRole("checkbox", { name: "异常即时提示" }).click();
await page.waitForFunction(() => messagePreview.fixture.state().systemPopups);
await frame.getByRole("button", { name: "关闭系统消息" }).focus();
await page.keyboard.press("Escape");
await search.waitFor();
await frame.getByRole("button", { name: "全部标为已读", exact: true }).click();
await page.waitForFunction(() => messagePreview.fixture.state().unread === 0);
assert(
  await frame.locator(".nc-entry-count").isHidden(),
  "Zero unread hides badge",
);
const widths = [];
for (const unread of [0, 23, 128]) {
  await page.evaluate(
    (count) =>
      messagePreview.controller.update({
        ...messagePreview.fixture.state(),
        unread: count,
      }),
    unread,
  );
  widths.push(
    await frame
      .locator(".nc-system-entry")
      .evaluate((node) => node.getBoundingClientRect().width),
  );
  if (unread === 128)
    assert(
      (await frame.locator(".nc-entry-count").textContent()) === "99+",
      "Unread count cap",
    );
}
assert(
  widths.every((width) => width === 52),
  "Entry reserves fixed width",
);
proof.cases.push({
  name: "Native settings, read-all and fixed 0/23/99+ badge",
  widths,
});

// Outside click is delivered to the chart and closes without restoring entry focus.
await frame
  .locator("canvas[aria-label]")
  .click({ position: { x: 250, y: 180 } });
await frame.locator(".nc-native-surface").waitFor({ state: "detached" });
assert(
  await frame.evaluate(
    () => document.activeElement !== document.querySelector(".nc-system-entry"),
  ),
  "Outside chart click must keep chart focus",
);
const rangeBefore = await page.evaluate(() =>
  messagePreview.widget.activeChart().getVisibleRange(),
);
await page.mouse.move(350, 330);
await page.mouse.down();
await page.mouse.move(520, 330, { steps: 8 });
await page.mouse.up();
const rangeAfter = await page.evaluate(() =>
  messagePreview.widget.activeChart().getVisibleRange(),
);
assert(
  JSON.stringify(rangeBefore) !== JSON.stringify(rangeAfter),
  "Chart still pans",
);
proof.cases.push({
  name: "Outside click passes through; chart panning remains usable",
  rangeBefore,
  rangeAfter,
});

// Reset chart-only onboarding/selection after the pan test for clean theme views.
await page.reload();
await page.locator("#preview-status").filter({ hasText: "预览就绪" }).waitFor();
frame = state.panelFrame = page
  .frames()
  .find((item) => item.url().startsWith("blob:"));
await frame.locator(".nc-row").first().waitFor();
await page.locator("#theme").click();
await frame.waitForFunction(
  () => !document.documentElement.classList.contains("theme-dark"),
);
const light = await frame
  .locator(".nc-native-surface")
  .evaluate((node) => getComputedStyle(node).backgroundColor);
assert(light === "rgb(255, 255, 255)", "Native light surface");
proof.cases.push({
  name: "Native dark/light themes",
  dark: palette.surface,
  light,
});
await page.screenshot({ path: "/tmp/mw75-system-messages-light.png" });
await page.locator("#theme").click();
for (const width of [850, 390]) {
  await page.setViewportSize({ width, height: 850 });
  await frame.waitForFunction(
    () =>
      document.querySelector(".nc-native-surface").getBoundingClientRect()
        .right <= innerWidth,
  );
  const bounds = await frame.locator(".nc-native-surface").evaluate((node) => {
    const r = node.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert(
    bounds.left >= 0 && bounds.right <= width && !bounds.overflow,
    "Center fits narrow viewport",
  );
  proof.cases.push({ name: "Responsive geometry", width, bounds });
  if (width === 390)
    await page.screenshot({ path: "/tmp/mw75-system-messages-narrow.png" });
}
await page.evaluate(() => {
  messagePreview.controller.destroy();
  messagePreview.controller.destroy();
  messagePreview.controller.update(messagePreview.fixture.state());
});
await frame.locator(".nc-native-surface").waitFor({ state: "detached" });
assert(
  (await frame.locator(".nc-system-entry").count()) === 0,
  "Destroyed entry removed",
);
assert(
  await page.evaluate(() => !messagePreview.controller.isOpen()),
  "Destroy closes state",
);
proof.cases.push({ name: "Idempotent destroy and ignored late update" });
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload();
await page.locator("#preview-status").filter({ hasText: "预览就绪" }).waitFor();
state.panelFrame = page.frames().find((item) => item.url().startsWith("blob:"));
await state.panelFrame.locator(".nc-row").first().waitFor();
assert(
  await page.evaluate(
    () =>
      messagePreview.fixture.state().unread === 4 &&
      messagePreview.fixture.state().systemPopups,
  ),
  "Fixture resets on reload",
);
await page.screenshot({ path: "/tmp/mw75-system-messages-dark.png" });
assert(
  proof.errors.length === 0,
  "No browser errors: " + JSON.stringify(proof.errors),
);
assert(
  proof.mutations.length === 0,
  "No network mutations: " + JSON.stringify(proof.mutations),
);
proof.passed = true;
console.log(JSON.stringify(proof, null, 2));
