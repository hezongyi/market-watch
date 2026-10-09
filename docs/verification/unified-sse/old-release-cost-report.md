# 旧方案成本基线及订阅租约优化（2026-10-09）

基线为原方案实现 `6fd9273a5f78d8761f76a20e3ad66b17e441f9f5`，
优化版为 `32bc00bffb547015e6a3c5b04c3a3efa0803da81`。
两侧均实际运行自己的 API/web/许可 chart 镜像，并核对 mw-docker 的
task/project/purpose/commit/dirty 标签；优化版包含新增统一 worker，旧版没有该进程。
这次是相对原方案起点的部署成本比较，不是相对后来 OANDA 生产补丁或当前 main 的增量。

## 同口径方法与结果

Ubuntu 本机 Docker，4 vCPU、约 16 GiB RAM。两套独立 project/network/volume/PG/端口，
未使用生产数据库或 unraid 实例。构建和启动全部完成后顺序执行旧单周期、新单周期、
新八周期、旧八周期，每轮先预热/排空旧浏览器租约 125 秒，再采样 60 秒、每 5 秒读一次资源。
其他既有任务保持运行。每侧每场景只测一个窗口，没有统计置信区间。

两侧使用兼容旧模型的同一 fixture，固定 seed 时间 `1791548400000`、相同历史 OHLC、
起始尾价 `107.00`。单周期为 M1，每 5 秒更新一次，共 10 次；八周期为
M1/M5/M15/M30/H1/H4/W1/MN，每 12 秒一批，共 4 批、32 次周期输入。
输入直接写本任务的真实 PG，HTTP/SSE、worker 和原生图表回调均为真实路径。
原生回调先调用图表库，再记录成功返回；没有模拟网络响应或供应商价格。

| 场景 | 旧版平均 CPU 核 | 优化版平均 CPU 核 | 增量 | 旧版工作集 MiB | 优化版工作集 MiB | 增量 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 单周期 | 0.386 | 0.496 | +0.110 | 887.9 | 989.8 | +101.8 |
| 八周期 | 0.285 | 0.549 | +0.264 | 882.0 | 1010.5 | +128.5 |

CPU 增量分别相当于本机 4 vCPU 总容量的约 2.8、6.6 个百分点。
这里的工作集为所有本项目容器平均工作集之和，不包含宿主 Chromium/fixture；
受缓存、allocator 和执行顺序影响，不能据单次窗口断言固定内存上限或周期越多一定线性增长。
旧八周期 CPU 低于旧单周期说明短窗口存在其他 worker/缓存/调度波动。

| 场景 | WAL MiB/60秒（旧→新） | 比率 | 事务提交（旧→新） | 插入/更新/删除元组（旧→新） | PG TX MiB（旧→新） | web TX KiB（旧→新） |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| 单周期 | 0.721→0.879 | 1.22× | 2641→5561 | 535/1091/337→623/1478/455 | 2.47→11.77 | 74.9→77.5 |
| 八周期 | 0.911→2.162 | 2.37× | 2863→10820 | 700/1805/672→906/3212/850 | 3.99→30.52 | 295.6→96.0 |

上述包含 fixture 和其他本项目 worker 的活动；提交次数不是 SQL 条数，返回元组不是扫描 SQL 数。
PG TX 是内部数据库发送量，不能当外网流量；web TX 含所有页面请求及协议开销。
WAL 为窗口生成字节，不代表留存磁盘占用，不直接外推每日磁盘增长。
完整未四舍五入数据、每服务资源、数据库计数、队列、原始文件路径及 SHA-256 见
[old-release-cost-summary.json](old-release-cost-summary.json)。

| 场景 | 旧行情 HTTP 请求 | 新行情 HTTP 请求 | 被输入逐值匹配的回调（旧→新） | 已观测回调 P95 毫秒（旧→新） |
| --- | --- | --- | ---: | ---: |
| 单周期 | 4 charts/data + 4 quotes | 0 | 4→10 | 12421→2254 |
| 八周期 | 32 charts/data + 4 quotes | 0 | 32→32 | 11189→1813 |

旧轮询允许合并中间价格，只对实际交付值计延迟；两侧均检查每周期的最终价格。
SSE 检查每个输入均有真实原生回调。小样本 P95 不是供应商 SLA，
旧版未交付的中间值也不应被算作零延迟。

## 租约优化及回归

