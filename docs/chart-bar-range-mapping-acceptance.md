# K线范围映射：实现与隔离验收

> 本页为 v1.8.0 迁移前的历史实现/验收记录；焦点来源等旧合同已由用户修订。当前分支的代码、Ubuntu 实例与复验结论见 [v1.8.0 迁移验收](chart-range-v1.8.0-acceptance.md)。

2026-10-04。功能分支 `feat/chart-bar-range-mapping`，独立 worktree `/home/quant/repos/market-watch-range-mapping`。实现基于已提交的同步修复 `20418691598da38577ee23f4616f07de42d58d55`；原仓库 MT4 工作未修改。本次交付为本地可审查实现，未合并或部署生产。

> 本页保留首次范围映射交付的v1行为及环境。2026-10-05新增同步设置、柱宽同步、v2外观和外部高低价栏的最终结果见[同步设置实现验收](chart-sync-settings-acceptance.md)，新候选独立使用16243/16244。

## 实现行为

原生布局同步菜单的十字线同步下新增 **K线范围映射**，默认关闭，提供淡色背景及高低价矩形。两项必要开关开启后，鼠标实际所在主图的有效行情 K 线成为唯一来源；同商品、更小周期目标显示真实 `[start,end)` 与其可见时间槽的交集。MN 跳过 W1。同步光标回调不改变来源。

来源使用已被原生线程接受的原始区间、高低价元数据；getBars、储备、provider 事件及 managed polling 共用观察入口。索引按有效线程缓存窗口回收，reset 和重建先失效数据 ticket，拒绝旧响应。未来空白、未就绪数据、Python 指标合成序列、Renko/Range 等不满足时间区间合同的来源/目标均不生成标记。

背景覆盖行情主 pane 高度；矩形使用来源实际高低价及原生价格坐标，适配线性、对数、百分比和倒置轴。标记在 K 线下层，不进入绘图对象、撤销记录或价格自动缩放。离开、菜单、开关关闭、workspace load/reset 先清除语义状态并重绘；恢复只恢复配置，不恢复旧鼠标。

保存字段为 `_mwBarRangeMapping: {version:1,enabled:false,style:"background"}`。启动及 native load 前移除自有字段；保存、另存和恢复保留配置。仅用户改开关/样式通知 dirty，并通过当前库的 saver `markContentAsChanged()` 保持原生保存菜单可用。配置同时进入原生 saver 的状态比较，防止仅改此配置时被 `_prevChartState` 去重漏存。

## 绘制入口的选择

阶段 A 先测试了公共临时绘图。实际许可 v31.1 的端点会吸附整数 bar 索引：半柱边界与未来截止时间无法可靠表达。新增[阶段 A 记录](verification/chart-bar-range-mapping/implementation/phase-a.json)；旧目录的静态原型只证明其注明的合成 UTC 条件。

最终使用方案允许的备选：在 SHA 校验的原生主 pane 绘制入口、背景之后和 sources 之前填充 canvas。每目标每次绘制最多一个填充，映射绘图对象数恒为零。目标已有槽用真实元数据，未来槽使用原生交易日历 builder；未知历史槽不近似。NY17 DWM 内部时间先转交易日标签，Yahoo DWM 按后端交易所午夜区间合同处理。显示时区不改变覆盖区间。

许可库不提交；installer 支持原始、v1.7.0 legacy 和同步修复基线迁移，并检查幂等、disable、部分安装、篡改以及资源摘要 URL。未知字节拒绝安装。升级许可库时必须重新验证这些入口，不能沿用当前 SHA。

## 隔离环境与证据

当前验收实例已迁入 **Ubuntu 本机 Docker**，Compose project 为 `mw-range-mapping-ubuntu-20261004`，配置目录 `/home/quant/repos/.acceptance/market-watch-range-mapping`。专属 PostgreSQL 数据库/user `range_mapping`、volume、network；投递关闭、无 worker。访问 `https://192.168.7.232:16043/advanced-charts`，独立图表来源为同主机 16044；Ubuntu 本机也可使用 localhost。

此前误将开发验收项目部署到 unraid。用户明确 unraid 为生产环境后，本次范围映射及此前同步修复验收项目的容器、专属 volume/network、验收镜像标签和目录均已删除；正式生产 `trading-alerts` 服务继续运行。所需验收数据及镜像先导出至 Ubuntu，未向生产服务写入。历史 83 个场景记录保留其实际环境，不改写为 Ubuntu 的运行结果。

