# 生产验收问题修复与 Ubuntu 验证（2026-10-12）

修复原报告 UX-01—UX-07，并落实 S-01、S-03；S-02 单独复验既有恢复入口后保留建议。依据是 `/tmp/market-watch-ux-fixes-handoff-20261012-kjs8hlt_.md` 和历史验收文档 PR #49。本分支从 `7f80f72` 创建，原报告、生产数据、正式版本及其交付证据未修改。

## 修改与逐项证据

| 编号 | 最终行为 | 验证 |
| --- | --- | --- |
| UX-06 | 长卡片文字有宽度边界；弹窗内部滚动、固定可达操作区 | 构建应用的120项浏览器断言；真实Ubuntu 375×812、390×844、844×390触摸取消和POST201保存；比较visualViewport、弹窗及关闭／提交按钮边界 |
| UX-01 | 品种标题可读，黄金／欧元图标正确；来源、环境、账户范围、基准与日界保持可见，内部ID进入详情／复制 | 普通、显式自建、平台来源及未知长名称fixtures；真实OANDA practice长ID保存／刷新后绑定完全相同；组合仍显式选择，未猜测同名映射 |
| UX-07 | Esc、关闭、取消恢复发起按钮焦点，对话框有名称 | 鼠标／Enter／Space与三种关闭方式组合，四个视口；两个发起按钮；真实触摸取消及保存恢复焦点；最终保存复验发现RAF早于模态卸载的竞态，改为关闭提交后的effect恢复，连续四轮通过 |
| UX-02 | 三个现行worker独立业务心跳、成功轮次、任务统计／最近进展；兼容补数单独配置 | 最终实际同时停止全部四角色，等待原300秒阈值均stale；逐个恢复history_versions、chart_history、native_history、legacy_import，每步仅对应角色running；最终全部running。异常重试保留故障直到成功，目录刷新失败仍继续执行导入 |
| UX-04 | Dukascopy SDK股票组进入股票类，ETF／期货独立；具体合约类型未核实时明确标注 | AAPL、0700.HK、7203.JP、ETF及期货分类／关键词／来源组合后端回归；真实原生数据中心AAPL、0700.HK、7203.JP＋股票＋Dukascopy筛选可见 |
| UX-05 | 展示已登记／来源目录／平台已用／来源配置及用途、独立审核对象 | BTCUSDT真实原生窗口两条对象可区分；后端保留独立row_id与未核实状态；真实OANDA已登记／目录／配置账户范围、独立ID、用途与核实计数；未核实不提升；OANDA身份／会话审核相关回归通过 |
| UX-03 | 原生摘要读取内置localized metadata或Python参数元数据，告警参数／输出标签可读，技术键在详情保留 | 真实原生MACD参数17/31/7及Python19/35/11摘要；告警手选MACD默认12/26/9和改21仍用真实键；真实Python study对象入口、calculation origin、UI POST201保存19/35/11，图表改23/39/13后告警不变；手选改21/26/9并POST201；reload后两条列表与快照均持久化 |
| S-01 | 带入当前周期，说明当前价格身份与组合不兼容时需要明确选择 | BTCUSDT M5 fixture；组合默认未自动选定，提交保持禁用 |
| S-02 | 保留原有手动轴行为，既有右键“重置图表视图”恢复自动缩放 | 合成FX→股票原生切换后auto=false，但范围已更新至315—324，没有复现保留旧外汇范围；重置后auto=true。一次切换不证明普遍故障已归因 |
| S-03 | 演练创建／恢复后收起新建表单、播放控制置于图表前并聚焦；重新展开保留输入；完成项默认收起，失败／运行／待核查可见 | 真实固定发布历史UI POST201、下一根／播放暂停推进真实cursor、无未来柱、reload恢复同manifest/cursor；375/390/844/1440 controls可达；31完成默认折叠、失败重试按钮可见；未请求上游重试 |

## 验证范围与限制

178项相关后端回归通过；Ubuntu Docker PostgreSQL验证18项通过，包含真实事务冲突、回滚及控制状态重读；生命周期56项测试及15项subtests通过。前端tsc、Vite和数据中心bundle构建通过，仅有既有大chunk提示。证据见[索引](verification/production-ux-fixes-20261012/README.md)。

