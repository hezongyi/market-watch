# 旧新浪港股平台日线异常隔离修复

状态：实现及本地/PG 检查通过；独立审查和开发实例验收待完成。基于 PR #135 的 `92fe075b`，原因与规格见[诊断方案](../../research/sina-hk-ohlc-diagnosis-20261112.md)。

分类 F1：已有平台来源增加版本化异常记录策略，复用现有可选审计快照格式，需验证持久兼容。没有数据库迁移、旧 blob 改写或新后台任务。

仅旧新浪港股平台前复权 D1 设置 `record_policy=sina-hk-platform-invalid-ohlcv-audit-v1`。保持 ticker、前复权口径和全部有效 OHLCV；坏记录保留原日期、OHLCV 与原因到 `source_warnings`，并通过共享缓存和图表 API 返回。平台详情使用已有 `quality_note` 说明。未选择新策略的来源及自建/组合采集保持原有严格校验；空快照或全坏快照失败可重试，不保存为成功空历史。

本次用户要求修复，延续“在开发实例上验收”的授权：使用 Ubuntu quant-server 既有 `mw-dev`（https://192.168.7.232:18443），无需再创建隔离 preview。启动前可用磁盘约 13 GiB，可用内存约 7.5 GiB。只构建替换 API/三个原有运行组的共享镜像；Web、PG、TLS、ntfy、私有配置与其他任务保持。PG 自动化使用独立数据库 `mw_sina_hk_quality_20261112`，逐测试 schema，不向应用 dev 数据库写测试数据。完成后保留开发实例运行，不合并、不打 tag、不发布生产、不追踪 CI。

## 已完成检查

- 先写回归并确认失败：真实 2006 年坏记录令最近两根平台读取抛出 `Invalid OHLC extremes`。
- 修复后相关本地回归 192 passed（含 9 个本次用例）。验证全量先校验的真实故障、正常值不变、原始异常值保留、缓存身份隔离、目录说明、API 缓存审计、全坏/空快照失败恢复、默认严格校验和不吞掉缺字段/非数字错误。
- [PostgreSQL 10 passed](postgres-tests.txt)：本补丁 4 项持久/恢复用例，加原生周期已有 6 项兼容/并发用例。数据库为本任务专用库，schema 按测试独立创建、销毁。
- Ruff 与 `git diff --check` 通过。无前端代码变化，不重复构建或运行前端单测。

复现：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_sina_hk_quality.py backend/tests/test_provider_akshare.py \
  backend/tests/test_akshare_native.py backend/tests/test_source_history_store.py \
  backend/tests/test_platform_catalog.py backend/tests/test_provider_directory.py \
  backend/tests/test_market_presentation.py backend/tests/test_provider_cache.py \
  backend/tests/test_market_contracts.py
# TEST_POSTGRES_URL 从私有配置注入，仅连接本任务测试库。
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_sina_hk_quality_postgres.py backend/tests/test_akshare_native_postgres.py
```

## 待收口

独立 Standards/Spec review；备份与固定镜像开发部署；00700/02318/00941/00005 实际 API 和代表图表验收、旧其他来源和原生周期回归、运行组健康检查；PR #135 更新。
