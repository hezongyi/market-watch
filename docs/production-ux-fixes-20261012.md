# 生产验收问题修复与 Ubuntu 验证（2026-10-12）

修复原报告 UX-01—UX-07，并落实 S-01、S-03；S-02 单独复验既有恢复入口后保留建议。依据是 `/tmp/market-watch-ux-fixes-handoff-20261012-kjs8hlt_.md` 和历史验收文档 PR #49。本分支从 `7f80f72` 创建，原报告、生产数据、正式版本及其交付证据未修改。

## 修改与逐项证据

| 编号 | 最终行为 | 验证 |
| --- | --- | --- |
| UX-06 | 长卡片文字有宽度边界；弹窗内部滚动、固定可达操作区 | 构建应用的120项浏览器断言；真实Ubuntu 375×812、390×844、844×390触摸取消和POST201保存；比较visualViewport、弹窗及关闭／提交按钮边界 |
| UX-01 | 品种标题可读，黄金／欧元图标正确；来源、环境、账户范围、基准与日界保持可见，内部ID进入详情／复制 | 普通、显式自建、平台来源及未知长名称fixtures；真实OANDA practice长ID保存／刷新后绑定完全相同；组合仍显式选择，未猜测同名映射 |
| UX-07 | Esc、关闭、取消恢复发起按钮焦点，对话框有名称 | 鼠标／Enter／Space与三种关闭方式组合，四个视口；两个发起按钮；真实触摸取消及保存恢复焦点 |
| UX-02 | 三个现行worker独立业务心跳、成功轮次、任务统计／最近进展；兼容补数单独配置 | 实际停止历史发布与兼容补数，等待300秒，两者stale、其他现行服务running；仅恢复发布时旧服务仍stale；逐项恢复后全部running。异常重试保留故障直到成功，目录刷新失败仍继续执行导入 |
| UX-04 | Dukascopy SDK股票组进入股票类，ETF／期货独立；具体合约类型未核实时明确标注 | AAPL、0700.HK、7203.JP、ETF及期货分类／关键词／来源组合后端回归；真实原生数据中心AAPL＋股票＋Dukascopy筛选可见 |
| UX-05 | 展示已登记／来源目录／平台已用／来源配置及用途、独立审核对象 | BTCUSDT真实原生窗口两条对象可区分；后端保留独立row_id与未核实状态；OANDA身份／会话审核相关回归通过 |
| UX-03 | 原生摘要读取内置localized metadata或Python参数元数据，告警参数／输出标签可读，技术键在详情保留 | 真实原生MACD参数17/31/7及Python19/35/11摘要；告警手选MACD默认12/26/9和改21仍用真实键；说明手选默认、Python对象入口初始实际值与保存后独立快照 |
| S-01 | 带入当前周期，说明当前价格身份与组合不兼容时需要明确选择 | BTCUSDT M5 fixture；组合默认未自动选定，提交保持禁用 |
| S-02 | 保留原有手动轴行为，既有右键“重置图表视图”恢复自动缩放 | 合成FX→股票原生切换后auto=false，但范围已更新至315—324，没有复现保留旧外汇范围；重置后auto=true。一次切换不证明普遍故障已归因 |
| S-03 | 演练结果／控制先于任务；完成项默认收起，失败／运行／待核查可见 | 真实数据库31项完成＋1项失败：结果先于任务、完成默认折叠、失败重试按钮可见；组件fixture保留运行／待核查／重试 |

## 验证范围与限制

178项相关后端回归通过；Ubuntu Docker PostgreSQL验证18项通过，包含真实事务冲突、回滚及控制状态重读；生命周期56项测试及15项subtests通过。前端tsc、Vite和数据中心bundle构建通过，仅有既有大chunk提示。证据见[索引](verification/production-ux-fixes-20261012/README.md)。

原生窗口使用本机已许可库，库文件不提交；图表价格来自本任务显式合成缓存，用于UI／轴行为，不能证明供源价格或覆盖。Dukascopy官方股票网页连接超时，SDK分组只证明股票类别，因此未将全部股票宣称为已核实CFD或股票所有权。实际价格身份和来源参数未修改。