原生窗口使用本机已许可库，库文件不提交；图表价格来自本任务显式合成缓存，用于UI／轴行为，不能证明供源价格或覆盖。Dukascopy官方股票网页连接超时，SDK分组只证明股票类别，因此未将全部股票宣称为已核实CFD或股票所有权。实际价格身份和来源参数未修改。

第二轮已补齐实际Python对象入口的创建／保存／刷新，实际演练播放与恢复，以及全部四角色独立停止／恢复。最终留存的33张真实网页登录截图已逐张打开视觉复核，SHA256及尺寸见 [round2/visual-review.json](verification/production-ux-fixes-20261012/round2/visual-review.json)。第一轮原证据保留，其“对象入口未完成”只代表历史状态，最终结论以round2为准。

本次没有验证告警worker端到端判定、真实通知投递、手机响铃、实机／Safari、长期稳定性，也没有新增生产部署。手机截图为Chromium触摸和viewport模拟。S-02只复验既有reset恢复autoscale，不宣称普遍轴问题已归因或改为自动重置。正式页面修复后的只读复验需在后续授权发布后执行。

## 实际环境与复现

第二轮实际运行主机为Ubuntu `quant-server`，本机Docker，builder `market-watch-ubuntu`。独立task/project `mw-ux-acceptance-20261012-r2`，数据库 `production_ux_acceptance`，volume `mw-ux-acceptance-20261012-r2_pg-data`，独立网络。运行时网页 `http://127.0.0.1:19981/`、专业图表来源 `http://127.0.0.1:19982/`，两端口只监听loopback。第一轮 `mw-production-ux-20261012`／19971／19972已退役，没有复用。没有操作unraid或其他任务实例。

本轮镜像 `market-watch-api:ux-acceptance-r2`、`market-watch-web:ux-acceptance-r2`、`market-watch-chart-origin:ux-acceptance-r2` 均经 `mw-docker build`构建。web最后构建包含焦点修复，chart最后构建包含参数说明布局。标签记录本分支HEAD和dirty状态；实际执行tree与本次提交一致。构建检查为tsc、Vite及数据中心bundle。

重建时必须用新task/project、新镜像标签与独立凭据；不要复用退役任务。私有目录0700，env／password／health.override.yaml为0600，不提交。env包含独立DB密码、argon2登录hash、三镜像引用及 `MW_UX_WEB_PORT`、`MW_UX_CHART_PORT`。没有真实供源token；通知、Yahoo与OANDA stream在此验收实例显式关闭，不改变生产Yahoo默认。固定历史经真实导入／聚合／发布流程生成合成M1/H4/D1，组合经真实映射／first_use生成；合成token marker仅在seed短进程内使用，不能读取供源。chart worker只绕过本次上游目录刷新，业务cycle、执行器与DB心跳仍真实运行。

可按下列命令重建（先准备私有文件，替换新任务名和标签，确保端口空闲）：

```bash
export MW_UX_PROJECT=mw-ux-acceptance-new
export MW_UX_BASE=http://127.0.0.1:19981
export MW_UX_CHART_ORIGIN=http://127.0.0.1:19982
mw-docker build --repo . --component api --tag market-watch-api:new --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT" --purpose acceptance
mw-docker build --repo . --component chart --tag market-watch-chart-origin:new --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT" --purpose acceptance
mw-docker build --repo . --component web --tag market-watch-web:new --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT" --purpose acceptance --build-arg VITE_ADVANCED_CHART_ORIGIN="$MW_UX_CHART_ORIGIN"
# Run through sg docker -c if the shell lacks Docker group membership.
docker compose --env-file "/tmp/$MW_UX_PROJECT-private/acceptance.env" -p "$MW_UX_PROJECT" -f deploy/ubuntu/production-ux.acceptance.yaml up -d --no-build
# Seed only the isolated database; repeat compose arguments for each invocation.
docker compose --env-file "/tmp/$MW_UX_PROJECT-private/acceptance.env" -p "$MW_UX_PROJECT" -f deploy/ubuntu/production-ux.acceptance.yaml run --rm --no-deps seed
# Additional seed commands: run --rm --no-deps seed python /fixture/production_ux_fixture.py chart-seed|fixed-seed|composite-seed|replay-seed
# health.override.yaml sets API ALERTS_HISTORY_HEALTH_WORKERS to all four roles.
# Start/recreate API with -f PRIVATE/health.override.yaml --profile legacy before checks.
# After API becomes healthy, restart web/chart-origin to refresh nginx upstream IP.
node web/tests/production-ux-identities.browser.cjs
MW_UX_LEGACY_ENABLED=true node web/tests/production-ux-real.browser.cjs
node web/tests/production-ux-native.browser.cjs
node web/tests/production-ux-replay.browser.cjs
node web/tests/production-ux-health.browser.cjs
# Run scripts sequentially; health stops workers for the real 300-second threshold.
# To pause separately, stop only writers/web/chart; leave PG running for retire.
docker compose --env-file "/tmp/$MW_UX_PROJECT-private/acceptance.env" -p "$MW_UX_PROJECT" -f deploy/ubuntu/production-ux.acceptance.yaml stop api history-worker chart-history-worker native-history-worker legacy-import-worker web chart-origin
# If PG was stopped, start only pg with --no-deps before retire; retire stops writers itself.
mw-docker retire --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT"
mw-docker retire --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT" --apply
```

