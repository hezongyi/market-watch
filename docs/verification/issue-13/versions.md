# P0 版本与集成边界

核对时间：2026-10-07（Asia/Singapore）；最新远端核对为2026-10-07T01:14UTC，其余原始样本以自身时间为准。以各证据的采样时间为准。

| 对象 | 当前证据 | 含义 |
| --- | --- | --- |
| GitHub main | `9670dae4ffa9d7917dfaf8c4331f1fad9830d56b`，PR#15 Docker管理与PR#16 v1.12.1已合入 | 远端已更新；本轮仍测0591e56，行情发布/聚合/迁移源码无差异；三层未合并 |
| 三层 PR | `gh pr list --state open` = `[]` | 核心修复合并条件尚未成立 |
| 本任务 worktree | `analysis/issue13-performance` / `74ee357`持续同价新鲜度补测（本次收口提交前），基线`0591e56` | 文档/测量脚本和published告警重复读的小修复；未推送、未部署；其他工作树只读 |
| 三层 worktree | `feat/market-data-integration`，本轮只读核对 `92b3475ec518d435c95a071087a2a1846f0859e1`，工作树干净 | 合并后必须重新核对，不能冻结他人的开发工作 |
| 正式生产 worker | 只读 Docker 镜像 revision `0591e56`，digest `sha256:0240c0453792e44efc9327fd92855ce651603be3875cb3a8decb56ff2d2c5ad5` | 交接所记生产 `826d316` 已不是当前运行版本 |
| 本任务 PostgreSQL | 已有本机 `postgres:14-bookworm` 的不可变 image ID `sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872` | 独立 project/network/volume/database，未复用其他数据 |
| 本任务探针 | 已有 Python 应用镜像按 image ID 固定；只读挂载本任务源码优先导入 | 不使用镜像内旧业务源码；运行依赖与挂载源码分别登记 |

生产只读结果见 [production-readonly-version.txt](production-readonly-version.txt)。managed_dataset、market、chart_data、publication_jobs、bar_batch、chart_aggregation_worker 六个文件与本任务本地 SHA256 全部相等。仅查询镜像/容器状态并读文件哈希；没有停止、配置、数据或部署操作。

三层提交与基线的共享文件差异：managed_dataset 的日历解析改为 `calendar_for(inst)`；market、chart_data、publication_jobs 改动日历及来源入口；storage 增加大量三层模型。bar_batch、chart_aggregation、chart_aggregation_worker 在初次核对的已提交内容中仍一致。这证明不能假定三层自动消除旧发布循环，也不能在旧 schema 上提前实现最终持久调度。

00:55UTC维护发布核对：远端新增PR#15（00:46:29UTC）与#16（00:51:34UTC），没有三层行情PR；本任务只fetch与比较，未整合或切换基线。backend/alerts和迁移路径无差异，关键源码SHA见[维护更新核对](results/main-maintenance-update.json)。主线新增的Docker退役规则要求任务结束后查看清单、数据库归档并实际恢复验证；本Issue13仍active，不把任务标记完成或退役其合成库。三层合并后仍须在当时最新主线完整核对身份/日历/schema并复测。

合并后核对清单：

- 刷新 main/迁移 head，复测同一 fixture 与事件序列。
- 确认旧 managed 在图表、告警、采集和任务中的实际入口；新组合与不可变历史分别评测。
- 目标身份包含实际数据集、source、basis、日界、规则与组合版本，禁止跨身份缓存/世代共享。
- 对照日历函数、事务锁顺序、覆盖写入、聚合完成和观察时间触发点。
- 在最新迁移 head 上确定加法迁移与回退，不占用三层已有编号。
