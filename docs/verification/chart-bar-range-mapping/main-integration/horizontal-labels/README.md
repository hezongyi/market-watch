# 左右退避验收（2026-10-07）

当前Ubuntu隔离候选：`mw-range-main-chart:horizontal-labels1` / `host.c457e1eb70767468.js`。标签纵向固定，只左右找最近合法位置；三段直角引线保留真实极值bar锚点。无空间隐藏，不上下退避，不改价格轴。

[summary.json](summary.json)记录54项/4组浏览器及独立21项模块结果。[runtime.json](runtime.json)记录运行镜像及22个JS模块/CSS摘要；[sha256.json](sha256.json)绑定归档文件、解压后原始JSON与测试源。geometry/stability采用mtime=0的无损gzip，已验证解压字节等于/tmp原始报告。

[horizontal-retreat.json](horizontal-retreat.json)及[截图](horizontal-retreat.png)：真实BTCUSDT H1→M5，高低价同时显示，两个目标低价左移12.08px/20.81px，y固定。测试仅用原生时间/价格可见范围准备场景，然后实际鼠标hover；不替换行情、障碍或mapping回调。全部标签及引线的K线、图例和相互碰撞断言通过。

`diagnostics/initial-daily-no-retreat-sample.json`保留最初D1→H1未找到双标签退避样本的结果，不作为通过证据。rectangle-ui8的134项浏览器是历史候选记录，不累加至本轮54项。

复测从仓库根串行执行（本地凭据只经私有文件读取）：

```bash
export RANGE_APP=https://192.168.7.232:16843
export RANGE_CHART=https://192.168.7.232:16844
export RANGE_LOGIN=/home/quant/repos/.acceptance/range-main-20261006/login.json
export LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu
RANGE_OUTPUT=/tmp/mw-horizontal-geometry.json node web/tests/advanced-sync-settings-geometry.browser.cjs
RANGE_OUTPUT=/tmp/mw-horizontal-stability.json node web/tests/advanced-range-v180-stability.browser.cjs
RANGE_OUTPUT=/tmp/mw-horizontal-settings.json node web/tests/advanced-sync-settings.browser.cjs
RANGE_OUTPUT=/tmp/mw-horizontal-retreat.json node web/tests/advanced-range-horizontal-retreat.browser.cjs
node web/tests/advanced-bar-range-exterior-labels.cjs
```

当前实例与准确启动/停止命令见[main集成验收](../../../../chart-range-main-integration-acceptance.md)。用户已人工通过柱宽同步；左右退避仍待人工验收。未合并PR、未部署生产、未操作unraid。