浏览器脚本读取 `/tmp/$MW_UX_PROJECT-private/password`，仅允许显式任务前缀与loopback origins；Chromium可执行文件固定为本机安装。此主机补充 `LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu`。identities脚本要求空监控列表以实际验证两个入口，运行在real保存之前；失败脚本遗留记录只按本任务 `Ubuntu UX ` 前缀经API取消再精确删除cancelled记录，不能删除其他任务数据。health override只需将API的角色JSON改为 `["history_versions","chart_history","native_history","legacy_import"]`；legacy profile启动兼容worker，其他后端环境仍原配置。

## 审查与资源清理

使用 [code-review skill](/home/quant/.agents/skills/code-review/SKILL.md) 要求的规范／Spec双代理审查。规范无安全或硬性标准阻塞，资产类别全集分散为低优先级维护建议。Spec发现的保存focus交付阻塞已实测归因、修复并复验；回调改在modal卸载提交后执行，避免背景inert。临时调试脚本已删除。

第一轮已按mw-docker预览/apply退役，87张业务表9198行在真实临时恢复库核对数量及排序内容SHA256一致，资源归零；证明保留在 [第一轮cleanup.json](verification/production-ux-fixes-20261012/cleanup.json)。名称含production的精确验收例外保留归属、共享资源、PG digest与实际恢复核对，不允许生产用途。

