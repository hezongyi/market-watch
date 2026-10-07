# 真实跨源 NY17/UTC0 修订与轮询溢出修复

日期：2026-10-07。本阶段定向真实验收，不表示完整 A–E 或长期质量完成。

## 修复与回归

实际派生修订首次写入 `activation_checked_at` 后，PostgreSQL 下一次轮询把毫秒时间戳转为
32 位 INTEGER，抛出 `NumericValueOutOfRange`，历史 worker 因此退出。
过去修订夹具使用不足 32 位的小时间戳，未暴露此问题；真实 NY17→UTC0 验收发现它。

排序改为 JSON 字符串显式转 BIGINT，保留空值优先及候选轮转规则，不修改存储或业务日界。
既有 21 个等待修订轮转合同使用真实量级时间戳，实际 Ubuntu PostgreSQL 修复前
**1 failed /7 deselected /3.06s**，失败来自第二次轮询的整数溢出；修复后完整修订合同
**8 passed /18.43s**。本地修订和分页合同 **11 passed /9.80s**，Ruff/diff 通过。
没有新迁移。只恢复本任务历史 worker，未重启旧观察或生产实例。

## 实际供应商数据验证

`scripts/verify_composite_calendar_switch.py` 在 Ubuntu 独立 API 容器运行，通过认证 HTTP 执行命令，
只读数据库核对不可变 M1 和分块。两组既有真实 Dukascopy→OANDA 组合为 EURUSD、XAUUSD：

- 派生 UTC0 数据集/固定版本；每根原始 M1 与 NY17 父版本逐项相同，分块 checksum/content_id
  相同，派生版本没有供应商历史下载请求。价格、量和来源含义不改变。
- 显式请求并等待九个周期产物发布；不把历史版本发布当作所有周期已经可读。
- 为派生数据集保存准确 OANDA 品种与既有经济匹配依据的新映射；明确创建修订和 UTC0 拼接点，
  重复同请求返回相同修订，准备期间原指针保持不变。完成后原子启用，并幂等核对启用响应。
- 当前 HTTP 搜索展示新数据集、映射和 UTC0；组合身份稳定。
  准备前创建的持久 M1 Watch 保持原修订，明确钉住的原 NY17 H4 图表价格/质量保持相同。
- 使用固定历史段加 OANDA 确认尾部的真实 M1，独立按 UTC 毫秒整数分桶核对 H4/D1 的
  OHLC、观察分钟数及开始/结束边界；没有使用产品聚合函数作为参考答案。
- 最后通过新的显式修订恢复各组合原 NY17 历史/映射/拼接规则，保留两次切换审计；
  只取消脚本自己创建的 Watch。恢复得到新修订，既有策略继续固定旧修订，不强行改回旧指针。

实际时间、逐品种分钟/分块与桶数量、启用/恢复身份和清理结果保存在私有
`artifacts/data-integration/calendar-switch-real-03.log/json`。最终完整脚本通过：
EURUSD **2496** 根 M1、XAUUSD **2360** 根 M1，各共享一个原始分块；
各核对 **13** 个 H4 桶、**3** 个 D1 桶。新 UTC 修订准备分别 **20.181秒 /18.159秒**；
恢复 NY17 分别 **12.134秒 /14.103秒**。这些是已有短历史和缓存条件下的实测，
不代表多年冷历史首次准备速度。结束复查两组合 NY17、脚本 active Watch=0、活跃图表需求=0。
真实样本没有覆盖 DST 转换日期；先前原生 DST 证据不能冒充此次自建/组合历史 DST 验证。
也不以固定绑定未改变宣称旧策略已产生真实通知，或所有依赖质量已就绪。

完整失败分母保留：

1. `calendar-switch-real-01.log`：脚本误把保存映射的审计附加字段作为 `ProductMatch` 创建参数，
   正确返回 422，未启用修订；改为只提交模型字段。
2. `calendar-switch-real-02.log/json`：发现真实 worker 溢出后修复，EURUSD 完成；
   XAUUSD 历史发布时 M1 周期还未完成，脚本过早查询可用修订选项导致 StopIteration。
   原组合恢复、脚本 Watch 取消。改为明确等待所有请求周期发布。
3. `calendar-switch-poll-overflow-red.log`：真实 PostgreSQL 失败复现；
   `calendar-switch-poll-overflow-pg.log/local.log`：修复回归通过。
4. `calendar-switch-real-03.log`：修复后重新完成两品种全过程。

## 环境与剩余事项

Ubuntu 本机 Compose **market-watch-three-layer**，PostgreSQL 14，migration ak38；
UI/API <http://127.0.0.1:16629>，许可图表 origin <http://127.0.0.1:16630>。
启停方式见[搜索分页阶段报告](search-pagination-stage.md#实际环境及启停)。
当前容量约 56GB 可用，无需用户补充业务决策、权限或空间，本次没有资源清理。

仍需多品种/多图与维护并发、来源故障与两分钟断线恢复、完整桌面/兼容审计、
自建历史 DST 样本与稳定版本单独 48 小时工程观察。新观察尚未启动，到期不自动通过。
未推送、PR、改生产或下单；MT4 后续。
