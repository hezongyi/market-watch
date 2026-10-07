# Issue #13：v1.14.0 后实施进展

2026-10-07 14:36 SGT。实现候选，尚未完成 Issue #13。

已整合 v1.14.0（ec00080），独立冻结基线 131bf3c 的 4 场景 × 3 次 × 300 秒已结束；12 个原始样本审计通过，本任务基线 PG 已正常停止。空闲平均 CPU 41.438% 单核、worker SQL 67.274/s，实时样本 p95 19.551–23.347 秒；修订 p95 24.080–24.456 秒。原始 P0 证据保留。期间 Ubuntu 其他任务及本任务逻辑回归负载由 host.jsonl 记录；这些是实际宿主条件，不当作生产指标或无竞争实验。

## 当前实现

- 持久请求/处理世代及原因，事务内触发；已完成目标等待、目标级重试、60 秒有界纳管与遗漏 bucket job 恢复。Instrument 先锁、状态后锁；被锁身份通过 SKIP LOCKED 跳过，避免拖住其他品种。
- 明确区分快照变化、任务消费、仍可运行及等待。worker 每次一个目标，忙时等待 0.02 秒、空闲 2 秒；不将检查当进展。新输入立即就绪，来源观察时间不控制任务到期时间。
- 按发布尾部、历史未复制页和精确修订窗口读取，计数增量维护；M30/W1/MN 依日历读取完整源成员，同时将源页预算控制在约 2000 行。
- 新观察时间进入脏桶和持久调度；同价 M1 以 observed 聚合任务刷新匹配的高周期。任务优先级 price > volume > observed，元信息传播使用来源成员的观察时间，拒绝配对不同价格及重复价格/量修订。
- an41 请求状态、ao42 覆盖投影均为 additive 迁移。覆盖原始表与审计保留；whole-minute 安全边界及旧 received_at 五秒余量不变。分批 checkpoint、运行时双写、错误记录隔离。普通发布 tick 到 verify 即结束迁移推进，继续兼容读取；最终锁内全量区间核对只能由明确维护入口 `coverage --verify` 执行。证明撤销 rebuild 是维护操作，在事务内撤回相交高周期 source/published 的 complete/volume_complete、增量计数和 revision，审计撤销范围，持久排队重算；原始 M1 保留。
- publication_admin 提供覆盖分页和回退前旧 bucket jobs 分页补建。应用回退保留新表与原始证据，不能同时运行两个版本的发布拥有者；schema downgrade 遇到 pending generation 拒绝执行。

## 已有验证

- 相关回归 95 passed；增加及修正触发/预算后相关回归 80 passed（51.80 秒）。这些覆盖 SQLite 快速逻辑与真实 PG 修订、成交量、迁移及并发。
- PG 世代/锁/回滚及覆盖合同 8 passed；实际 am40 → head → 被拒绝的 pending downgrade → am40 → head 1 passed。
- 同价 H1 传播及延迟 worker 不制造新鲜度用例先红后绿；遗漏请求恢复先红后绿。
- 保存的正式覆盖白名单快照在 Ubuntu 隔离 schema 重放：62,522 audit / 27,939 structured；两个身份各 92 页，约 8.9 秒。与此前独立兼容 union 完全一致，完成后 audit 查询为 0。原候选最终一次验证页最大约 1.8 秒。审查指出原实现在 tick 内执行且 examined 未计全量扫描；当前已改为显式维护入口、计入真实扫描记录数，普通 tick 禁止调用。最终 682818d 重放再次通过；explicit maintenance 最后一步 examined 记录真实原始证明数，常规页面仍有界。
- 第一轮边开发边跑的全量：1316 passed / 10 failed / 10 skipped，806.99 秒。旧 migration HEAD、源预算缩小后的分页次数假设、硬编码 .venv 路径及不完整 fixture 已修正；修正相关回归通过。冻结 6fc5896 全量已完成：1344 passed / 2 skipped / 65 warnings，768.75 秒。两项 skip 分别为缺可选日历依赖和匹配的 PG dump/restore 工具。审查后又修改核心实现，最终核心冻结 e529bb1 全量已完成：1352 passed / 2 skipped / 65 warnings（758.70 秒、exit0）。最终性能/验收冻结 682818d 与 e529bb1 的 backend/alerts 字节完全一致，后续只增加验收脚本。
- backend 与新增迁移 ruff 已通过；不涉及前端代码变更。

## 仍未完成的关卡

冻结候选完整后端回归、优化后 12 次 PG 长测及与冻结基线对比、10 身份 90 周期公平性、同价观察到告警、独立高周期 oracle/消费者对照、真实 API/浏览器并发、审查后候选应用回退接续复核、运行交付台账与最终证据审计。最终性能门槛保留 acceptance-thresholds.md，不因结果放宽。未推送、未生产部署。

## 当前实际环境与命令

Ubuntu quant-server Docker project `mw-issue13-optimized`，独立网络 `mw-issue13-optimized_default`、volume `mw-issue13-optimized_pgdata`、PG14 数据库/用户 `issue13`；PG 本机监听 `127.0.0.1:19633`。当前是数据库验证实例，尚未提供新网页/API 地址。私有 env 为 `/tmp/market-watch-issue13-optimized.env`（0600），不进仓库。

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized.env -p mw-issue13-optimized -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized.compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized.env -p mw-issue13-optimized -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized.compose.yaml stop postgres'
```

性能测量与浏览器、真实告警等重型验收串行，避免同库重置及互相争抢。只停止明确本任务实例；不在 unraid 建开发/验收环境。


## 收口审查修复（当前尚未冻结）

审查复现四个问题：停机后超单页追赶会清空请求并停住；移除证明后稀疏高周期完整性仍保留；聚合加载全队列且焦点新任务使旧任务饥饿；覆盖 verify 全量扫描在发布 tick 内运行。已分别补连续边界追赶、撤销传播/恢复排队、SQL 单候选选择与十秒老化服务、显式维护验证入口。新增针对这些业务不变量的 SQLite / PostgreSQL 验证；首轮 16 项通过，扩大回归 84 passed / 6 warnings（90.16 秒、exit0），含 PostgreSQL 撤销/恢复、超页追赶、聚合旧任务服务及实际 schema 迁移。前端 chart 构建缺少 series-picker 的 .dockerignore 白名单已修正，本任务 chart 镜像实际构建通过。当前未启动网页/API，682818d 冻结候选优化后 12×300 秒长测已启动。覆盖重放首次两个身份区间等价检查均通过，但输出 bind 目录被 Docker 自动创建为 root，保存报告失败；已仅修复明确本任务结果目录归属，保留失败日志后复测通过。旧二进制 131bf3c/v1.14.0 against additive 新表、新候选接续再次通过，独立证据见 results/reviewed-contracts。

维护覆盖命令（最终验证会扫描全部原始证明并持有身份锁，需维护窗口；不受 --limit 页大小约束）：

```bash
python -m alerts.publication_admin coverage --instrument EURUSD --limit 500 --until-complete --verify
```

不带 `--verify` 只执行有界页面，到 verify 返回 `maintenance_required`，不会忙循环。优化基线 warmup 在计时前执行维护验证并确认持久请求、聚合和修订队列已排空。性能数字门槛保持不变。

当前长测已启动，预计约 65 分钟，启动时间与冻结源由 results/optimized-baseline/source.json 和 state.json 记录；当前不作为通过结论。完整 Issue13 收口仍以全部冻结门槛和消费者/浏览器实际结果为准，目标窗口 18:00–20:00 SGT。