Ubuntu 上使用同一已验证 chart host 与许可补丁字节，web 只将硬编码 localhost 图表地址替换为当前访问主机的 16044，以支持局域网验收；已重新创建只用于验收的 TLS 证书与登录密码。Ubuntu 局域网地址的真实鼠标核心复验 38 项通过，页面错误为零；记录另存 [ubuntu-browser.json](verification/chart-bar-range-mapping/implementation/ubuntu-browser.json)，另附按住拖动截图。凭据仅放在受限的本地验收目录。

环境、最终 image ID、许可 bundle SHA 和源码摘要见 [environment.json](verification/chart-bar-range-mapping/implementation/environment.json) 与 [source-sha256.json](verification/chart-bar-range-mapping/implementation/source-sha256.json)。归档不含登录、env、TLS 私钥、许可库或完整浏览器状态。Compose 示例要求通过环境变量设置独立数据库密码；局域网部署用 `RANGE_BIND_IP=0.0.0.0`。

| 需求/阶段 | 最终产品证据 | 结果与范围 |
| --- | --- | --- |
| 周期、身份 | [matrix.json](verification/chart-bar-range-mapping/implementation/matrix.json)、模块测试 | 九个来源各两轮八图，全部其他周期允许/禁止组合；MN→W1 排除、同周期及不同商品排除 |
| 2/4/8 图、来源与实时跟随 | [browser.json](verification/chart-bar-range-mapping/implementation/browser.json) | 实际鼠标连续移动/切换、两种样式、布局切换；高低价更新使用真实已加载 bar 的受控 provider transport fixture，不声称是自然市场 tick |
| 立即隐藏、未来来源、合成目标 | browser `pixel-cleared`、`future-no-source`、`synthetic-target-excluded` | 目标 canvas 实际像素在离开后恢复；未来留白无来源；Renko 目标无填充；必要开关和菜单清理 |
| 日期与显示时区 | [calendar.json](verification/chart-bar-range-mapping/implementation/calendar.json)、[binance-calendar.json](verification/chart-bar-range-mapping/implementation/binance-calendar.json)、[yahoo-calendar-cached.json](verification/chart-bar-range-mapping/implementation/yahoo-calendar-cached.json) | OANDA EURUSD NY17、Binance BTCUSDT UTC、Yahoo SPY NYSE Arca；2024-03、2020-02、2023-12、2024-12；DST、闰年、跨年及休市槽、Tokyo 显示时区 |
| 完整未来语义与原生日历 | browser `month-hover` / `period-*`、[future-inspection.json](verification/chart-bar-range-mapping/implementation/future-inspection.json)、模块半柱边界测试 | 未完成范围保留完整 end，仅填充可见相交槽；不扩大未来拖动边界或生成 bar；未来探针记录 NY17 槽 |
| 远历史导航 | [navigation.json](verification/chart-bar-range-mapping/implementation/navigation.json) | 2024-03 周线真实鼠标点击，M5 窗口完成后在鼠标静止时重投影；离开后后续导航不能复活 |
| 按住真实拖动 | [browser-eight-held.png](verification/chart-bar-range-mapping/implementation/browser-eight-held.png)、[lifecycle-reset-held.png](verification/chart-bar-range-mapping/implementation/lifecycle-reset-held.png) | 截图均在 `mouse.down()` 与 `mouse.up()` 之间；八图整页来源拖动；reset 在实际 held drag 内清除 |
| 画线/撤销/保存并发 | [lifecycle.json](verification/chart-bar-range-mapping/implementation/lifecycle.json) | 用户水平线、原生撤销栈及保存保留；仅改样式会发请求；保存中 hover 不 dirty；真实原生复制菜单保存配置；native load 清除瞬时状态 |
| 菜单、主题、价格轴 | browser `price-theme` / `saved-config` / `restore-config` | 浅/深色×三类价格轴×倒置；Enter 开关、禁用状态；保存/刷新恢复配置，无旧标记 |
| 无额外需求/视区副作用 | browser / matrix / calendar 的 before-after 断言 | 映射移动不增加 data/reserve 请求；原生时间范围、柱宽、偏移、价格范围及绘图对象保持 |
| 内存与性能 | browser `eight-performance` / `eight-sustained` | 八图 100 次事件响应及 2,000 次移动；索引数量与历史请求保持稳定，GC 后堆占用有限增长；见下方测量限制 |

