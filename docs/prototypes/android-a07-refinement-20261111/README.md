# 守望 A07：已认可的视觉实现基线

当前状态：**用户已认可 A07；首先实现自选页，待真机验收。** 原 A06 文件保留作历史对照，确认原话见 `direction-approved.md`。

## 打开

- `index.html`：五个可交互主页面、A06/A07 并排切换、状态与弹窗目录。整个目录保留在一起即可本地打开。
- `preview.html`：自包含手机预览，单文件可复制、双击打开，不依赖服务器、字体下载、UI 库或构建环境。
- 预览右上角“审阅”显示页面/状态/弹窗选择器；太阳按钮切换主题。
- 所有数据模拟，不发送密码、行情请求或通知。图表仅为示意，正式 App 继续使用既有专业图表。

用户通过 web-library 授权发布，已于 2026-11-11 发布 A07 静态预览；发布当时未修改或部署应用。用户认可后，自选页已完成迁移和本地验证，随后按“认可 继续”更新到 Ubuntu 18445 验收实例，详见 `../../verification/android-personal/ui-a07-watch-20261111.md`。尚待真机验收，没有更新 PR 或运行 CI。

外网：https://pages.kookvv.com:8443/sites/market-watch-android-ui-preview/

内网：http://192.168.7.33:18090/sites/market-watch-android-ui-preview/

发布版本：`20261111T141241-24c80c6156`。内外网首页、A06 对照与 A07 单屏页面均验证 HTTP 200。

## 优化范围

1. 自选：数字对齐、字号层级、统一行高；默认保留告警角标，事件通知出现时让出第一条行情的位置。
2. 图表：统一周期/工具控件，紧凑报价，改善轴文字；继续以绘图区为主。
3. 告警：突出价格阈值，明确监控/暂停/异常/等待接管，统一卡片操作和错误反馈。
4. 数据：代码和名称分层，减少重复说明，来源、系列类型与周期保持可见。
5. 更多：成组列表、统一图标容器与当前值。
6. 共享控件：输入框、主题内选择弹层、模式按钮、48px 开关热区、弹层标题与主按钮、加载/空/离线/失败/冲突/能力限制等状态。

深浅主题、375/412px、横屏、150% 字号均检查。不是对 Android 真机效果的验收结论。

## 源码关系

`base.css`、`design.css`、`app.js`、`fixtures.js` 从 `../android-a-freeze-20261111/` 复制；A07 仅调整隔离存储、初始化、字号舍入及示意图高度等必要点。视觉与交互优化集中在 `refinement.css`、`refinement.js`，可核查其与原稿的继承关系。

`build_preview.py` 生成自包含 `preview.html` 和对照外壳 `baseline.html`。原冻结目录没有改动。

## 本地复现

仓库根目录执行：

```bash
python3 docs/prototypes/android-a07-refinement-20261111/build_preview.py
node docs/prototypes/android-a07-refinement-20261111/verify.cjs
```

使用已有 `web/node_modules/@playwright/test`；可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机 Chromium。验证仅读取本地 HTML，无容器、API 或 CI。

结果见 `evidence/browser-proof.json`；完整看图与修正记录见 `polish-log.md`。本轮为 P0 设计产物；遵循用户指示，暂不更新 PR、不跑 CI。
