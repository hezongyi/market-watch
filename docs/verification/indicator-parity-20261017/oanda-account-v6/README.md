# OANDA 同账户平台蜡烛补丁验证

2026-10-17。代码基线 `0eb0ef1`，本目录记录其后的同账户口径补丁。
F1：平台缓存版本及重要后台消费边界变更；无 schema 迁移，无生产部署。

## 结论

代码与定向回归通过，真实供应商只读对照通过。用户调整会话权限后，标准构建成功，
本补丁已部署到既有 Ubuntu 验收实例。**GBPJPY M5 二次闪空专项 Playwriter 复验通过**；
当前为周末已完成柱，未覆盖开盘后新柱交接。Issue #74 整体 CI 仍失败，不能宣布整体验收通过。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| HEAD 旧实现运行新增回归 | 12 failed / 1 passed；真实 delivery 分支返回 history_changed | [red](account-prices-red.log) |
| 修改后账户/历史/分页/原生参数相关检查 | 248 passed | [focused](account-prices-focused.log) |
| 复用任务 PG 的兼容、更正/删除/凭据接受、worker 恢复及相关 SQLite 检查 | 90 passed | [PG suite](account-prices-pg.log) |
| 真实 GBPJPY M5 同账户历史 vs latest | 两根共同已完成柱 OHLC、volume、complete 全相同 | [真实只读对照](account-real-compare.json) |
| Ruff / git diff --check | 通过 | 本次变更文件 |
| Ubuntu R1 构建/部署 | 标准 mw-docker 构建成功，8 个后端服务更新，API healthy | [构建](account-v6-build-final.log)、[部署](account-v6-deploy.log)、[镜像及服务](account-v6-deployment.json) |
| Playwriter GBPJPY M15→M5 | 无指标两轮、Supertrend 两轮，2,704 帧，drop/blank/reset 均 0，无 history_changed | [汇总](browser-summary.json)、四份逐帧 JSON |
| Playwriter Dukascopy GBPJPY M5 | 687 帧，drop/blank/reset 均 0 | [逐帧](account-v6-dukascopy.json) |
| 保存的真实 XAU 组合刷新 | H4 214 bars，当前 Supertrend coverage、无 transition，末点与升级前相同 | [结果](account-v6-composite.json)、[截图](account-v6-composite.png) |
| 全量 CI 39034631301 | Web/Compose 通过；Backend 10 failed / 2573 passed / 11 skipped | [失败项与摘要](ci-39034631301-summary.txt) |

旧实现红色检查将 `git show HEAD` 的三个被改产品模块放入临时包，其余模块引用工作树；
未回退工作树或修改验收库。新回归的 MockTransport 分别返回已观测到的两类接口差价，
经过实际 native_page、cache、共享 latest、native publisher、delivery；修复后无 reset，
再更正旧柱仍触发 history_changed。HTTP fixture 不是供应商实测。

PostgreSQL 入口连接本任务既有 PG，使用既有检查数据库，每个 provider_pg 用独立临时 schema，
结束后仅删除其新建 schema；没有重建/清空验收业务数据，也没有新增 PG 服务。
两组测试有重叠，不能将数量相加宣称独立用例总数。

真实只读对照使用工作树候选函数和复用的验收私有配置：GET accounts、配置账户 instruments、
GBPJPY M5 历史、latest。授权账户检查通过；周末共同两根柱对应 2026-10-16 20:50/20:55 UTC。
这是后端端点等价证据，不覆盖开盘后的交接或页面渲染。

## 独立审查

Standards review 未发现阻塞缺陷。Spec review 发现旧未订阅历史 interests 仍可能预热新缓存；
已在 warm_step 选择候选前增加版本身份校验，并加入默认、ASK、自定义日历三类回归。
Spec 复核确认此项关闭。两项 review 均为静态审查，不代替运行检查。

## 部署与浏览器复验

必须使用的 `mw-docker build` 需要写
`/home/quant/.local/share/market-watch-docker/ops.lock`，本会话只允许写 `/home/quant/repos` 和
`/tmp`，首次实际返回 Read-only file system。此失败保留在 [初次构建错误](account-v6-build.log)。
用户明确调整权限后重试标准入口成功，没有改用直接 docker build，也没有绕过状态记录。

候选 `market-watch-api:issue74-account-v6`，对应代码 `e93a80e`，由专用 BuildKit 构建。
保留旧 API 镜像与 `compose.pre-account-v6.json` 私有配置，只更新本任务 API 及七个后台 workers，
不重建数据库或前端。实际镜像 ID、标签和服务映像见部署 JSON，不含私有配置。

Playwriter 使用已有登录会话中新建页面、真实行情，自然点击 M15→M5；没有注入行情或 reset。
每轮观察约 11 秒，逐帧计数 canvas 红绿像素，沿用旧版本曾复现红色的规则：切周期两秒后若
相对前 45 帧出现超过 80% 的像素下降、出现迟到 resetData 或收到 history_changed 则失败。
同时保留主图 data.size()、市场事件和 resetCache/resetData 调用；四轮均无空白或 reset。
首轮新 M5 缓存加载也通过，不将窗口取 bar 耗时作为指标耗时。

Supertrend 周期 11、倍数 3、hl2，最新 M5 212 根绘图对应的 coverage=212、transition=null，
当前末点有限；见 [最终 scope](account-v6-gbp-final.json) 与 [截图](account-v6-gbp-final.png)。
这是当前参数覆盖和渲染 smoke，不宣称完整数值 oracle 或开盘实时验收。

旧缓存仍存在，复验前后旧 dataset 的尾部 payload/revision 未变。新 dataset 的尾部 revision
有所推进，两个采样的最终 payload 相同；本次未逐次归因中间修订，不将 revision 数字不变
当作本补丁验收标准。对照快照见两个 db-check JSON。
真实修订/删除仍须重载的正确性由 PostgreSQL acceptance 回归覆盖。

已保存真实 XAU 组合重新加载后仍指向原组合及原固定修订，214 根 H4、Supertrend 末点
4092.4738313695907 与升级前记录相同。Dukascopy GBPJPY 自然切周期 smoke 同样无二次闪空。
全部临时 browser wrappers/listeners 已卸载，临时 Dukascopy 页面已关闭；GBPJPY 和原组合页面保留。

最新完整 CI 仍有 10 个失败，用例 ID 与此前记录的 run 39026587111 相同，涉及冻结输入、
更早历史后固定起点及并发证明。没有将它们改判为通过或当作可忽略 baseline。本次 OANDA
账户专项新增 13 项均通过；整个 PR 继续 Draft，不关闭 Issue。

Ubuntu 主机 `quant-server`，项目 `mw-issue74-20261017`；地址
`https://127.0.0.1:18474/advanced-charts`，图表 origin `https://127.0.0.1:17475`。
项目启停沿用私有配置：

```bash
docker compose -p mw-issue74-20261017 -f /tmp/mw-issue74-20261017/compose.json up -d --no-build
docker compose -p mw-issue74-20261017 -f /tmp/mw-issue74-20261017/compose.json stop
```

不执行 down -v、永久删除或生产发布。Issue #74 的 EMA500 固定起点问题、已有整体 CI 失败及
其他未完成验收仍然保留；此补丁不代表整个 Issue 通过。

归档 pytest 输出仅去除行末空格，源文件仍保留在任务临时目录。归档证据 SHA-256 见 [manifest](manifest.json)。配置维护和回退边界见
[实施说明](../../../oanda-native-account-prices-20261017.md)。
