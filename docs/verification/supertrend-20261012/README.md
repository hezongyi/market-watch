# Supertrend Python V1 验收

Ubuntu 主机 `quant-server`；本机隔离 checkout：`market-watch-supertrend-20261012`；分支：`feat/supertrend-pine-v1-20261012`。
新增独立 `SUPERTREND_PINE_V1`，保留内置 SuperTrend。Python 是唯一数值计算来源；原生 study 映射线、圆点、标签与填色。用户视觉参考已保存为 [原截图](../../references/supertrend-user-reference.png)。

## 数值证据

参考文件：[原 Pine v4](../../references/supertrend-pine-v4-20261012.pine)。
SHA256：`3ddd7b5dc61b285ff7c3932255bd0d66ce427a9e17edcca87322b05a384a6ce8`。
来源为用户提供的代码，未经第三方版本替换，未推断作者或许可证。

冻结夹具是手工按源码规则算出的期望值，**不是 Pine 引擎导出**。
同一递归 step 覆盖批量、持久检查点与临时末柱计算。Wilder 的首次 TR 为 H−L；SMA 的裸 TR 跳过无前收盘的首柱。比较使用上一根边界；信号位置使用本根更新后的边界；等于边界不翻转，启动看涨不产生 Buy。

已验证：两种 ATR、七种 source、默认值与极值、预热/周期 1、严格边界、缺口/正常周末、分页/检查点、历史修订、多 spec 共享、盘中翻转撤回与再次出现。保留旧 `fixed-indicator-state-v3`，新指标使用 `supertrend-pine-state-v1`。

官方来源核实 Pine v4 命名色 green `#4CAF50`、red `#FF5252`、white `#FFFFFF`，及 fill 默认透明度 90：

- https://www.tradingview.com/pine-script-docs/v4/essential/colors/
- https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-5/
- https://www.tradingview.com/pine-script-docs/v4/annotations/filling-in-the-background-with-fill/

本机许可库的 TR 定义补充验证 `atr` 使用 `tr(true)`；裸 TR 无前收盘时为 NaN。未提交许可资源。

## 运行与重现

主机为 Ubuntu；Compose project/task：`mw-supertrend-20261012`。专用数据库、网络、volume 与端口，不涉及 unraid。

- 应用：http://localhost:20187/advanced-charts
- 图表 origin：http://localhost:20188
- API：`127.0.0.1:20189`
- PostgreSQL：`127.0.0.1:20190`

