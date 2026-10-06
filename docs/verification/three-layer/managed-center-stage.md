# 第二层维护与桌面数据中心阶段验证

日期：2026-10-06。范围：来源共享 M1 基础后的维护、固定周期产物与桌面管理流程。
本报告证明已列出的行为，不表示完整三层产品或长期质量验收通过。

## 实际运行环境

- Ubuntu 本机 Docker，独立 Compose project `market-watch-three-layer`。
- 独立 PostgreSQL 14 数据库、volume、网络；API、history-worker、web 实际运行。
- 页面：<http://127.0.0.1:16629/market-data>。
- Compose：[`compose.yaml`](compose.yaml)。实际迁移为 `ab29_history_artifacts`。
- API/worker 使用原依赖镜像并只读挂载当前工作树；web 挂载实际构建的 `web/dist`。
  Python 代码变更后需重启对应服务；页面代码变更需重新构建。
- 新项目禁用实时 stream 和通知发送。旧 `market-watch-data-integration` 观察实例未更新或重启。
- 登录、供应商配置及原始验收证据保存在 ignored `artifacts/data-integration`，不入库。

在本工作树执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d api web history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml stop api web history-worker'
```

停止数据库时将 `postgres` 加入 stop 服务列表；不得删除 volume 来代替停止。

## 实现行为

- 日更计划与实时需求分离；任务固定父版本、截止点和复查区间。未变化 M1 分块及周期桶可复用。
- 保留不可变 M1 manifest，各周期产物独立发布并明确父 M1 版本；追加周期不改写父版本。
- 新 M1 发布期间旧 H4/D1 仍可查询，每个周期独立返回可用版本，不在一次查询中隐式混读。
- M1 发布后任务显示派生中，全部固定请求周期发布后才记录维护成功。任务可暂停、恢复和取消，
  保留已发布 M1 和周期；调度可恢复周期发布后、任务完成记录前的中断。
- 数据中心默认自建行情，提供服务器分页、详情、覆盖观测/unknown、创建、任务及维护设置。
- 创建请求与任务幂等，重试不改变截止点；浏览数据中心不建立实时需求。

## 实际供应商与浏览器结果

真实 API/PG/供应商请求，无浏览器 fixture 路由。起始交易日 `2026-10-05`，NY17。
以下 M1 根数是这次固定截止区间的观测，不是长期完整性结论：

| 来源 | 品种 | M1 观测根数 | M1/H4/D1 固定父版本查询 |
| --- | --- | ---: | --- |
| Dukascopy | XAUUSD | 2360 | 通过 |
| OANDA Practice | EURUSD | 2450 | 通过 |
| OANDA Practice | XAUUSD | 2353 | 通过 |

脚本：[`verify_managed_center.py`](../../../scripts/verify_managed_center.py)。
来源确认与未知覆盖分别披露；没有比较两来源价格逐根相等，也没有将空响应判断为闭市。

真实 Chromium 创建 EURUSD 的流程通过：登录、四分区纯读取、资产默认与指数显式日界、
后台下载及 M1/H4/D1 全部发布、维护成功、固定历史图表、暂停/恢复定时维护。
桌面 1024/1440/1920 无横向溢出；200% 内容 CSS zoom 无横向溢出，控制台无 pageerror。
CSS zoom 证据不替代完整浏览器缩放、键盘和对比度审计。

脚本：[`data-center-real.browser.cjs`](../../../web/tests/data-center-real.browser.cjs)。
证据：ignored `managed-real-sources.json`、`data-center-real-browser.json`、`data-center-real.png`。

## 回归与限制

- 维护/周期/数据中心/日界本地定向：32 passed。
- Ubuntu 实际 PostgreSQL 维护/周期：15 passed，含并发任务、并发周期完成和旧周期继续可用。
- 前端 TypeScript/Vite 构建通过；保留已有主 bundle 大小提示。
- 首次新增调度查询暴露多外键 join 歧义；已明确关联运行版本，以上最终结果包含修复。
- 新代码本地全量：805 passed、82 skipped、33 warnings，215.60s；PG 项单独按上方实际结果计。
  ignored `three-layer-local-regression.log` 保存结果；未配置的外部/PG等测试跳过不计为通过。

第二层尚未完整收口：引用保护物理回收、目录选品、固定历史图表分页及版本周期选择、
回测/搜索/MCP 接线和覆盖分类还需完成。组合页与引用页当前是未完成提示。
第一层 Dukascopy 原生 adapter、第三层固定组合与策略/预警接入亦待实现。
短样本供应商及浏览器通过不能替代持续维护、恢复、长区间和质量观察验收。
未推送、未创建 PR、未合并、未生产部署或执行订单。