第二轮已预览9个容器、1个PG卷与独立网络并apply退役；87张业务表47494行在真实临时恢复库逐表核对数量及排序内容SHA256一致，来源稳定性再次核对。本任务容器、卷、网络剩余均为0，两个URL已停止；证明见 [round2/cleanup.json](verification/production-ux-fixes-20261012/round2/cleanup.json)。临时明文password、env、health override已删除，私有归档0700保留。私有归档不提交。仓库未配置GitHub Actions，不能宣称CI全绿；本次本地回归与实际网页验收结果已保存。交付 [PR #50](https://github.com/hezongyi/market-watch/pull/50)，不合并或部署生产。

## PR #51 合入后的集成复验

main `33ef507affef2cb34c10018333b7d827dd50085b`（已合并 #51）合入本分支，merge commit `0b0eef0837ec98b316640c97300413b9fdd4be83`。唯一冲突位于 Python 指标参数名称：优先读取 #50 的 metadata label，Swing 没有 label 时保留 #51 的 `High strength`／`Low strength`。Swing 算法和技术参数键保持原契约，适配器回归同时断言 MACD 中文标签与 Swing fallback。

实际网页登录发现原生库会把 Dukascopy ticker 中的摘要转为大写，而历史计算 origin map 使用规范小写。告警入口原来直接用原生 ticker 查找，因而误报“请等待 Python 指标历史计算完成”。现按 map 写入方式 `MWSeries.decode` 后 `encode` 再查询，保留 series kind 和 managed fallback；真实大写 ticker 的指标对象入口已通过。Dukascopy 的告警日历仍未核实，UI 正确禁止提交；实际 POST201／保存／刷新使用日历已支持的 Binance BTCUSDT，不放宽来源限制。

本轮运行 Ubuntu `quant-server` 本机独立 Docker task/project `mw-ux-acceptance-after51-20261012`，网页 `http://127.0.0.1:19991/`、图表来源 `http://127.0.0.1:19992/`，数据库 `production_ux_acceptance` 和独立 PG volume。三镜像 `market-watch-api:ux-after51`、`market-watch-web:ux-after51`、`market-watch-chart-origin:ux-after51` 均经 `mw-docker build`／`market-watch-ubuntu` 构建；chart 在 origin 修复后重建。没有启用 legacy profile，三现行角色实际 running，兼容补数显示 disabled；本轮没有重复四角色 stop/recovery，完整证明仍引用第二轮。#51 自己的实例与其他任务未操作。

- 299 项相关 Python 回归、24 项真实 PostgreSQL 回归通过，覆盖 Swing／指标契约／状态、工作区、provider/cache、managed、告警值与计算契约等；JS 指标适配、身份／标签及 7 项告警 bridge 测试通过。前端 tsc／Vite／数据中心 bundle 构建通过，保留既有大 chunk 提示。
- 在实际登录的原生图上同时添加 MACD 19/35/11 与 Swing 3/7，Added 摘要、中文 MACD 名称、Swing strength 名称正确。实际 UI 保存模板，移除指标后应用模板，保存工作区并整页刷新，两个指标参数、Swing 显示与 MACD 数值曲线恢复；刷新后持久化模板仍可应用。
- 本轮组合模板只验证 Swing 默认显示选项 `show_average_spacing=true`、`statistics_position=below_name`，未改变样式。关闭统计、左下角、多实例、双图、旧八指标模板等另有 12 能力组 local-file 原生 probe 通过；不能将该 probe 当成真实 Docker／供源验收。
- 实际 BTCUSDT Python 指标对象入口带入 origin 与 19/35/11，UI POST201；图表随后改为 23/39/13，已存告警仍独立。手选 MACD 21/26/9 POST201，整页刷新后两条列表与参数快照持久化。股票／日历筛选及既有 reset 恢复 autoscale 一并复验；本轮 reset 来源是合成 BTC→股票，第二轮 FX→股票证据保持原样。
- 375×812、390×844、844×390 Chromium 触摸视口实际取消／保存 POST201／刷新／绑定／焦点复验通过。14 张本轮留存截图已逐张打开复核，尺寸与 SHA256 见 [after-pr51/visual-review.json](verification/production-ux-fixes-20261012/after-pr51/visual-review.json)。截图中工作区可能与已存告警品种不同，告警持久化以 API／DOM 断言证明；不宣称重新附着到该工作区。

复现沿用上节独立构建／Compose 方法，但必须使用新 task/project、新镜像标签和空闲端口；这轮只需 seed 与 chart-seed，不启用 legacy／health override。浏览器按 native → real → after51 顺序串行运行：

```bash
# Set to a NEW task after preparing its private env/password and synthetic seed.
export MW_UX_PROJECT=mw-ux-acceptance-after51-new
export MW_UX_BASE=http://127.0.0.1:19991
export MW_UX_CHART_ORIGIN=http://127.0.0.1:19992
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
export LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu
node web/tests/production-ux-native.browser.cjs
node web/tests/production-ux-real.browser.cjs
node web/tests/production-ux-after51.browser.cjs
# After acceptance, leave PG running for actual restore verification.
mw-docker retire --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT"
mw-docker retire --task "$MW_UX_PROJECT" --project "$MW_UX_PROJECT" --apply
```

规范／Spec 两轴对合并解决与 origin 修复均无交付阻塞；模板与数据来源范围按实际验证记录。最新证据、精确测试命令及退役恢复核对见 [after-pr51/README.md](verification/production-ux-fixes-20261012/after-pr51/README.md)。原第一／第二轮证据不覆盖。价格仍来自本任务显式合成缓存；未新增真实供源价格、告警 worker 判定、通知投递、实机／Safari或生产验收结论。PR #50 继续保持可审，不合并或部署生产。

本轮已预览8个容器、1个PG卷和独立网络后 apply 退役。87张业务表42118行在真实临时恢复库逐表核对行数与排序内容 SHA256 一致，并再次检查来源内容稳定；本任务容器／卷／网络均为0，19991／19992已停止。临时明文 env／password 已删除，0700私有归档保留且不提交；证明见 [after-pr51/cleanup.json](verification/production-ux-fixes-20261012/after-pr51/cleanup.json)。
