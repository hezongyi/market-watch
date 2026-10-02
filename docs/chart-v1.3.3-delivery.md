# v1.3.3 Volume 本机交付

2026-10-02。开发 worktree 为 `/home/quant/repos/market-watch-volume`，分支
`fix/volume-v1.3.3`，基线为 v1.3.2（`9596b25eda507ef708a327feb5271f238cdfdc0b`）。
运行镜像统一构建自 `edc799a97999b8cf387a03c380669bf6a8d28083`，包版本1.3.3。
后续证据/文档提交不改变镜像源码。本机验收阶段未合并 main、推送远端或操作生产；
后续获授权的源码发布见[源码交付记录](chart-v1.3.3-source-delivery.md)。

当前交付状态：按用户最新范围，停止性能问题排查与优化，性能不再作为本轮交付
阻断；失败数据保留，不能描述为完整页面性能通过。Volume功能、数据正确性及
主实例备份/迁移/补量与浏览器验收构成此次accepted范围。另一个工作区
并发部署两次把chart-origin换回旧版，已改用固定v1.3.3发布清单恢复，再执行
本机四组M5数值/柱形/保存重开终验并连续核对运行image/source。
见[本机原生终验](verification/volume/native-local.json)、
[运行状态](verification/volume/local-final-state.json)与
[并发覆盖证据](verification/volume/local-concurrent-overwrite.json)。

## 最终行为

Binance Spot 量为基础资产成交数量（BTC），OANDA 为报价数量，不是市场真实成交量。
解析、自建M1、九周期聚合、已发布快照、平台缓存、实时SSE、原生主行情桥接和CSV
都携带量。零是已知0；缺量保留null，原生数据窗口显示∅。数据库使用Numeric(38,18)，
超出20位整数/18位小数、负数和非有限值拒绝；OANDA输入必须为整数。JSON/CSV保留
十进制，JavaScript Number用于绘图，SQLite不承担无损持久化结论。

价格与量修订独立。仅量补采不改OHLC、价格complete/received_at/revision、coverage、
历史预警及已有演练。普通旧格式同价格重放保留确认量；真实价格更正缺量时将旧量
失效。仅量维护跳过历史预警重算，实时tick报价仍独立采样，可由新报价真实触发预警。
Python合成指标内部volume=0/1有效性协议保留。量任务不创建新的价格维护授权。

`p17_volume`接在o16后；平台独立payload版本`volume-v1`保留旧缓存供正常清理/回退。
所有API/worker使用同一版本；升级时先停旧写入者。原生Volume手工添加、颜色及
保存重开已验收。成交量蜡烛、VWAP、成交量分布和24h统计不在本次能力声明中。

## 验证与限制

完整索引及失败记录见[证据说明](verification/volume/README.md)，独立两轴审阅见
[code-review.md](verification/volume/code-review.md)。
最终逐项收口核对见[completion-audit.md](verification/volume/completion-audit.md)，
当前运行镜像/schema/备份复核及真实任务页分页读取均已补充留证。

| 验证 | 结果 |
| --- | --- |
| 最终后端全量 |340 passed、1 skipped；隔离PG17精度/并发回归，备份工具条件skip仍保留 |
| 前端非浏览器脚本 |39 passed；TypeScript/Vite构建通过 |
| 原生两来源×两系列×九周期 |36组实际API供数、指定颜色柱形像素通过 |
| 上游/自建/API/CSV/原生数值 |6个逐成员上游对齐样本；最终候选4组M5数值/柱形/保存重开通过 |
| 正量、零、未知 |真实正量；独立受控fixture实测0和∅，不声称fixture是上游真实零 |
| 实时SSE |两来源真实HTTP bars事件含量，心跳不计通过 |
| 本机终验 |四组M5平台/自建真实柱形、公开数据窗口数值、保存重开及原50/50复现通过 |
| 发布活性终验 |新镜像正常发布将停滞的EUR_CHF历史队列5960→4，未直接删除队列；旧快照修订不移动覆盖边界 |
| 价格/coverage/预警/演练隔离 |真实历史补采前后固定快照不变；专门回归覆盖并发演练、无变化和取消fencing |
| 冷/热请求 |最终6次cache_hit=false冷读611–1874ms；九周期新原生文档cache_hit=true请求到显示258–464ms |
| 八图+补量 |120秒、10观察；实际pending/running任务与维护重叠，水位持续推进，末次全部<120秒 |
| 迁移与回退 |PG16新建n15→o16→p17，恢复实际o16备份→p17；恢复p17→fence→旧v1.3.2启动读写/健康→新镜像续做通过 |
| 手机 |真实原生只读，无写请求及页面错误；原有视区恢复warning保留 |

八图观察期间有约141秒的短暂水位延迟及上游错误，随后恢复；不承诺所有观察低于
120秒，也不保证每次冷读低于3秒。此前最新尾部切换耗时、resetData等待超时及
验收响应观察器竞态的失败全部保留，不作为成功样本。计时止于公开dataReady+
两帧，不宣称GPU绘制完成。平台最新尾部过期时会重新取上游，不能当完整热缓存命中。

