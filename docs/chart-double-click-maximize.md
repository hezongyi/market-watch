# 主图空白处双击放大／恢复

用户于 2026-10-07 确认“验收正常”。本次 Ubuntu 实例已通过 `mw-docker retire --apply` 完成归档、实际恢复校验和精确清理；验收网址现已关闭。备份位于受限私有目录，不提交仓库。用户验收和退役记录见 [验收记录](verification/chart-double-click/user-acceptance.json)。后续启动使用新的任务／project，已结束的任务不能复用；下面的访问、启动和停止命令保留为本次运行记录。

当前基线：v1.12.1 `9670dae`，独立工作树 `/home/quant/repos/market-watch-double-click`、分支 `feat/chart-double-click-maximize`。最初基于生产 v1.12.0（源码 `0591e56`、文档提交 `cf84f03`）；2026-10-07 将本任务七个提交完整移植到 v1.12.1。两基线的行情后端与图表业务代码相同，功能改动仍限于双击钩子及其构建接入；未包含另一个部署认证任务的改动。

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

## Ubuntu Docker 验收实例（历史运行记录，已验收归档）

本次 project 固定为 `mw-chart-maximize-20261007`，独立默认网络、`maximize-pg` volume、`chart_maximize` 数据库和随机密码。初版仅有 `MAXFIXTURE` H1 合成数据，不能作为完整真实行情验收；这导致切换其他品种无本地历史行情，默认 Dukascopy 欧元／黄金在平台系列解析时出现 422。当前增加真实行情 overlay：API、Web、图表来源与 PostgreSQL 之外，运行 realtime、chart-history、chart-aggregation、native-history 四个独立 worker。欧元／黄金使用 OANDA，BTC 使用 Binance；行情重新从来源读取，不复用其他实例的数据库或生产数据目录。通知投递、MCP 和 Yahoo 保持关闭。

实际局域网入口：`https://192.168.7.232:17443/advanced-charts`，图表来源 `https://192.168.7.232:17444`。运行主机为 Ubuntu 22.04，Docker 服务端 29.1.3。应用及图表端口分别绑定 Ubuntu 局域网地址和回环地址，数据库不暴露；直接使用 IP 和端口，无需 SSH 转发、hosts 修改或任何 DNS 解析。`17443` 是登录和完整应用入口，`17444` 是嵌入图表的静态服务，单独打开后不会显示完整应用。

先打开 `https://192.168.7.232:17444/` 并接受本次验收自签名证书，再打开应用入口；主站若仍提示证书，接受同一验收证书即可。证书包含 Ubuntu IP。自动浏览器检查直接使用 IP，不设置 host resolver；另用 curl 显式信任本次证书，验证 IP SAN 和两个端口的 HTTPS 响应。

浏览器 Cookie 按主机与路径匹配，不按端口隔离；因此此前采用独立图表主机名。当前仅在此独立验收实例的 TLS 网关将应用 session Cookie 的路径改为 `/api`，登录和退出时清除旧的根路径 session。图表常规资源请求不携带该 Cookie；图表端口拒绝 `/api`、`/api/` 路径，并在静态代理中移除 Cookie、Authorization 和 CSRF 请求头。实际浏览器验证登录后的路径、旧 Cookie 清理、图表请求无凭据、退出后 session 为 401。Cookie Path 不提供不同主机的安全隔离，生产继续使用独立图表域名；这一 IP 配置仅服务于隔离的 Ubuntu 验收。

初版合成数据的直接 IP 验收 **4 项通过**，覆盖登录、退出与真实 API 保存／重载；此历史结果不代表欧元／黄金的真实行情已验证。当前真实行情检查和修复另见下文。运行与浏览器证据见 [局域网运行证据](verification/chart-double-click/lan-runtime.json) 和 [局域网浏览器验收](verification/chart-double-click/lan-browser.json)。验收密码保持不变，凭据不会写入这些报告。

之前仅回环部署时，另一台电脑需同时转发两个端口：`ssh -N -L 17443:127.0.0.1:17443 -L 17444:127.0.0.1:17444 quant@192.168.7.232`。2026-10-07 已复现未信任图表证书时的 `ERR_CERT_AUTHORITY_INVALID`，接受后 HTTP 200；用户补充双端口转发及证书后登录成功，完整应用验收再次通过。当前局域网模式不再需要该转发。

初版合成数据浏览器验收 **4 项通过**，仅覆盖四图含 RSI 的交互、API 保存和 PostgreSQL 重载；当时页面异常检查没有覆盖行情 API 的 422 及原生图表错误提示，不能证明真实行情可用。相关历史报告保留在 `product-browser.json`。当前真实行情检查将黄金 H1、欧元 H4、BTC M15、黄金 H1 放入四图，核验三个品种真实报价、同步状态与双击完整往返、RSI 保留、保存重载、Cookie 路径、退出和行情 API 无错误，另检查所有 frame 内不存在 ApiError 提示。切换同步状态后等待平台视区调整；跨真实市场的日期同步按原生日期对齐规则允许小于 0.1 px 的柱宽修正，但日期范围、品种周期、指标、画线和同步选择必须完全相同。无同步及柱宽同步仍要求全部状态严格相同；功能与同步实现没有为此修改。当前真实行情应用验收 **4 项通过**，行情 API 错误、页面异常和图表凭据泄漏均为空。当前报告见 [真实行情应用验收](verification/chart-double-click/live-browser.json)，另外已核验四图最新 K 线时间均处于各自当前周期、界面自选表三个品种报价均正常，见 [行情新鲜度](verification/chart-double-click/live-freshness.json) 和 [最终页面](verification/chart-double-click/live-browser.png)。图表合并资产仍为前述 `host.b094dc92d30c3ed8.js`。

