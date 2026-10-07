# 组合确认M1、输入修订与持久补数阶段验证

日期：2026-10-07。此记录是C阶段内部链路验证，不表示组合图表、策略或三层整体完成。
Ubuntu独立Compose project `market-watch-three-layer`，工作树 `market-watch-data-integration`，
分支 `feat/market-data-integration`；旧观察与生产环境未改动。

## 实现行为

- canonical来源M1头部保存最新观测时间，包含价格没有改变的新读取；较旧缓存不回滚当前价格。
  价格及量变化生成不可变分钟修订，数值表示规范化避免仅小数格式变化产生新修订。
  来源写锁按采集身份共享，日界变化不拆分原始M1；不同来源/账户/报价口径不共享价格。
- 实际实时确认事务先验证账户owner、连接epoch和租约，再写入canonical分钟及组合输入。
  旧世代写入被拒绝；失败和未完成分钟不进入确认存储。现有单源判断链路继续保留。
- 组合确认输入保存当前分钟指针、不可变事件和按分钟/输入版本索引的不可变引用。
  旧输入版本可还原修订前的价格；仅实际变化递增输入版本。跨接续点前的目标来源分钟不进入组合。
- 固定首次使用截止点的持久补数执行链路已接到历史worker：有界请求、租约/fencing、共享采集缓存、
  检查点、退避重试。供应商I/O不持有数据库事务；锁顺序为来源再准备任务。
  旧租约提交回滚来源及输入写入，恢复关闭旧请求为interrupted，不虚构供应商返回。
- 每次读取保留开始及结果事实、来源请求/缓存/等待区别；失败重试不抹去失败分母。
  对外审计ID经过hash，不暴露worker token；不保存供应商响应体或异常文本。
- `queried`仅代表固定查询分区完成。空成功可以推进查询检查点，但不生成价格、闭市证据或策略就绪。
  实际最新分钟结束时间、查询截止点、输入版本分别保存。当前不激活策略修订。
- 迁移`af33_composite_inputs`新增以上表；存在审计事实时拒绝丢失数据的降级。
  运行写入不能修改/删除不可变分钟、输入事件或完成的请求记录，准备截止点不可原位改变。

## 验证与实际来源

- 最终本地确认M1/补数/实时确认/全链迁移/历史回收定向50项通过。
  覆盖新读取未改价后的旧结果、共享日界、价格修订回看、空响应、租约替换和失败重试。
- Ubuntu实际PostgreSQL定向17项通过：分钟/输入/补数10项、原组合定义5项、实时owner2项。
  并发确认产生唯一分钟头和最新时间水位；迁移/不可变审计及故障恢复通过。
- 实际OANDA Practice EURUSD补数获得1159根来源确认M1，1次真实来源请求。
  固定基线/接续点/截止点保持不变，原历史发布清单逐项相等，实时需求数量前后相等。
  没有注入fixture价格。实际失败恢复由独立PG故障测试证明，不冒充实际供应商故障。
- 验证脚本第一次已完成供应商读取与业务断言，但写报告遇到只读代码挂载权限错误；
  改为容器`/tmp`输出后复制到ignored目录，复用已完成的同一个固定组合，未重复下载。
- 新实例实际数据库迁移到af33，API与history-worker重启加载新代码；stream、居民品种、通知投递仍关闭。
  没有用此前831项第二层回归结果作为本次新增实现的全量证明。
- 改动代码Ruff、diff空白检查通过。

脚本：[`verify_composite_preparation.py`](../../../scripts/verify_composite_preparation.py)。
原始证据在ignored `artifacts/data-integration`：`composite-inputs-final-local.log`、
`composite-inputs-final-postgres.log`、`composite-inputs-migration.log`、
`composite-preparation-real.json`、`composite-preparation-real.log`。

## 环境与启停

实际主机Ubuntu本机Docker，独立PG14 volume/network；访问<http://127.0.0.1:16629/market-data>。
凭据只在ignored环境文件中。工作树根执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml run --rm migrate'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d api history-worker web'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml stop api history-worker web'
```

## 接续范围

共享持久实时需求/零需求退出、拼接后统一聚合与公开图表、映射/组合UI及搜索/MCP尚待接通。
继续完成策略明确接缝政策、完整依赖预热、恢复/修订/防重、原生Dukascopy、统一回测产物输入、
完整桌面可访问性与多品种负载，以及最终部署后的质量观察。完整A–E目标保持未完成。
未推送、未PR、未生产发布或下单；MT4继续延期。