## Ubuntu 实例操作

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/market-watch-range-mapping/compose.yaml ps'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/market-watch-range-mapping/compose.yaml up -d'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/market-watch-range-mapping/compose.yaml stop'
```

用户名不参与此应用登录；验收密码在上述受限目录 `login.json`。自签 TLS 首次访问时，需分别打开 16043 和 16044 接受证书。开发和验收只能在 Ubuntu Docker 部署；权限不足应申请提权，完整规则见仓库 `AGENTS.md`。

## 性能测量的含义

Chromium 1600×1000、本验收环境记录鼠标来源变更到第一个目标绘制 hook 入口的 P95；它不是屏幕硬件显示延迟。单次 draw 耗时包含每目标区间投影及 fill。最终 100 次来源变化的输入→绘制入口 P95 为 6.2ms，最大 8.6ms；每目标 draw P95 为 0.30ms、最大 10.2ms，响应低于拟定 50ms 预算。

连续 2,000 次真实鼠标移动、五批 GC 后观察整个共享 page/chart renderer 堆；并非仅模块内存。验收 instrumentation 有界保存绘制记录。索引数量和请求数不增长、无映射绘图对象堆积；最终五批 GC 后堆占用为 38,214,936 → 38,803,552 bytes，增加约 0.56MiB。这是有限持续样本，不声称证明所有设备或数小时会话无内存泄漏。

## Yahoo 验收限制

此次 Yahoo 重新获取历史遇到后端既有 `Yahoo OHLC 高低关系无效`，未放宽校验或修改后端。只读导出此前**同步修复隔离数据库**的真实 provider 缓存，导入本次专属数据库，7 个 dataset 共 21,225 bars。未向来源数据库写入，未使用生产布局或伪造 OHLC。

Yahoo 通过的是真实缓存 → 本次独立 PostgreSQL → API → 产品图表的投影与生命周期链路；不证明当前外部重新获取正常。月线到 D1/D1/W1 场景覆盖 SPY 的 NYSE Arca 日历，不代表所有 Yahoo 交易所全量验证。后续外部 OHLC 数据问题应单独处理。

## 复验

独立实例启动后，登录 JSON 由 `RANGE_LOGIN` 指向本地临时文件；不要提交该文件。`RANGE_APP` / `RANGE_CHART` 可覆盖默认 HTTPS loopback 地址，`RANGE_OUTPUT` 指定输出。浏览器用例使用同账号，须串行执行以避免 preferences revision 冲突。

```bash
cd /home/quant/repos/market-watch-range-mapping
node web/tests/advanced-bar-range-mapping.cjs
node web/tests/advanced-bar-range-lifecycle.cjs
LD_LIBRARY_PATH=/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu \
  node web/tests/advanced-bar-range-mapping.browser.cjs
# 同样运行 lifecycle、calendar、navigation、matrix.browser.cjs。
# calendar 使用 RANGE_SYMBOL=MWP:BTCUSDT 或隔离 Yahoo provider identity。
cd web
node tests/advanced-native-hook-contract.cjs
node tests/advanced-native-save-race.cjs
node tests/advanced-native-workspaces.cjs
node tests/advanced-native-reserve-lifetime.cjs
node tests/advanced-native-reserve-scheduler.cjs
node tests/advanced-provider-history-observation.cjs
node tests/advanced-sync-snapshot.cjs
npm run build
```

最终隔离浏览器累计 83 个场景通过：核心 38、生命周期/保存 6、三类日历各 4、导航 8、完整周期矩阵 19；页面错误为零。模块及相关合同/保存回归通过，前端构建通过（既有 >500k chunk 提示）。所有浏览器最终结果均需 `errors: []` 且没有 `failure`。完整过程中的失败探针未作为通过证据归档。

## Standards

未找到适用的仓库书面编码规范。审查最初报告一项非阻断的 possible Duplicated Code：四套浏览器验收重复 setup/认证/ready/geometry。已提取 `fixtures/bar-range-acceptance.cjs`，新增模块及测试格式化；复核确认 finding 关闭，无硬性违规。

## Spec

审查最初报告 provider reset 忙碌时未立即失效旧元数据（P1）及合成目标未排除（P2）。现 reset 同步 invalidate、重建前失效、旧 ticket 拒绝；来源/目标共享 timeSeries guard。模块、bridge busy-reset 与真实 held-drag 回归通过，审查复核关闭两项。

Standards：0 项未解决；Spec：0 项未解决。保存比较修复、配置变更启用原生保存菜单的最终增量也经只读复核，无新增问题。
