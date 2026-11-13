# 自建实时基线轮换与每日清理验收

日期：2026-11-13。分类 **F1**：共享后台修订激活、告警绑定与物理数据清理。
代码基线 `62023be6`，首个实现提交 `c4a6d2e6`；后续独立评审修复见本目录对应提交。

## 环境与边界

- 实际运行主机：Ubuntu `quant-server`，本机 Docker；不是 SSH 转发或 Unraid。
- 实现 worktree `/home/quant/repos/market-watch-managed-live-rollover-20261113`，分支 `feat/managed-live-rollover-20261113`。
- Compose project `mw-managed-live-rollover-20261113`，独立网络、PostgreSQL14.24、volume、数据库与 HTTPS18447。
- 手机访问 `https://192.168.7.232:18447/m/data`。凭据、TLS、run.json、许可库及完整浏览器状态均不提交。
- 私有启停入口：

```bash
~/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
~/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

- 旧验收 project `mw-mobile-data-workflow-20261113` /18446 保留，已包含添加时默认全周期提交 `62023be6`。
- 本任务真实验收启用 Dukascopy/OANDA；managed rollover 与总自动激活开启，清理仅 dry_run，外部通知投递关闭。
- 无生产、正式 tag、合并或 Unraid 操作；浏览器证据不代表 Android 真机验收。Web/后端更新无需重新安装 APK。

## 兼容性与回退

没有 DDL/Alembic migration，复用 revision/run/preference 和 preparation JSON。
新增 `managed_rollover:*` 状态、daily retention preference、preparation coverage/trimmed 标记均为增量。
默认 `ALERTS_MANAGED_ROLLOVER_ENABLED=false`，总开关沿用 `ALERTS_SWITCH_AUTO_ACTIVATE_ENABLED`；retention off/dry_run/execute 独立。
旧 weekly switch/retention 记录仍可读取。启用每日轮换的 M1 托管行情从每周候选选择中排除，避免竞争。

关闭开关只停止后续动作，不撤销已激活版本或恢复已删数据。
任务私有 `run.pre-review.json` 和旧镜像保留用于代码/config回退；如要切回旧基线，必须重新确认输入未清理并准备就绪，不能只回写 active_revision_id。
已清理数据的恢复必须使用已核验备份。

## 自动验证

| 范围 | 结果 |
| --- | --- |
| SQLite 轮换/每日清理/修订/固定指标/告警/历史引用/接续 | 122 passed，59.87s |
| PostgreSQL 轮换锁序/固定指标/修订告警 | 51 passed；同次10 skipped因另一个测试模块使用独立env名 |
| 上述10项告警PostgreSQL模块，补私有CHART_ALERT_TEST_DATABASE_URL重跑 | 10 passed，19.46s；20条既有Alembic弃用提示 |
| 早期 history/continuation/shadow/revisions/schedule/activation | 73 passed |
| 早期 retention/switch schedule | 50 passed |
| PostgreSQL retention（早期） | 13 passed |
| migration兼容回归（含alerts MCP） | 42 passed；既有Alembic弃用提示 |
| web生产构建 | TypeScript/Vite/native hooks/mobile shell通过，fingerprint db0e3cdc6c2e0bd3 |
| mobile-data-workflow.browser.cjs | 14组检查通过，55张截图，零运行异常；含全周期默认与轮换暂缓窗口提示 |
| mobile-data.browser.cjs | 4组检查通过，零运行异常；固定读取、搜索、详情、嵌套返回及状态回归 |

命令使用项目 `.venv`，`PYTHONPATH=backend`；PG URL从任务私有test-env注入，测试按UUID schema隔离，绝不使用手机验收DB。
告警模块额外把 `CHART_ALERT_TEST_DATABASE_URL` 设置为同一任务测试DB URL。
前端浏览器脚本在 `web/` 中执行，HTTP fixture结果与下述真实供应商证据分开。
截图在 `/tmp/mw-rollover-workflow-final`、`/tmp/mw-rollover-data-final`；不提交完整浏览器状态。

## 清理执行、备份和恢复

`retention-execute.json` 记录实际任务PostgreSQL14.24备份及独立恢复校验，然后才允许 execute。
私有备份与恢复目录留在本任务预览路径。结果：

1. dry_run不删除；缺少恢复marker时execute拒绝，五条分钟夹具均保留。
2. 真实备份恢复校验：105张表，备份242788bytes，SHA-256见JSON；不是伪造marker。
3. 第一条删除提交后模拟进程中断，恢复同一批累计删除3条，无重复计数。
4. 恰好30天的边界分钟保留；同日不重复清理。
5. 次日没有任何新切换，仍建立新日期批次并删除新到期2条。
6. 最近30天/共享来源/当前修订/任务及真实读取引用由定向PG与SQLite用例分别覆盖。

可复现runner：`scripts/acceptance/managed_retention_execute.py`，使用 `PYTHONPATH=backend:backend/tests`。
必须私有注入 `ALERTS_DATABASE_URL`、`MW_DRILL_DIR`、`MW_EVIDENCE_PATH` 及pg工具设置；严格只允许127.0.0.1:25476/rollover_test。
runner拒绝已存在的验证夹具，不应在已执行且保留证据的public schema重跑；不能为了重跑删除现有备份或其他任务DB。
夹具时钟仅通过函数参数传入，宿主机和DB时钟未更改。

## 独立评审

Standards与Spec独立review均完成。评审后修复：

- Dataset→Composite/Preparation→ChartAlert锁序统一，覆盖编辑/恢复/worker和重复创建。
- Core demand/fixed indicator路径也参与引用fence；删除旧输入/仅旧聚合时标记trimmed，禁止新的固定引用。
- 显著历史退化与原确认尾部丢失阻止激活；最新坏版本不遮住较旧的合格版本。
- 告警以实际绑定修订判定可迁移性，固定价格等不安全规则暂缓轮换，旧流/告警保持。
- 暂缓状态按旧接续点动态计算窗口剩余时间，接近30天显示处理提示。

两位reviewer已确认原阻断及追加遗漏代码层面关闭；PG61项和浏览器回归在修复后完成。

## 真实供应商验收

使用 `web/tests/managed-live-rollover.real.cjs`；只允许本任务18447原点，真实API/供应商与许可widget。
通过原生widget句柄观察图表，未mock API或伪造历史发布。真实EURUSD由数据页搜索Dukascopy、创建、完成历史、明确选择OANDA默认映射并开启实时。

手动与定时更新、旧新revision/seam、确认尾部/当前bar及原图表连续性验证仍在进行；本记录暂不宣称整项收口。
