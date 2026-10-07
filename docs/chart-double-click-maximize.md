# 主图空白处双击放大／恢复

基线：生产 v1.12.0（源码 `0591e56`），从带生产验证文档的 `cf84f03` 建立独立工作树 `/home/quant/repos/market-watch-double-click` 和分支 `feat/chart-double-click-maximize`。

## 操作

桌面多图布局中，鼠标左键双击主图绘图区空白处，最大化被双击的整张图表；再次双击空白处恢复多图。无需先点击选中目标图，最大化按钮和 `Alt + Enter` 可与双击交替使用。

命中 K 线、指标、画线及控制点时保留原生属性操作；价格轴、时间轴、分隔线保留原生重置。RSI 等副图空白处继续原生窗格最大化／恢复。单图、只读模式、触屏、带修饰键的双击以及绘图／测量／框选缩放不执行整图切换。

`chart-maximize.js` 复用原生图表实例的 maximize/restore 接口，不重建 iframe、不切换成单图布局、不调用图表 reset。原生补丁仅在未命中源对象、没有绘图进行中且选中集合为空的分支转交；两次鼠标按下时都必须是空白位置及光标工具，避免工具完成后恢复光标导致误触。

尺寸变化期间暂不传播原生日期同步，待图表宽度及窗格高度连续三个渲染帧稳定后恢复传播，逻辑同步开关保持原值。实际鼠标缩放继续正常同步。工作区重建及页面离开取消未完成的尺寸观察。

许可库补丁先还原并核对 v31.1.0 原始 SHA-256，然后检查唯一锚点；支持从 v1.12.0 的完整补丁升级、重复安装和逐字节撤回。许可库和凭据均不进入 Git。

## 验证

真实许可图表库测试使用 Playwright 路由提供静态文件及合成行情，没有监听服务、后端、生产请求或持久化库。这些结果仅证明图表交互，不代表 Docker 应用链路验收完成。

```bash
cd /home/quant/repos/market-watch-double-click
node web/tests/advanced-chart-maximize-patch.cjs
LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu \
  node web/tests/advanced-chart-maximize.browser.cjs
```

`LD_LIBRARY_PATH` 使用本机已有、解包到临时目录的浏览器依赖；若系统已安装这些依赖可省略。测试检查非活动图、不同品种和周期、指标及画线保留、快捷键交替、画线／测量／框选工具、K 线和画线属性、轴双击、副图、快速切换、日期和柱宽同步及恢复后的实际滚轮、真实拖动分隔线的双图、八图、单图、只读、触屏和工作区销毁。CPU 4 倍限速用 `MAXIMIZE_CPU_RATE=4`；报告通过 `MAXIMIZE_OUTPUT` 指定。

最终正常速度和 CPU 四倍限速各 **22 项通过**，页面异常均为空。原有 `advanced-sync-coordinator.cjs`、`advanced-sync-native-choices.cjs`、Web 构建、补丁升级／撤回／拒绝篡改、合并图表资产语法及模块包含、Python lint、Compose 配置校验均通过。最终测试报告和源码 SHA-256 绑定见 [验证清单](verification/chart-double-click/verification.json)、[正常速度](verification/chart-double-click/native-browser.json)及 [CPU 四倍限速](verification/chart-double-click/native-browser-cpu4.json)。合并图表资产为 `host.b094dc92d30c3ed8.js`。

补充生产构建接入检查 **4 项通过**：用上述合并资产运行真实 bridge，在关闭同步、柱宽同步、日期同步三种状态下双击并恢复含 RSI 的四图工作区；保存到内存父窗口 RPC 后重载，再次双击正常。报告见 [合并资产与 bridge 验证](verification/chart-double-click/built-bridge-browser.json)。此检查只替代父窗口存储和行情 RPC，不启动后端或数据库，不能作为完整 Docker 应用链路验收。

复跑该检查需先将 `advanced-host` 与私有许可库复制到临时构建目录并在该目录执行 `node patch-native-reserve.mjs`、`node build-assets.mjs`，以免改写源码目录的 `index.html`：

```bash
LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu \
  MAXIMIZE_ASSETS=<临时构建目录> \
  node web/tests/advanced-chart-maximize.bridge.browser.cjs
```

## Ubuntu Docker 验收实例（已运行，供用户验收）

本次 project 固定为 `mw-chart-maximize-20261007`，独立默认网络、`maximize-pg` volume、`chart_maximize` 数据库和随机密码。只填充标记为合成行情的 `MAXFIXTURE` H1 数据；不复制生产数据库、配置、通知或凭据，不启动行情采集和通知 worker。

