# 目录与维护入口收敛

本次把“查询入口”和“图表维护入口”的实现集中到两个内部 seam，外部兼容 URL 保留为 Adapter。

| 领域 | 唯一核心 | 兼容 Adapter |
| --- | --- | --- |
| 平台、自建、组合系列查询 | `backend/alerts/series_directory.py` | `market_data.search_series_page`、`market_data.search_series` |
| 平台目录底层检索 | `instrument_directory.search` | `platform_catalog`、`instrument_catalog`、自建来源搜索 |
| 图表按需历史维护 | `chart_maintenance_entry.configure` | `POST /api/market-data/maintenance` |
| 自建数据集维护 | `history_commands` | `/datasets/{id}/maintenance` 及控制、任务旧路由 |

查询核心统一分页、游标、类别筛选和平台/自建/组合公平合并；平台行通过一个 provider Adapter 注入，避免核心反向依赖 HTTP 路由。旧列表接口只转换参数和返回形状，不再重复排序或扫描。

图表维护核心在访问供应商最早 M1 前释放数据库连接，供应商不可达时不改变已有计划；路由只把领域错误映射成原有 422/503 响应。

验证：

- `PYTHONPATH=backend pytest -q backend/tests/test_directory_compatibility.py backend/tests/test_platform_catalog.py backend/tests/test_symbol_presentation.py backend/tests/test_history_creation_check.py backend/tests/test_composite_api.py`：39 passed。
- `PYTHONPATH=backend pytest -q backend/tests/test_history_maintenance.py backend/tests/test_managed_dataset.py`：47 passed。
- `ruff check` 与 `git diff --check` 通过。