在实现 checkout 根目录执行：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-supertrend-20261012/acceptance.env -p mw-supertrend-20261012 -f deploy/ubuntu/supertrend.acceptance.yaml up -d --no-build'
sg docker -c 'docker compose --env-file /tmp/mw-supertrend-20261012/acceptance.env -p mw-supertrend-20261012 -f deploy/ubuntu/supertrend.acceptance.yaml stop'
```

私有登录密码：`/tmp/mw-supertrend-20261012/login-password`；配置只保存在同目录受限文件中。不要提交、复制到公开文档或输出凭据。

浏览器脚本使用真实应用/API/原生运行库，没有拦截行情响应：

```bash
cd web
NODE_PATH=/home/quant/repos/market-watch/web/node_modules \
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
node tests/supertrend-native.browser.cjs
```

也可设置 `MW_SUPERTREND_TICKER` / `MW_SUPERTREND_RESOLUTION` 验证任务数据库中的固定合成序列。合成序列使用 seed 117，完全独立于 OANDA。

## 原生运行库诊断

运行库实际只接受 shape `location:"Absolute"`；声明中 AbsoluteUp/Down 在此版本报错。label_up/down 提供尖角朝向，圆点与标签共享同一绝对价格。

真实行情曾反复出现 loading，根因是实时推送仅裁剪 bars，仍携带全部递归指标前缀；五个 plot 订阅触发 `delivery_budget`，不断重载。修复在交付边界按实际交付 bar 的 start 裁剪指标值；计算依赖起点和共享快照保留。回归覆盖五订阅、不同消费窗口、日线 start/chart_time 区别及 null 事件。

前端采用两条 2px LineWithBreaks、tiny 圆点和标签、90% 透明度填色。OHLC4 参考 plot 不显示主体，保留参考图例值；direction 不订阅。showsignals 只隐藏标签，highlighting 只隐藏填色。真正缺口使用显式 break 标记，周期 1 的缺口柱在绘图侧空置以断开线/填色，后台数值保留。

## 证据边界

价格使用 OANDA bid 与来源交易日历；用户视觉参考是 FXCM。价格和翻转日期不要求跨供源一致，不平移价格匹配截图。
尚无相同 OHLC 的原 Pine 引擎导出，不能宣称逐根与 Pine 引擎证明等价。
关闭 highlighting 采用不绘制填色；Pine 原文 white 分支在暗色图上的细微白色效果未获 Pine 引擎对照。fillgaps=false 是明确防止跨真实缺口填色的产品映射，不作为已证明的 Pine 默认语义。

## 最终验证结果

| 检查 | 结果 / 证据 |
| --- | --- |
| 数值与框架广泛回归（修复推送前） | [372 passed, 14 skipped](python-tests.txt)，跳过需要独立 PG 的用例另行执行 |
| 最终数值/目录/检查点/MCP | [174 passed](python-final-tests.txt) |
| 最终固定指标真实 PostgreSQL | [14 passed](postgres-final-tests.txt)，每个用例独立临时 schema |
| 修复推送后的实时协议回归 | [46 passed](stream-tests.txt) |
| 多 plot 推送超限真实 PostgreSQL | [1 passed](stream-postgres-tests.txt) |
| 实际 OANDA 日线浏览器 | [结果](browser-oanda.json)，多实例、当前有效 plot 值、Boolean 设置、模板、服务器保存恢复、参数与样式；无 delivery_budget reset |
| 固定历史与旧指标原生回归 | [结果](browser-fixed-regression.json)，旧八个 Python 与内置 SuperTrend 均实际暴露有限 plot 值 |
| 合成盘中/缺口原生探针 | [结果](browser-profile.json)，Sell→撤回→Sell，同一末柱时间；周期 1 缺口前后 8.00、缺口柱 ∅，后台仍为 8 |
| JS 契约 | supertrend-python-indicators、advanced-python-indicators、advanced-indicator-picker、advanced-fixed-indicators、native-indicator-identity 全部通过 |
| 静态检查 | 修改的 Python 文件 Ruff 通过；git diff --check 与浏览器脚本语法检查通过 |

20,000 根本机 Python 样本：[load.json](load.json)，批量约 0.126s、逐步约 0.086s、检查点 403 bytes。此样本只衡量本地数值核心，不等于供应商网络或 Docker 吞吐测量。

人工检查截图：

- [OANDA 日线暗色](oanda-dark.png)、[浅色](oanda-light.png)：双色断线、tiny 标签尖角与圆点位于同一边界，半透明区域在 OHLC4 与活动边界之间，无额外蓝色参考曲线。
- [展示开关关闭](switches-off.png)：保留双色线与圆点，标签/填色消失。
- [Sell 出现](intrabar-sell.png)、[撤回](intrabar-retracted.png)、[再次出现](intrabar-sell-again.png)：最右末柱的 Sell 标签随当前方向撤回、恢复。
- [周期 1 真缺口](gap-period-one.png)：线与填色均留出断口，没有零价线或跨缺口填色。

实现验收结束时独立实例保留运行供本机审阅，未做生产部署、推送远程分支或发通知；后续 PR 交付状态见下节。退役时按 deploy/ubuntu/README.md 的精确项目流程进行数据库归档与真实恢复校验；未执行全局清理。

## PR 集成复验

提交 PR 前合入 `main` 的 `cbd0477`，保留 Swing 的扩展 presentation、展示参数及原生偏移行为。合并后的目录同时注册两个指标，旧固定状态版本继续供 Swing 和原有八个指标使用。

- [合并后 Python 回归](merge-python-tests.txt)：235 passed，覆盖 Supertrend、Swing、目录、固定历史、检查点、MCP、实时推送及供源 worker。
- [合并后真实 PostgreSQL 回归](merge-postgres-tests.txt)：63 passed，覆盖固定指标、Swing 及实时推送，每个用例使用任务数据库中的隔离 schema。
- JS 七组契约通过：Supertrend、Swing adapter、Python adapter、固定指标、搜索、原生身份及中文标签。
- [合并后原生合成探针](merge-browser-profile.json)：同一末柱信号翻转与撤回、周期 1 真缺口通过；这是读取当前 adapter 源码的原生库探针，不等于 OANDA 全栈验收。
- [实际登录再次复验](browser-login-recheck.json)：30 次指标响应全部 HTTP 200，无页面异常或 reset；设置、开关、暗色及浅色截图再次逐张人工检查。

上述首次集成复验的 Docker 镜像和登录截图对应实现提交 `f4aeaaa`；当时合入 main 后尚未重建镜像。PR #52 后续修复与完整重建复验见下一节，仍未部署生产。

## PR #52 阻塞修复与最终复验

复审发现旧 `/chart-workspaces` 接口把原生 profile 暴露给只支持数字参数和通用折线的渲染器，导致 Supertrend 枚举无法编辑、全部六输出误绘。修复在旧目录接口排除原生 `render_profile`，保留八个通用指标；专业图表目录、算法及保存接口仍提供 Supertrend 和 Swing。

认证接口回归已先复现失败，再修复通过；同时断言旧目录八项、高级目录两个 profile。完整后端回归再次运行：[235 passed](review-fix/python-tests.txt)。

实际应用代码提交为 `a8e4ae8`。通过 `mw-docker build` 重建 API、web 和 chart 三个镜像，任务/项目为 `mw-supertrend-20261012`、用途 `acceptance`、工作树干净，详见 [镜像身份](review-fix/images.json) 与 [运行服务](review-fix/runtime.json)。仍使用 Ubuntu 主机 `quant-server` 及上面的同一隔离 project、数据库和端口。后续提交只修正浏览器验收脚本的工作区读取接口及添加证据，不改变镜像中的应用代码。

重新实际登录并运行增强的浏览器验收：

- [OANDA 实际行情](review-fix/browser-oanda.json)：27 次指标响应全部 HTTP 200，无页面异常、无 reset。验证旧页面八项选择器、SMA 周期 11 编辑与服务器保存；两个 Supertrend 与 Swing 同时有有效原生值；模板与服务器保存/重载恢复三个实例的独立计算参数、展示参数和 Supertrend 样式。
- [固定历史完整应用回归](review-fix/browser-fixed-regression.json)：任务 PostgreSQL 的 seed117 合成 OHLC，经真实 API/原生库运行，13 次指标响应全部 HTTP 200，无页面异常或 reset。验证旧八个 Python 指标与内置 SuperTrend 均有有效原生值；同时重复共存、保存恢复及目录验收。这是固定合成历史，不作为 OANDA 数值证据。
- 以下七张新截图已逐张打开人工检查：[旧工作区参数](review-fix/legacy-catalog.png)、[Supertrend/Swing 共存](review-fix/swing-coexistence.png)、[服务器恢复后共存](review-fix/swing-restored.png)、[原生设置](review-fix/settings.png)、[标签/填色关闭](review-fix/switches-off.png)、[暗色](review-fix/native-dark.png)、[浅色](review-fix/native-light.png)。旧页面截图使用空的自建行情，证明目录/参数保存；专业图表截图使用实际 OANDA，趋势线、信号、圆点及填色正常，Swing 圆点不影响 Supertrend 独立设置。

Standards 和 Spec 两轴复审均无剩余阻塞，原 P2 已解决；详见 [复审结论](review-fix/review.md)。前述同 OHLC Pine 引擎对照、填色产品映射和非穷举组合的证据边界仍然适用。