实例运行、镜像任务标签、网络／卷归属、数据库及关闭通知／MCP／Yahoo 的结果见 [Docker 运行证据](verification/chart-double-click/docker-runtime.json)，完整应用浏览器结果见 [应用验收报告](verification/chart-double-click/product-browser.json)。迁移和合成数据 seed 均成功退出；API、PG 健康，Web、图表来源及 TLS 正常运行。这些是初版合成环境的历史证据；当前启用了行情 worker，通知投递仍关闭。当前服务与镜像状态见 [真实行情运行证据](verification/chart-double-click/live-runtime.json)。

准备私有配置（已有时拒绝覆盖；已有验收密码继续保留）：

```bash
python scripts/prepare_chart_maximize_acceptance.py
```

真实行情额外需要在受限 `api.env` 配置 `ALERTS_FX_SOURCE=oanda`、OANDA 账户与 token，以及必要的代理。当前只取用了 Ubuntu 既有开发实例的行情连接字段，用于行情读取；未复制其数据库、登录密码或其他配置。`configure_chart_maximize_live.py` 仅接受本任务数据库，校准无历史观测的欧元／黄金来源并创建“**双击放大验收 · 真实行情**”工作区，保留原合成工作区和用户内容，重复启动不重置工作区。

构建必须使用 Ubuntu 专用 `market-watch-ubuntu` BuildKit，登记本任务及验收用途；启动时不再次隐式构建：

```bash
mw-docker compose-build --repo . \
  --task mw-chart-maximize-20261007 --project mw-chart-maximize-20261007 \
  --purpose acceptance \
  --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  --file compose.chart-maximize.yaml --file compose.chart-maximize.lan.yaml \
  --file compose.chart-maximize.live.yaml
docker compose --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  -p mw-chart-maximize-20261007 -f compose.chart-maximize.yaml \
  -f compose.chart-maximize.lan.yaml -f compose.chart-maximize.live.yaml up -d --no-build --wait
docker compose --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  -p mw-chart-maximize-20261007 -f compose.chart-maximize.yaml \
  -f compose.chart-maximize.lan.yaml -f compose.chart-maximize.live.yaml exec tls nginx -s reload
docker compose --env-file /tmp/mw-chart-maximize-20261007/compose.env \
  -p mw-chart-maximize-20261007 -f compose.chart-maximize.yaml \
  -f compose.chart-maximize.lan.yaml -f compose.chart-maximize.live.yaml stop
```

上面的 TLS reload 在上游容器重建后重新解析本 project 内部服务地址，避免 Nginx 继续使用旧容器 IP。

已核实当前进程尚未载入 `docker` 补充组，但用户已加入该组；可用 `sg docker -c '<上面的 docker compose 命令>'` 启动或停止。`mw-docker` 自动处理这个组切换。

本次已执行以下精确退役流程，实际恢复成功后才删除资源并登记任务完成：

```bash
mw-docker retire --task mw-chart-maximize-20261007 --project mw-chart-maximize-20261007
mw-docker retire --task mw-chart-maximize-20261007 --project mw-chart-maximize-20261007 --apply
```

启动后应用链路验证：

```bash
LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu \
  MAXIMIZE_APP=https://192.168.7.232:17443 \
  MAXIMIZE_CHART=https://192.168.7.232:17444 \
  node web/tests/advanced-chart-maximize.product.browser.cjs
```

当前浏览器会打开最新的“**双击放大验收 · 真实行情**”工作区；若其他窗口仍显示 MAXFIXTURE，请刷新并在原生工作区菜单选择真实行情工作区。

随机验收登录数据仅位于 `/tmp/mw-chart-maximize-20261007/login.json`，其他 env、证书及私钥均在同一受限目录，不提交仓库。

本次用户验收已通过，12 个本项目容器、1 个独立 PG volume 和网络已清理，无引用的任务镜像已按任务标签回收；共享 PG／Nginx 基础镜像保留。两个非 template 数据库的备份均在 Ubuntu 实际恢复并核对所有 public 表行数通过。初次退役因工具只识别 `postgres` 服务名被拒绝，随后在独立运维分支修正：按受支持 PG 镜像和挂载识别 `pg`，TLS 核验固定官方 digest 与实际镜像 ID，应用镜像仍强制匹配全部任务标签。32 项工具检查通过，工具修正提交为 `7c756d7`。功能代码仍在隔离分支；生产只读状态核实为 v1.12.0，尚未正式发布本次功能。
