# 自选页：刷新收起、价格约束与曲线空间

分支 `feat/android-personal-v205`，前序提交 `43224c6f`。本轮为 F0 兼容前端修正，采用构建、定向回归和同项目 Ubuntu R1。遵从用户要求，不更新 PR、不跑 CI。

## 修复与样式

下拉动画原来等待整批报价和全部历史补取。每两个品种一组的历史请求可能累计几十秒；报价连接切换后也会延后整批完成。新增“当前缓存观察读取完成”回调，动画只等待自选列表与当前可见缓存走势读完。供应商报价和历史准备继续更新，保留已有走势、重试和取消处理；不靠固定倒计时假装完成。移除跨报价/曲线两条链路的完成位标记；旧刷新失败不再关闭新一轮动画。收起增加 160ms 过渡，减少动态效果模式不添加该过渡。

价格保留末两位放大与最后一位上标，所有数字继承灰色及常规字重。价格行与涨跌幅行均明确限制在固定列内，让 FitText 在真实可用宽度测量，长黄金报价及长价格在列内缩小，不向曲线区绘制。

左右固定列从 6.2rem/5.2rem 收紧至 5.7rem/4.8rem，左右页面留白 16px、列间隔 6px。375px 屏幕曲线从约 167.4px 增至 184.0px（约 10%），412px 从 196.4px 增至 221.0px（约 13%）。代码原字号不变，中文说明和供应商名称从 12px 减为 11px（默认 14px 根字号）。72px 行高及 42px 曲线高度保持。

面积渐变稍加深：浅色顶/中段透明度 0.22/0.08 → 0.28/0.11，深色 0.18/0.06 → 0.24/0.09，底部仍为零。横向价格参考线（原有昨收基准）与竖线统一使用 muted 色与 0.12 透明度；没有更改基准值或折线价格。

## 复现与验收

- 单元复现：缓存读完但历史 Promise 不返回，新增“可见刷新应完成”断言；修复前 `0 !== 1`，修复后通过。浏览器真实触摸复现旧代码：历史挂起时 `toBeEmpty` 在 1500ms 超时，提示持续“正在刷新…”。
- `npm --prefix web run build` 通过；在 web 目录运行 `node tests/mobile-sparklines.cjs` 和 `node tests/mobile-watch-a07.browser.cjs` 通过。后者覆盖 8 组布局、28 组窄屏/大字号控件，以及同时挂起报价/历史时下拉及时收起、短拉不刷新、双指不放大。
- 固定列检查包括黄金三位小数 `2,684.520`、日元三位、外汇五位和超长价格；逐项测量价格文字位于本列边界内，所有行曲线等宽。检查放大数字与其余价格的颜色/字重一致、横竖参考线颜色/透明度一致、两行次要文字均为 11px。
- 本机真实行情截图 375/412 × 深浅四组：黄金价格在列内，各行曲线等宽，72px 行高、42px 图高、无溢出及 pageerror。手势验收时只拦截并挂起供应商报价/历史请求，保留真实偏好与缓存走势接口，以此证明动画没有等待它们。最终镜像实测约 1.9 秒收起，此时 2 个报价请求和 2 个历史准备请求仍挂起；无页面错误及通知。详见 [实际测量](a07-feedback/watch-refresh-polish/live/proof.json)、[布局回归](a07-feedback/watch-refresh-polish/layout/proof.json)、[前后截图](a07-feedback/watch-refresh-polish/comparison.jpg)。前后行情时间不同，数值与曲线变化不作为样式对比依据。

## Ubuntu 验收实例

实际主机 `quant-server` / `192.168.7.232`，独立 project `mw-android-personal-v205`。地址 <https://192.168.7.232:18445/m/>。本轮仅替换 web；API、worker、数据库和用户自选保留。资源预检约 9.4GiB 可用内存、25GiB 剩余磁盘，复用本项目端口，无新增服务。未操作 Unraid。

shell `dfc3cd3d47b89216`，web 镜像 `sha256:f1d01b01157907ea0d38080157af5cf3e62beaea7e68915a474078418049ce4d`。由 `mw-docker build --repo . --component web --context . --file web/Dockerfile --tag market-watch-web:android-personal-v205-refresh-polish --task mw-android-personal-v205 --project mw-android-personal-v205 --purpose acceptance` 构建。私有旧配置留档 `before-watch-refresh-polish-run.json`（0600），含上一轮 web 镜像；不提交私有配置及凭据。

更新/启动命令已执行：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

仅停止本轮网页服务的命令（留档，未执行）：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  stop web
```

CA 校验 `/readyz`、shell manifest 成功。现有 APK 从“更多 → 检查更新”取得新壳，手机 WebView 的最终显示/手感验收待用户完成。