实际局域网入口：`https://192.168.7.232:17443/advanced-charts`，图表来源 `https://charts.192.168.7.232.sslip.io:17444`。运行主机为 Ubuntu 22.04，Docker 服务端 29.1.3。应用及图表端口分别绑定 Ubuntu 局域网地址和回环地址，数据库不暴露；无需 SSH 转发即可在局域网访问。图表独立域名经 DNS 解析到同一 Ubuntu IP，避免按 IP 登录的 session Cookie 跨端口发送到图表服务。

首次访问先打开图表来源并接受本次验收自签名证书，再打开主站并接受证书。证书包含 Ubuntu IP 和图表域名；若局域网 DNS 拒绝域名解析，将 `192.168.7.232 charts.192.168.7.232.sslip.io` 加到访问电脑的 hosts。域名只解析 IP，网站及图表均由本机 Docker 提供。

之前仅回环部署时，另一台电脑需同时转发两个端口：`ssh -N -L 17443:127.0.0.1:17443 -L 17444:127.0.0.1:17444 quant@192.168.7.232`。2026-10-07 已复现未信任图表证书时的 `ERR_CERT_AUTHORITY_INVALID`，接受后 HTTP 200；用户补充双端口转发及证书后登录成功，完整应用验收再次通过。当前局域网模式不再需要该转发。

应用浏览器验收 **4 项通过**，页面异常为空：关闭同步、柱宽同步、日期同步三种状态下，四图含 RSI 的双击放大／恢复完整往返；通过真实 API 保存工作区到 PostgreSQL，页面重载后四图及 RSI 保留，再次双击往返通过。数据库实际包含 1200 根合成 H1 K 线及对应发布记录。生产构建资产的 SHA-256 与前述浏览器测试资产一致。

实例运行、镜像任务标签、网络／卷归属、数据库及关闭通知／MCP／Yahoo 的结果见 [Docker 运行证据](verification/chart-double-click/docker-runtime.json)，完整应用浏览器结果见 [应用验收报告](verification/chart-double-click/product-browser.json)。迁移和合成数据 seed 均成功退出；API、PG 健康，Web、图表来源及 TLS 正常运行。未使用生产数据或配置，未启动采集和通知 worker。

准备私有配置（已有时拒绝覆盖）：

```bash
python scripts/prepare_chart_maximize_acceptance.py
```

构建必须使用 Ubuntu 专用 `market-watch-ubuntu` BuildKit，登记本任务及验收用途；启动时不再次隐式构建：

```bash
mw-docker compose-build --repo . \
  --task mw-chart-maximize-20261007 --project mw-chart-maximize-20261007 \
  --purpose acceptance \
  --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  --file compose.chart-maximize.yaml --file compose.chart-maximize.lan.yaml
docker compose --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  -p mw-chart-maximize-20261007 -f compose.chart-maximize.yaml \
  -f compose.chart-maximize.lan.yaml up -d --no-build --wait
docker compose --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  -p mw-chart-maximize-20261007 -f compose.chart-maximize.yaml \
  -f compose.chart-maximize.lan.yaml stop
```

已核实当前进程尚未载入 `docker` 补充组，但用户已加入该组；可用 `sg docker -c '<上面的 docker compose 命令>'` 启动或停止。`mw-docker` 自动处理这个组切换。

用户验收结束后先查看本任务精确清单，再执行归档、实际恢复校验与清理。验收仍在进行时不得登记任务完成：

```bash
mw-docker retire --task mw-chart-maximize-20261007 --project mw-chart-maximize-20261007
mw-docker retire --task mw-chart-maximize-20261007 --project mw-chart-maximize-20261007 --apply
```

启动后应用链路验证：

```bash
LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu \
  MAXIMIZE_APP=https://192.168.7.232:17443 \
  MAXIMIZE_CHART=https://charts.192.168.7.232.sslip.io:17444 \
  node web/tests/advanced-chart-maximize.product.browser.cjs
```

随机验收登录数据仅位于 `/tmp/mw-chart-maximize-20261007/login.json`，其他 env、证书及私钥均在同一受限目录，不提交仓库。

实例保留运行供用户手动验收，Docker 生命周期任务保持进行中；用户验收结束后按上述 `retire` 流程归档、恢复校验及精确清理。功能和应用验收代码均位于隔离分支，未合并、推送或操作 Unraid 生产。
