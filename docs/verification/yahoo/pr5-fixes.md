# PR #5 修复验证记录

日期：2026-10-03（Asia/Singapore）。修复前提交 `e28ef2e`，合并基线 `main` 的 `5dd196e`（v1.5.2）。修复位于 `feat/yahoo-native-market-data`。

## 四项问题与验证

| 问题 | 修复后的行为 | 回归证据 |
|---|---|---|
| 部分无效 OHLC 被过滤后仍提交覆盖或永久边界 | 价格 bar 的 OHLC 缺失、NaN 或无穷时整页返回 `invalid_data`；失败不删除已有缓存，也不写新覆盖或边界 | `test_invalid_ohlc_never_commits_lifecycle_or_replaces_cached_prices`：三种坏价格分别验证旧缓存和新数据集 |
| 上游滚动窗口导致前端提前结束缓存分页 | 使用后端 `has_more` 判断本次分页是否结束；窗口提示继续显示；兼容未提供 `has_more` 的既有响应 | `test_cached_minutes_remain_pageable_at_rolling_window`：10 根取 2 根、默认缓冲下 3000 根先取 2100 根，均继续读完剩余缓存；`advanced-series.cjs` 验证公开 datafeed 的 `noData` 回调 |
| `GS` / `MS` 的本地子串命中阻断 Yahoo 新股票搜索 | 拉丁字符模糊匹配继续有限远端搜索，保留本地结果；已知中文名、精确代码及完整名称保持本地查询 | `test_catalog_partial_match_does_not_hide_new_equity`：GS/MS 成功与失败四种场景，验证保留 ^GSPC/MSFT 和搜索状态；原中文本地查询测试继续通过 |
| 首次目录初始化的并发请求主键冲突 | PostgreSQL / SQLite 插入使用 `ON CONFLICT DO NOTHING`，保留稳定身份校验与既有元数据 | `test_concurrent_yahoo_catalog_initialization_is_idempotent`：真实 PostgreSQL 两个初始化事务同时读到目录为空，两个请求都成功；重复初始化不覆盖已验证元数据 |

坏行情、前端分页、搜索及 PostgreSQL 初始化的新增回归均先在修复前代码上观察到失败，再在修复后通过。

修复提交 `2148ddb` 的独立复审又识别了 yfinance 纯公司事件行的兼容边界：`actions=True` 时，SDK 可在分红/拆股/资本收益日期添加全部 OHLC 缺失且成交量为零的事件记录。此类行不生成价格 bar，也不用于证明上一根价格已完成。适配器仅在全部价格确实缺失、成交量零或缺失、且存在非零且数值有限的公司事件时忽略该行；部分坏价格、无事件的空价格行、带成交量的空价格行和无穷价格继续返回 `invalid_data`。

`test_sdk_event_without_prices_does_not_reject_or_complete_price_history` 用固定 SDK 的真实 `safe_merge_dfs` / `auto_adjust` 构造三类事件输入，先复现误拒绝，再验证保留价格和形成中状态；`test_invalid_price_rows_cannot_masquerade_as_corporate_actions` 验证四种坏价格不会被事件例外放行。

## 本轮检查结果

- 最终后端与独立 PostgreSQL 合并回归：**244 passed**（47.34 秒），其中相关后端 **228 项**、真实 PostgreSQL **16 项**。涵盖 Yahoo、provider cache/service/chart/transport、源资源、行情目录、来源选择、工作区、CSV、配置和成交量。
- PostgreSQL 每项测试使用临时独立 schema 并清理，包含迁移升级/回退、租约、并发和新增目录初始化竞争。
- 前端四项合约全部通过：`advanced-series.cjs`、`advanced-native-workspaces.cjs`、`advanced-provider-subscriptions.cjs`、`advanced-provider-request-lifetime.cjs`。
- `npm run build`、ruff、`git diff --check`、`pip check` 通过。

后端命令：

```bash
PYTHONPATH=backend .venv/bin/python -m pytest -q --tb=short \
  backend/tests/test_provider_yahoo.py backend/tests/test_provider_cache.py \
  backend/tests/test_provider_service.py backend/tests/test_provider_chart.py \
  backend/tests/test_provider_transport.py backend/tests/test_market_resources.py \
  backend/tests/test_market_data.py backend/tests/test_source_selection.py \
  backend/tests/test_advanced_workspace.py backend/tests/test_advanced_preferences.py \
  backend/tests/test_provider_workspace.py backend/tests/test_chart_export.py \
  backend/tests/test_config.py backend/tests/test_volume.py

PYTHONPATH=backend \
TEST_POSTGRES_URL='postgresql+psycopg://postgres@/market_watch_yahoo_acceptance?host=/tmp/market-watch-yahoo-pg' \
  .venv/bin/python -m pytest -q --tb=short backend/tests/test_provider_postgres.py
```

## 验证范围

本轮验证四项修复的实际代码路径和既有功能回归。真实 Yahoo 网络及完整浏览器验收未重跑；相邻 `checks.json`、网络及浏览器记录对应原始提交 `e28ef2e`，不能作为修复后 bridge 源码的新验收。本轮前端分页证据来自加载实际 `bridge.js` 的 datafeed 合约测试。

Yahoo 源仍默认关闭，生产迁移与部署另行执行。此次验证未修改生产数据库或切换服务。
