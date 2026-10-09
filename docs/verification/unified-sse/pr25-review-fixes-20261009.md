# PR #25 修复与最终复审

业务提交：`0ba1d2856950b26b93d94836ac290ba84e11d6a8`。基准 main：
`946b75333522af3f6a4d845e3ad0804916256790`，已通过 `df9655d` 合入候选分支。
后续审计文档不冒称已存在于业务镜像内。PR 尚未合并，未发布生产。

## 已复现并修复的问题

- 历史窗口的最后一根柱被实时尾柱排除规则漏掉。组合历史检测包含整个最后 bucket；
  provider 以原始 start 包含末柱，保留 NY17 原生时间标签。普通实时更新与追加继续交付 bars。
- managed 历史末柱采用独立尾柱修订凭据，保留既有前缀凭据；原生默认
  `track_history=False` 首读也返回该凭据。HTTP 接受后、首次 delivery 前修订末柱时，
  发布/未发布路径均要求恢复历史。旧 `df9655d` 的这两例独立复现均错误返回 status。
- provider/managed 历史指标的递归输入可以位于可视窗口之前。检测包含实际计算前缀；
  provider 显式固定起点之前的修订不会误触发 reset。
- expired binding 注册与 cleanup、跨页面换绑与多 task 续租均有真实 PostgreSQL 死锁。
  生命周期写入统一按 Client、排序 Tasks、Subscriptions 顺序持锁，续租先锁 task 再更新。
- `ON CONFLICT DO NOTHING` 不保护已有的 expired Client/孤立 Task；两者在后续取锁前
  被清理会导致注册失败。注册现在先取得现有行锁，并在缺失时按相同顺序确保创建与取锁。
- cleanup 分批锁定候选、跳过忙碌行，仅删除已取得对应 client/task 锁的过期订阅，
  删除前重新检查有效期及全部引用。`EXISTS` 避免 NULL 取消墓碑阻止孤立 task 回收。

正式回归覆盖历史窗、实时尾部、M5 bucket 最后一分钟、provider NY17 D1、published/staging、
EMA 递归前缀、两处死锁、Client/Task 删除竞态、共享任务与忙碌资源，以及 NULL 取消墓碑。
Node 检查 HTTP 凭据接受、SSE 更新、原连接重连及连接替换后的凭据保留。

## 验证证据与版本边界

| 实际版本 | 验证 | 结果 | 证据 |
| --- | --- | --- | --- |
| `df9655d` | 合并 main 后本地回归，含主线 OANDA 观察与诊断 | 232 passed | [本地](pr25-merged-local-df9655d.txt) |
| `df9655d` | 真实 PG stream、历史、生命周期、成本、主线发布锁序及 live | 101 passed | [PG](pr25-merged-postgres-df9655d.txt) |
| `0ba1d285` | 首读修复后历史、stream/API、managed/历史计划/指标回归 | 106 passed | [本地](pr25-native-local-0ba1d285.txt) |
| `0ba1d285` | 真实 PG 历史 HTTP/Calculator/持久事件合约 | 16 passed | [历史 PG](pr25-history-postgres-0ba1d285.txt) |
| `0ba1d285` | 最终 API 镜像内 PG 合约、生命周期、固定指标、主线锁序/live | 109 passed，无 skip | [镜像 PG](pr25-image-postgres-0ba1d285.txt) |

Ruff、Python 编译、bridge 语法和三组 Node 检查通过；web 构建通过；迁移单 head
为 `ar45_market_stream`。首读修复没有新增完整前缀扫描：非 track 请求只计算末 bucket 凭据。
staging 首读原有的全历史统计仍存在。

第一次镜像 live PG 检查依赖默认常驻品种，而 Practice 配置显式关闭常驻品种，
产生 `EUR_USD` fixture KeyError。最终 gate 单独设置
`ALERTS_OANDA_RESIDENT_SYMBOLS=EUR_USD,XAU_USD` 后 109 项全绿；没有改变运行应用的需求配置。
一次使用 stdin 启动 pytest 的编排不兼容 multiprocessing spawn，已停止自己的该进程、
改用正常可 spawn 入口重跑。唯一遗留空随机 schema 经确认无对象/连接后精确删除；
最终随机测试 schema 残留为 0。这些编排失败没有作为通过结果。

三位独立 agent 的 Standards、Spec、Integration 结论均绑定 clean `0ba1d285`，
未发现剩余合并阻碍。GitHub 没有配置该 PR 的状态检查，自动可合并状态不是运行验收的替代证据。

## Ubuntu 交付与成本

只使用 Ubuntu 本机 Docker 的 `mw-unified-sse-20261008` 独立 project、网络、PG volume 和端口。
API/web/chart 经 `mw-docker build`、专用 `market-watch-ubuntu` builder 构建；13 个运行应用容器
均核对业务 commit `0ba1d285`、task/project/purpose 和 `dirty=false`。
网页 http://127.0.0.1:15643，API http://127.0.0.1:15641，chart http://127.0.0.1:15644。
启动、停止沿用 [README](README.md)，私有 `compose.env` 指向 `unified-sse-pr25-fixed` 三类镜像。
实例继续供用户验收，任务未结束、未执行 retire；unraid 未访问或修改。

真实 Practice 的最终浏览器结果、来源提交、原始报告哈希见
[最终运行摘要](pr25-final-runtime-summary.json)。不伪造 supplier 价格；账号配置由测试 finally 恢复，
浏览器取消后仍验证独立预警，最后释放测试自己的需求。

成本仍引用原方案 `6fd9273` 对 `32bc00b` 的独立 60 秒窗口：单周期约增加
0.110 CPU 核/101.8 MiB，八周期约增加 0.264 CPU 核/128.5 MiB，WAL 为旧版 1.22×/2.37×。
这不是 `0ba1d285` 的重新测量，也不是生产容量或长期稳定性承诺；最终修复的净开销尚未重新测量。
原始方法和限制见 [成本报告](old-release-cost-report.md)，成本实例已按备份、实际恢复及精确退役流程结束。
