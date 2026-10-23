# 验证记录

2026-10-23，Ubuntu 本机独立工作树。

## 已完成

- Ubuntu Docker 定向回归：71 passed in 148.28s。
  文件为 `test_history_indicators_mcp.py`、`test_history_mcp.py`、`test_composite_mcp.py`、
  `test_series_access.py`、`test_fixed_indicators.py` 和 `test_native_mcp.py`。
  使用 task-owned 临时容器，`--network none`、768 MiB、1 CPU、独立 SQLite 临时数据库。
- 此轮覆盖 history schema/权限、冷启动/部分完成/完整前缀、网页等价、UTC 分页、MWH 规范化、
  无效参数原子拒绝、缺失/未发布/回收/缺失周期不回退，以及新发布不替换指定版本。
- 合入组合依赖后，最终定向回归：30 passed in 74.14s。覆盖
  `test_history_indicators_mcp.py`、`test_composite_mcp.py`、`test_series_access.py`。
  新增的完成但全 null 预热断言通过；R1 脚本通过真实 SDK/TestClient 协议走完
  cold → partial → ready，并校验版本/价格/指标/依据和证据中无 token。
- 修改/新增的五个后端 Python 文件及 R1 验证脚本 Ruff 全部通过。

## 尚未完成

- PR CI（本地自审已完成）。
- Ubuntu R1：09:42 UTC 启动前盘点显示可用内存 4384 MiB、磁盘 27 GiB、端口 18633 空闲，
  但五分钟负载 11.77，超过仓库启动上限 4；未启动本任务 R1，不创建 PG volume 或常驻服务。
- 首次构建镜像早于最终 runtime 修改；它只作带源码挂载的测试运行时，不能作为最终 R1 候选。
- 09:49 UTC 复查：可用内存 5089 MiB，五分钟负载仍为 10.13；继续保留 R1 未启动状态。

R1 资源需求和运行命令见 README.md。待资源满足后，需重新构建候选并实际执行协议验证。