旧统一 SSE 的半秒 delivery 循环每次都调用 client upsert/写锁并重写页面、订阅及任务租约。
优化后 delivery 只读已经注册、未过期且会话有效的 client；续租检查剩余有效期，
仅在页面或任意活跃订阅需要续租时串行写入，订阅/任务使用有条件的批量更新。
空闲六轮 delivery/renew 不产生 INSERT/UPDATE/DELETE，SQLite 与真实 PG 均直接计数验证。
真实 60 秒成本窗口内 client 都仅更新 1 次；订阅分别更新 3、9 次。
对应任务更新仍为 422、1837 次，包含计算领取/完成与归属刷新，
这也解释为什么消除半秒租约重写后 DB 成本仍存在。

同时补充“连续新增 listener 会延长页面、不能饿死旧 listener 续租”的红绿回归。
若只看页面有效期，旧 listener 会先过期；最终实现分别检查两个到期时钟，
并在少量续租写阶段保留与注册/取消相同的 client 锁顺序。
测试保留认证、会话结束、世代取消、任务归属 fencing、有限回放与跨进程共享检查。

本地 140 项、Node 三组桥接检查通过；宿主连接独立成本 PG 的 53 项检查通过。
最终镜像 PG gates 与真实 Practice 复验结果记录在 [completion-audit.md](completion-audit.md)。
优化针对重复租约写入，shared worker 仍会进行持久结果、计算归属和变化检查；
因此事务、内部 DB 网络和 WAL 仍显著高于旧轮询。未声称 SQL 成本被完全消除。

历史 [resource-cost-report.md](resource-cost-report.md) 的 6.6× WAL 是新版本内 fallback 对照，
其服务数量、fixture、运行版本不同。不能直接将 6.6×→2.37×解释为本次优化降幅。
本次也没有测得相同固定 workload 下“优化前统一 SSE→优化后统一 SSE”的整项目比例。

## 复跑与环境

Compose 为 `compose.unified-sse.cost.yaml`，私有配置由
`scripts/prepare_unified_sse_cost_instance.py` 创建，不提交凭据。

| 测量时 project/task（现已退役） | API | web | chart | PostgreSQL |
| --- | --- | --- | --- | --- |
| mw-unified-sse-baseline-20261009 | 127.0.0.1:17641 | 127.0.0.1:17643 | 127.0.0.1:17644 | 127.0.0.1:17645 |
| mw-unified-sse-lease-optimization | 127.0.0.1:17741 | 127.0.0.1:17743 | 127.0.0.1:17744 | 127.0.0.1:17745 |

```bash
# 旧版起停；所有镜像先通过 mw-docker/task/project/acceptance 构建。
docker compose --env-file artifacts/unified-sse/cost-baseline/compose.env \
  -p mw-unified-sse-baseline-20261009 -f compose.unified-sse.cost.yaml up -d --no-build
docker compose --env-file artifacts/unified-sse/cost-baseline/compose.env \
  -p mw-unified-sse-baseline-20261009 -f compose.unified-sse.cost.yaml stop
# 优化版起停：env 换 cost-optimized，project 换 mw-unified-sse-lease-optimization，
# up 加 --profile unified（在 up 前）；stop 同样指定该精确 project。
sg docker -c 'env LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu \
  MW_COST_SEED_AT=1791548400000 node web/tests/unified-sse-cost.browser.cjs --baseline'
# 去掉 --baseline 测优化版；加 --matrix 测八周期。
```

以上命令记录测量时的配置，现已退役，不能直接重启已结束task。
运行脚本必须使用与 runtime commit 相同的 worktree HEAD。两边独立数据卷，
不能复用生产目录。基线旧镜像始终固定为 6fd9273；新镜像绑定脚本当前 HEAD。
首个构建重叠的探索窗口、起始尾价尚未重置的窗口均排除在正式摘要之外。
两套成本任务已按 mw-docker retire 预览、备份与实际恢复校验、精确清理；
各自容器、network、PG volume及无引用任务镜像已删除，不能再访问上述成本端口。
复跑需新task/project和相应保护配置，不能复用已结束task。
归档/恢复核验摘要见 [cost-retirement-summary.json](cost-retirement-summary.json)；
原始配置、角色及dump保存在私有归档，不提交仓库。
用户技术验收入口仍为独立 Practice project `mw-unified-sse-20261008`，不随成本实例退役。

物理镜像共享层、构建缓存、稀疏内存峰值及长期容量仍未量化；
没有新增服务器采购/订阅收费。上述资源量不能直接换算成生产月费用。