补充完整页面冷启动的失败见native-first-screen-initial.json、
native-first-screen-concurrent.json及native-first-screen.json。首次串行均衡12样本
只有3个<3秒，不满足原完整页面门槛；此前有1073ms热读及代理TLS重连/重试长尾。
另一个浏览器基准和自身本机验收曾在部分时间重叠，资源竞争是观察到的因素，
不是证明所有失败的单一原因。两次冷缓存fixture身份错误的无效尝试单独留证，
不参与有效样本。用户随后明确“性能问题不需要你解决”，故停止性能排查与优化，
不再作为本轮accepted的条件；未重跑或改写失败数据。

36组矩阵在最后预警门控及发布活性修复前执行，图表/parser/聚合文件未变，
发布器新增旧快照修订及无覆盖处理。最终同提交镜像复验与340项后端测试覆盖
交付源码；不将早期矩阵宣称为后续镜像上重复执行。候选BTC九月月量469465.12983000、
OANDA CAD_CHF366489由真实M1成员逐项求和，扩大到九月的BTC候选历史没有迁入
主实例。`real-backfill.json`是更早快照，后续统计以`final-candidate-state.json`为准。

## 本机操作与补量范围

主实例为`market-watch-dual-acceptance`，入口`https://localhost:15453`，原生来源
`https://127.0.0.1:15454`，PG16库`market_watch_dual`。现场原schema为o16，
并非摘要中的n15；实际升级记录为[local-upgrade.json](verification/volume/local-upgrade.json)。
备份为`/tmp/mw-dual-acceptance/before-volume-upgrade.dump`，权限0600，大小与SHA256
保存在升级记录；秘密配置、dump和licensed chart包不提交。迁移后实际schema为p17。

自动启动清单仅XAUUSD、BTCUSDT、EURUSD、OANDA:CAD_CHF；各项固定半开范围
见升级记录。只选未cancelled且realtime_enabled=true计划，target_start没有前移。
取消计划不恢复，关闭实时维护的品种不自动创建任务。主实例保留自己的数据，
没有用候选整库替换。后台任务每页最多600自然分钟、倒序优先最近数据；来源
退避、前台/实时优先、聚合背压、租约/generation与取消提交fencing均持久化。

量任务可能partial：旧价格与上游不符、上游无量/不可达、派生价格不完整或发布
无法确认都保留未知及未解决片段。无计划且无可更新快照的一次性任务不能宣称
完成发布，会partial且不偷偷创建维护计划。价格差异须显式修复价格后重试量。
任务页提供独立查询、取消、恢复、重试及分页片段；关闭页面不取消任务。

最终Volume功能验收以native-release-candidate.json（两来源×两系列M5数值与柱形）、
native-release-monthly.json（两来源自建月线真实量与柱形）、native-local.json
（主实例四组M5数值与柱形/保存重开）及local-final-state.json为准，均通过。
发布活性修复是数据正确性收口：允许已确认旧快照修订量、形成中双完整标志保持
false、没有快照且不在可发布范围则持久partial；无当前覆盖时也只能修订已有
完整快照。实际未解决片段和固定任务状态以发布清单final_volume_jobs为准。

确认并发部署停止后，使用固定发布env而不是会被其他任务改写的临时选择：

```bash
sg docker -c 'docker compose --env-file deploy/releases/v1.3.3-local.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml -f deploy/releases/v1.3.3-local.yaml up -d'
sg docker -c 'docker compose --env-file deploy/releases/v1.3.3-local.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml -f deploy/releases/v1.3.3-local.yaml restart web tls'
```

重建API/web/chart-origin后重启web/tls以刷新nginx DNS。实际逐服务image ID、source
标签、health、任务和发布状态必须重新读取，不能仅查看tag或Compose文本。

## 回退与恢复

先停止API及三个worker。使用新API镜像及同一受限api.env执行
`python scripts/volume_backfill.py rollback-fence`预览，核对后加`--apply`：
递增generation、撤销租约，将待执行volume聚合归档为retry片段并移出旧worker
可选队列；仅保留kind列不能保证旧worker不执行量任务。备份和fence后才切回
升级记录中的旧镜像及匹配web/chart-origin，并重启web/tls。

实际旧v1.3.2在p17上的价格读写及health/ready已通过，可保留新增字段/任务表。
旧程序自身不会维护新量字段，其历史重放仍有旧语义，不承诺旧版继续提供Volume。
若目标状态与验证条件不符，停止写入者、将升级前dump恢复到独立库验证后再切换，
不要直接覆盖活库或drop量列。旧平台缓存保留，旧payload版本可继续读取。

恢复新版本时先保持所有服务同一source/schema，再在任务页明确resume/retry
已fence任务；新worker复查租约、批准范围及归档片段，不能仅重新启动进程便
认为已续做。实际新镜像在独立回退恢复库续做的证据见rollback-resume.json。
