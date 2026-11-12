# 自选页：当日历史补取、固定列与刷新手势

本轮在 `feat/android-personal-v205`（base v2.0.7）完成。先提交累计工作 `7f198fc7`，再单独提交本轮修改。按用户要求不推送、不更新 PR、不跑 CI。风险分类 F0：兼容新增 API/UI 行为，没有 schema 或持久格式变更；采用定向测试和 Ubuntu R1 验收。

## 行为与根因

- 新增供应商品种原来只订阅最新行情，sparkline API 只读缓存，因而缺少加入前的当日历史。新增单品种 `POST /api/market-data/sparklines/prepare`：复用供应商历史读取、缓存和租约，按服务器日界线请求已完成的日内 K 线。原批量读取 API 仍只读。保留认证和 CSRF；不创建后台任务或额外实时报价轮询。
- 页面先展示现有缓存，再最多并发两个可见品种补取；同一品种/日窗口成功后不重复准备。失败保留已有曲线，下一轮重试；手动刷新允许再次补取。请求最多 1600 点，窗口沿用 NY17/DST 或 UTC0。按根数读取可能跨过休市缺口取得少量前日记录，输出严格限定当前窗口。
- 实际验收暴露过 8 秒预算超时，因此历史准备采用至少 20 秒、且尊重来源现有请求预算（Yahoo 30 秒、FXCM 65 秒）的有限等待。来源限流/网络失败仍可能触发下一轮重试。
- 左列固定 6.2rem，三行展示代码 / 简短中文说明 / 供应商，自建和组合不显示供应商。长代码缩小字体。右列固定 5.2rem，涨跌幅与价格分别适配；外汇 5 位、日元报价 3 位，保留尾零；小数至少三位时最后一位上标、前两位强调。
- 添加和管理合并到一个省略号入口，另提供刷新操作；保持原有添加、分组、排序与移除行为。没有调整 sparkline 路径、配色或纵轴算法。
- 自选页关闭手势缩放，离开自选页恢复 viewport 设置。列表顶部单指下拉有阻尼、松手阈值和刷新动画；短拉、横滑、双指与取消手势不触发刷新。弹层、离线或刷新期间不重复触发。

## 验证

1. 最小复现：真实 SQLite 缓存只含当前一分钟，断言首个点必须回到日窗口开始；补取实现前失败，完成后通过。另覆盖超时保留尾段、非供应商品种不取数、认证/CSRF、服务器控制窗口、重复请求复用缓存。
2. 后端：`PYTHONPATH=backend python3 -m pytest backend/tests/test_sparkline_backfill.py backend/tests/test_sparklines.py backend/tests/test_provider_cache.py -q`，48 passed；三处 Python 文件 Ruff 通过。
3. 前端构建通过；在 `web` 目录运行 `node tests/mobile-sparklines.cjs`、`node tests/mobile-watch.browser.cjs`、`node tests/mobile-watch-a07.browser.cjs` 均通过。浏览器使用本机 Chromium 1243。覆盖缓存优先、并发上限、切换取消、日期边界、精度尾零、添加/管理、长代码与价格、大字号。
4. A07 浏览器检查包含真实 CDP 触摸：短拉不请求、达到阈值刷新并结束、双指操作后 `visualViewport.scale === 1`；8 组布局、3 组状态/入口、28 组窄屏/大字号控件，无 pageerror。见 [布局与手势证据](a07-feedback/watch-backfill/layout/proof.json)。
5. 真实 Dukascopy：EURJPY 从 0 点补到 693 点，首点比请求早约 11.6 小时；EURUSD 从 56 点补到 698 点，首点抵达本次 NY17 日界线。未修改用户自选列表。见 [EURJPY](a07-feedback/watch-backfill/eurjpy-history.json)、[EURUSD](a07-feedback/watch-backfill/eurusd-history.json)。最终候选另用无当日缓存 AUDJPY 验证，约 12.2 秒从 0 点补到 699 点，首点抵达日界线；见 [最终镜像补取](a07-feedback/watch-backfill/final-history.json)。
6. 部署实例 375/412 × 深浅色截图，逐行检查 72px 行高、42px 曲线高度、垂直居中、无溢出。375 下 sparkline 宽 167.4px，412 下 196.4px，各品种等宽；供应商标签没有平台/自建/组合分类文案。见 [实际页面测量](a07-feedback/watch-backfill/live/proof.json) 和 [前后对照](a07-feedback/watch-backfill/comparison.jpg)。前后行情时间、品种列表不同，不把曲线数值变化当成视觉修改。

## 本机运行与回退信息

- 实际主机：Ubuntu `quant-server` / `192.168.7.232`，独立 Docker project `mw-android-personal-v205`。
- 地址：<https://192.168.7.232:18445/m/>；shell `ede583bdcd108eef`。本轮没有重建 APK，已有 0.1.3 可在“更多 → 检查更新”加载新网页壳。
- web：`sha256:ee06e7b88076673c2ba99723c8ec4c6068bf34f0b2730ffc36bcbb88e6b223f1`。
- API：`sha256:8d3748b8fca87a41537657a9924a889c6a34c2777bc3bd8004ccc2316b46f6fd`。
- 仅替换 API/web，保留本项目 worker、TLS、数据库及数据。构建均使用 `mw-docker build --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance`。未操作 Unraid。
- 私有配置备份 `~/.local/share/market-watch-docker/previews/mw-android-personal-v205/before-watch-backfill-run.json`（0600），保存旧 API/web 镜像 ID。配置、密码和完整浏览器状态不进入仓库。

启动/更新命令（本轮已执行）：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait api web
```

只停止本轮两个服务的命令（留档，未执行）：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  stop api web
```

CA 校验 `/readyz` 和 shell manifest 通过。截图与浏览器手势验收通过，手机 WebView 的实际触感和显示仍需用户最终验收。