原生Python指标对象入口在合成环境仍等待calculation origin，未完成该入口的告警创建；实际bridge对象入口fixture验证19/35/11快照、calculation origin和图表后续改值不影响既有快照；摘要实际值及手动告警默认／修改值已验证。没有宣称此入口完整通过，也没有宣称告警worker判定、真实通知投递、手机响铃、实机／Safari、长期稳定性通过。没有新增生产部署；正式页面的修复后只读复验需在后续明确授权发布后执行。

## 实际环境与复现

实际运行主机为Ubuntu `quant-server`，本机Docker 29.1.3，builder `market-watch-ubuntu`。独立task/project `mw-production-ux-20261012`，数据库 `production_ux_acceptance`，volume `mw-production-ux-20261012_pg-data`，独立网络。运行时网页 `http://127.0.0.1:19971/`、专业图表来源 `http://127.0.0.1:19972/`。两端口只监听loopback，不是unraid或远端转发。

构建经 `mw-docker build --repo . --component api|web|chart --tag TASK_TAG --task mw-production-ux-20261012 --project mw-production-ux-20261012 --purpose acceptance`；web额外参数 `--build-arg VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:19972`。本地许可库完整时才构建chart。

私有0700目录 `/tmp/mw-production-ux-20261012-private` 的env包含独立DB密码、argon2登录hash与三镜像引用；密码文件仅供本机浏览器，内容不提交。验收脚本固定本任务loopback及数据库名，真实供源凭证未配置，通知投递关闭；图表只读取本任务合成缓存，未验证上游可用性。

```bash
# 在本worktree运行，重新验收须使用新的task/project与匹配构建标签。
sg docker -c 'docker compose --env-file /tmp/mw-production-ux-20261012-private/acceptance.env -p mw-production-ux-20261012 -f deploy/ubuntu/production-ux.acceptance.yaml up -d --no-build'
# Seed commands are explicit and confined to the fixture DB.
sg docker -c 'docker compose --env-file /tmp/mw-production-ux-20261012-private/acceptance.env -p mw-production-ux-20261012 -f deploy/ubuntu/production-ux.acceptance.yaml run --rm --no-deps seed'
# Native/replay UI checks additionally use chart-seed/replay-seed fixture commands.
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu node web/tests/production-ux-real.browser.cjs
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu node web/tests/production-ux-native.browser.cjs
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu node web/tests/production-ux-replay.browser.cjs
# Health script requires private health.override.yaml listing all four roles
# and starting the legacy profile; it stops/restarts only this project's roles.
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu node web/tests/production-ux-health.browser.cjs
sg docker -c 'docker compose --env-file /tmp/mw-production-ux-20261012-private/acceptance.env -p mw-production-ux-20261012 -f deploy/ubuntu/production-ux.acceptance.yaml stop'
```

## 审查与资源清理

使用code-review两轴审查：规范无硬性违规，资产类别全集分散是一项低优先级维护建议；Spec发现的过早清故障及快照说明问题已修正并复审。并行审查没有修改代码。

清理工具原来仅因项目名含production拒绝验收项目。新增显式 `--confirm-acceptance-project EXACT_NAME`，必须同时匹配task/project且已登记acceptance用途，实际镜像label、资源归属、共享资源拒绝、官方PG digest、备份实际恢复及内容SHA核对全部保留。生命周期测试和独立安全审查通过；仅更新本机工具入口，没有改任务登记或资源标签。预览只列本项目9个容器、1个PG卷和独立网络，再执行apply。

清理已完成：87张业务表、9198行在临时恢复库逐表核对数量与排序内容SHA256一致；本项目容器、卷及网络剩余均为0，原验收URL已停止。清理最终状态及经裁剪的恢复证明见 [cleanup.json](verification/production-ux-fixes-20261012/cleanup.json)。私有归档包含角色、env、inspect与数据库备份，不提交。原生产实例和其他任务资源未操作。
