# OANDA 同账户平台蜡烛补丁验证

2026-10-17。代码基线 `0eb0ef1`，本目录记录其后的同账户口径补丁。
F1：平台缓存版本及重要后台消费边界变更；无 schema 迁移，无生产部署。

## 结论

代码与定向回归通过，真实供应商只读对照通过。验收镜像尚未构建、未部署本补丁，
因此**没有本补丁的 Playwriter 通过结论**，现有验收网址仍是旧后端。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| HEAD 旧实现运行新增回归 | 12 failed / 1 passed；真实 delivery 分支返回 history_changed | [red](account-prices-red.log) |
| 修改后账户/历史/分页/原生参数相关检查 | 248 passed | [focused](account-prices-focused.log) |
| 复用任务 PG 的兼容、更正/删除/凭据接受、worker 恢复及相关 SQLite 检查 | 90 passed | [PG suite](account-prices-pg.log) |
| 真实 GBPJPY M5 同账户历史 vs latest | 两根共同已完成柱 OHLC、volume、complete 全相同 | [真实只读对照](account-real-compare.json) |
| Ruff / git diff --check | 通过 | 本次变更文件 |
| Ubuntu R1 构建 | 被会话可写范围阻止，未构建成功 | [构建错误](account-v6-build.log) |
| Playwriter 候选自然切周期 | 待构建/部署后执行 | 无通过声明 |

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

## 当前部署阻塞与后续验收

必须使用的 `mw-docker build` 需要写
`/home/quant/.local/share/market-watch-docker/ops.lock`，本会话只允许写 `/home/quant/repos` 和
`/tmp`，实际返回 Read-only file system。没有改用直接 docker build，也没有绕过状态记录。
已请求将工具状态目录加入可写范围。

解除后用 `market-watch-api:issue74-account-v6` 候选重试构建；保留旧 API 镜像与私有 Compose，
只更新 `mw-issue74-20261017` 的 API/后端 workers，不重建数据库或前端。自然切 GBPJPY
M15→M5，分别无指标和 Supertrend 多次观察 SSE reason、resetData、主图 data size 和逐帧 candle 像素；
再做 Dukascopy/已保存 XAU 组合 smoke。旧闭页/旧探针不可作为候选验收。

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
